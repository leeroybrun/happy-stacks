import { runCapture } from './proc.mjs';
import { ensureDepsInstalled, pmExecBin } from './pm.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function looksLikeMissingTableError(msg) {
  const s = String(msg ?? '').toLowerCase();
  return s.includes('does not exist') || s.includes('no such table');
}

async function probeAccountCount({ serverDir, env }) {
  const probe = `
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  const accountCount = await db.account.count();
  console.log(JSON.stringify({ accountCount }));
} finally {
  await db.$disconnect();
}
`.trim();

  const out = await runCapture(process.execPath, ['--input-type=module', '-e', probe], { cwd: serverDir, env, timeoutMs: 15_000 });
  const parsed = out.trim() ? JSON.parse(out.trim()) : {};
  return Number(parsed.accountCount ?? 0);
}

export function resolveAutoCopyFromMainEnabled({ env, stackName, isInteractive }) {
  const raw = (env.HAPPY_STACKS_AUTO_COPY_FROM_MAIN ?? env.HAPPY_LOCAL_AUTO_COPY_FROM_MAIN ?? '').toString().trim();
  if (raw) {
    return raw !== '0';
  }
  // Default: only for non-main stacks, and only in non-interactive contexts (agents/services).
  return stackName !== 'main' && !isInteractive;
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

export async function maybeAutoCopyAuthFromMainIfNeeded({ rootDir, env, enabled, stackName, cliHomeDir, accountCount, quiet = false }) {
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
  if (!quiet) {
    console.log(`[local] auth: auto copy-from main for ${stackName} (${reason})`);
  }

  // Best-effort: copy credentials/master secret + seed accounts from main.
  // Keep this non-fatal; the daemon will emit actionable errors if it still can't authenticate.
  try {
    const out = await runCapture(process.execPath, [`${rootDir}/scripts/auth.mjs`, 'copy-from', 'main', '--json'], { cwd: rootDir, env });
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
  });
}

