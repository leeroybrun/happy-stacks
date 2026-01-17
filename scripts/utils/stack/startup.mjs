import { runCapture } from '../proc/proc.mjs';
import { ensureDepsInstalled, pmExecBin } from '../proc/pm.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function looksLikeMissingTableError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('does not exist') || s.includes('no such table');
}

async function probeAccountCount({ serverDir, env }) {
  const probe = `
	let db;
	try {
	  const { PrismaClient } = await import('@prisma/client');
	  db = new PrismaClient();
	  const accountCount = await db.account.count();
	  console.log(JSON.stringify({ accountCount }));
	} catch (e) {
	  console.log(
	    JSON.stringify({
	      error: {
	        name: e?.name,
	        message: e?.message,
	        code: e?.code,
	      },
	    })
	  );
	} finally {
	  try {
	    await db?.$disconnect();
	  } catch {
	    // ignore
	  }
	}
	`.trim();

  const out = await runCapture(process.execPath, ['--input-type=module', '-e', probe], { cwd: serverDir, env, timeoutMs: 15_000 });
  const parsed = out.trim() ? JSON.parse(out.trim()) : {};
  if (parsed?.error) {
    const e = new Error(parsed.error.message || 'unknown prisma probe error');
    if (typeof parsed.error.name === 'string' && parsed.error.name) e.name = parsed.error.name;
    if (typeof parsed.error.code === 'string' && parsed.error.code) e.code = parsed.error.code;
    throw e;
  }
  return Number(parsed.accountCount ?? 0);
}

export function resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive }) {
  // Sandboxes should be isolated by default.
  // Auto auth seeding can copy credentials/account rows from another stack (global state),
  // which breaks isolation and can confuse guided auth flows (setup-pr/review-pr).
  if (isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    return false;
  }
  const raw = (env.HAPPY_STACKS_AUTO_AUTH_SEED ?? env.HAPPY_LOCAL_AUTO_AUTH_SEED ?? '').toString().trim();
  if (raw) return raw !== '0';

  // Legacy toggle (kept for existing setups):
  // - if set, it only controls enable/disable; source stack remains configurable via HAPPY_STACKS_AUTH_SEED_FROM.
  const legacy = (env.HAPPY_STACKS_AUTO_COPY_FROM_MAIN ?? env.HAPPY_LOCAL_AUTO_COPY_FROM_MAIN ?? '').toString().trim();
  if (legacy) return legacy !== '0';

  if (stackName === 'main') return false;

  // Default:
  // - always auto-seed in non-interactive contexts (agents/services)
  // - in interactive shells, auto-seed only when the user explicitly configured a non-main seed stack
  //   (this avoids silently spreading main identity for users who haven't opted in yet).
  if (!isInteractive) return true;
  const seed = (env.HAPPY_STACKS_AUTH_SEED_FROM ?? env.HAPPY_LOCAL_AUTH_SEED_FROM ?? '').toString().trim();
  return Boolean(seed && seed !== 'main');
}

export function resolveAuthSeedFromEnv(env) {
  // Back-compat for an earlier experimental var name:
  // - if set to a non-bool-ish stack name, treat it as the seed source
  // - if set to "1"/"true", ignore (source comes from HAPPY_STACKS_AUTH_SEED_FROM)
  const legacyAutoFrom = (env.HAPPY_STACKS_AUTO_AUTH_SEED_FROM ?? env.HAPPY_LOCAL_AUTO_AUTH_SEED_FROM ?? '').toString().trim();
  if (legacyAutoFrom && legacyAutoFrom !== '0' && legacyAutoFrom !== '1' && legacyAutoFrom.toLowerCase() !== 'true') {
    return legacyAutoFrom;
  }
  // Legacy toggle: "on" implies main (historical behavior).
  const legacy = (env.HAPPY_STACKS_AUTO_COPY_FROM_MAIN ?? env.HAPPY_LOCAL_AUTO_COPY_FROM_MAIN ?? '').toString().trim();
  if (legacy && legacy !== '0') return 'main';
  // Otherwise, use the general default seed stack.
  const seed = (env.HAPPY_STACKS_AUTH_SEED_FROM ?? env.HAPPY_LOCAL_AUTH_SEED_FROM ?? '').toString().trim();
  return seed || 'main';
}

export async function ensureServerLightSchemaReady({ serverDir, env }) {
  await ensureDepsInstalled(serverDir, 'happy-server-light');

  try {
    const accountCount = await probeAccountCount({ serverDir, env });
    return { ok: true, pushed: false, accountCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!looksLikeMissingTableError(msg)) {
      throw e;
    }
    await pmExecBin({ dir: serverDir, bin: 'prisma', args: ['db', 'push'], env });
    const accountCount = await probeAccountCount({ serverDir, env });
    return { ok: true, pushed: true, accountCount };
  }
}

export async function ensureHappyServerSchemaReady({ serverDir, env }) {
  await ensureDepsInstalled(serverDir, 'happy-server');

  try {
    const accountCount = await probeAccountCount({ serverDir, env });
    return { ok: true, migrated: false, accountCount };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (!looksLikeMissingTableError(msg)) {
      throw e;
    }
    // If tables are missing, try migrations (safe for postgres). Then re-probe.
    await pmExecBin({ dir: serverDir, bin: 'prisma', args: ['migrate', 'deploy'], env });
    const accountCount = await probeAccountCount({ serverDir, env });
    return { ok: true, migrated: true, accountCount };
  }
}

export async function getAccountCountForServerComponent({ serverComponentName, serverDir, env, bestEffort = false }) {
  if (serverComponentName === 'happy-server-light') {
    const ready = await ensureServerLightSchemaReady({ serverDir, env });
    return { ok: true, accountCount: Number.isFinite(ready.accountCount) ? ready.accountCount : 0 };
  }
  if (serverComponentName === 'happy-server') {
    try {
      const ready = await ensureHappyServerSchemaReady({ serverDir, env });
      return { ok: true, accountCount: Number.isFinite(ready.accountCount) ? ready.accountCount : 0 };
    } catch (e) {
      if (!bestEffort) throw e;
      return { ok: false, accountCount: null, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return { ok: false, accountCount: null, error: `unknown server component: ${serverComponentName}` };
}

export async function maybeAutoCopyAuthFromMainIfNeeded({
  rootDir,
  env,
  enabled,
  stackName,
  cliHomeDir,
  accountCount,
  quiet = false,
  authEnv = null,
}) {
  const accessKeyPath = join(cliHomeDir, 'access.key');
  const hasAccessKey = existsSync(accessKeyPath);

  // "Initialized" heuristic:
  // - if we have credentials AND (when known) at least one Account row, we don't need to seed from main.
  const hasAccounts = typeof accountCount === 'number' ? accountCount > 0 : null;
  const needsSeed = !hasAccessKey || hasAccounts === false;

  if (!enabled || !needsSeed) {
    return { ok: true, skipped: true, reason: !enabled ? 'disabled' : 'already_initialized' };
  }

  const reason = !hasAccessKey ? 'missing_credentials' : 'no_accounts';
  const fromStackName = resolveAuthSeedFromEnv(env);
  const linkAuth =
    (env.HAPPY_STACKS_AUTH_LINK ?? env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim() === '1' ||
    (env.HAPPY_STACKS_AUTH_MODE ?? env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim() === 'link';
  if (!quiet) {
    console.log(`[local] auth: auto seed from ${fromStackName} for ${stackName} (${reason})`);
  }

  // Best-effort: copy credentials/master secret + seed accounts from the configured seed stack.
  // Keep this non-fatal; the daemon will emit actionable errors if it still can't authenticate.
  try {
    const out = await runCapture(
      process.execPath,
      [`${rootDir}/scripts/auth.mjs`, 'copy-from', fromStackName, '--json', ...(linkAuth ? ['--link'] : [])],
      {
      cwd: rootDir,
      env: authEnv && typeof authEnv === 'object' ? authEnv : env,
      }
    );
    return { ok: true, skipped: false, reason, out: out.trim() ? JSON.parse(out) : null };
  } catch (e) {
    return { ok: false, skipped: false, reason, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function prepareDaemonAuthSeedIfNeeded({
  rootDir,
  env,
  stackName,
  cliHomeDir,
  startDaemon,
  isInteractive,
  accountCount,
  quiet = false,
  authEnv = null,
}) {
  if (!startDaemon) return { ok: true, skipped: true, reason: 'no_daemon' };
  const enabled = resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive });
  return await maybeAutoCopyAuthFromMainIfNeeded({
    rootDir,
    env,
    enabled,
    stackName,
    cliHomeDir,
    accountCount,
    quiet,
    authEnv,
  });
}
