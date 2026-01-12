import { spawnProc, run, runCapture } from './utils/proc.mjs';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { chmod, copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';

/**
 * Daemon lifecycle helpers for happy-stacks.
 *
 * Centralizes:
 * - stopping old daemons (legacy + local home dirs)
 * - cleaning stale lock/state
 * - starting daemon and handling first-time auth
 * - printing actionable diagnostics
 */

export async function cleanupStaleDaemonState(homeDir) {
  const statePath = join(homeDir, 'daemon.state.json');
  const lockPath = join(homeDir, 'daemon.state.json.lock');

  if (!existsSync(lockPath)) {
    return;
  }

  const lsofHasPath = async (pid, pathNeedle) => {
    try {
      const out = await runCapture('sh', ['-lc', `command -v lsof >/dev/null 2>&1 && lsof -nP -p ${pid} 2>/dev/null || true`]);
      return out.includes(pathNeedle);
    } catch {
      return false;
    }
  };

  // If lock PID exists and is running, keep lock/state ONLY if it still owns the lock file path.
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const pid = Number(raw);
    if (Number.isFinite(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        // If PID was recycled, refuse to trust it unless we can prove it's associated with this home dir.
        // This prevents cross-stack daemon kills due to stale lock files.
        if (await lsofHasPath(pid, lockPath)) {
          return;
        }
      } catch {
        // stale pid
      }
    }
  } catch {
    // ignore
  }

  // If state PID exists and is running, keep lock/state.
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = typeof state?.pid === 'number' ? state.pid : null;
      if (pid) {
        try {
          process.kill(pid, 0);
          // Only keep if we can prove it still uses this home dir (via state path).
          if (await lsofHasPath(pid, statePath)) {
            return;
          }
        } catch {
          // stale pid
        }
      }
    } catch {
      // ignore
    }
  }

  try { unlinkSync(lockPath); } catch { /* ignore */ }
  try { unlinkSync(statePath); } catch { /* ignore */ }
}

export function checkDaemonState(cliHomeDir) {
  const statePath = join(cliHomeDir, 'daemon.state.json');
  const lockPath = join(cliHomeDir, 'daemon.state.json.lock');

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = Number(state?.pid);
      if (Number.isFinite(pid) && pid > 0) {
        return alive(pid) ? { status: 'running', pid } : { status: 'stale_state', pid };
      }
      return { status: 'bad_state', pid: null };
    } catch {
      return { status: 'bad_state', pid: null };
    }
  }

  if (existsSync(lockPath)) {
    try {
      const pid = Number(readFileSync(lockPath, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        return alive(pid) ? { status: 'starting', pid } : { status: 'stale_lock', pid };
      }
      return { status: 'bad_lock', pid: null };
    } catch {
      return { status: 'bad_lock', pid: null };
    }
  }

  return { status: 'stopped', pid: null };
}

export function isDaemonRunning(cliHomeDir) {
  const s = checkDaemonState(cliHomeDir);
  return s.status === 'running' || s.status === 'starting';
}

function getLatestDaemonLogPath(homeDir) {
  try {
    const logsDir = join(homeDir, 'logs');
    const files = readdirSync(logsDir).filter((f) => f.endsWith('-daemon.log')).sort();
    if (!files.length) return null;
    return join(logsDir, files[files.length - 1]);
  } catch {
    return null;
  }
}

function readLastLines(path, lines = 60) {
  try {
    const content = readFileSync(path, 'utf-8');
    const parts = content.split('\n');
    return parts.slice(Math.max(0, parts.length - lines)).join('\n');
  } catch {
    return null;
  }
}

function excerptIndicatesMissingAuth(excerpt) {
  if (!excerpt) return false;
  return (
    excerpt.includes('[AUTH] No credentials found') ||
    excerpt.includes('No credentials found, starting authentication flow')
  );
}

function authLoginHint() {
  const stackName = (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
  return stackName === 'main' ? 'happys auth login' : `happys stack auth ${stackName} login`;
}

function authCopyFromMainHint() {
  const stackName = (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
  return stackName === 'main' ? null : `happys stack auth ${stackName} copy-from main`;
}

async function seedCredentialsIfMissing({ cliHomeDir }) {
  const stacksRootRaw = (process.env.HAPPY_STACKS_STORAGE_DIR ?? process.env.HAPPY_LOCAL_STORAGE_DIR ?? '').trim();
  const stacksRoot = stacksRootRaw ? stacksRootRaw.replace(/^~(?=\/)/, homedir()) : join(homedir(), '.happy', 'stacks');

  const sources = [
    // New layout: main stack credentials (preferred).
    join(stacksRoot, 'main', 'cli'),
    // Legacy happy-local storage root (most common for existing users).
    join(homedir(), '.happy', 'local', 'cli'),
    // Older global location.
    join(homedir(), '.happy'),
  ];

  const copyIfMissing = async ({ relPath, mode, label }) => {
    const target = join(cliHomeDir, relPath);
    if (existsSync(target)) {
      return { copied: false, source: null, target };
    }
    const sourceDir = sources.find((d) => existsSync(join(d, relPath)));
    if (!sourceDir) {
      return { copied: false, source: null, target };
    }
    const source = join(sourceDir, relPath);
    await mkdir(cliHomeDir, { recursive: true });
    await copyFile(source, target);
    await chmod(target, mode).catch(() => {});
    console.log(`[local] migrated ${label}: ${source} -> ${target}`);
    return { copied: true, source, target };
  };

  // access.key holds the auth token + encryption material (keep tight permissions)
  const access = await copyIfMissing({ relPath: 'access.key', mode: 0o600, label: 'CLI credentials (access.key)' })
    .catch((err) => {
      console.warn(`[local] failed to migrate CLI credentials into ${cliHomeDir}:`, err);
      return { copied: false, source: null, target: join(cliHomeDir, 'access.key') };
    });

  // settings.json holds machineId and other client state; migrate to keep your machine identity stable.
  const settings = await copyIfMissing({ relPath: 'settings.json', mode: 0o600, label: 'CLI settings (settings.json)' })
    .catch((err) => {
      console.warn(`[local] failed to migrate CLI settings into ${cliHomeDir}:`, err);
      return { copied: false, source: null, target: join(cliHomeDir, 'settings.json') };
    });

  return { ok: true, copied: access.copied || settings.copied, access, settings };
}

async function killDaemonFromLockFile({ cliHomeDir }) {
  const lockPath = join(cliHomeDir, 'daemon.state.json.lock');
  if (!existsSync(lockPath)) {
    return false;
  }

  let pid = null;
  try {
    const raw = readFileSync(lockPath, 'utf-8').trim();
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      pid = n;
    }
  } catch {
    // ignore
  }
  if (!pid) {
    return false;
  }

  // If pid is alive, confirm it looks like a happy daemon and terminate it.
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }

  let cmd = '';
  try {
    cmd = await runCapture('ps', ['-p', String(pid), '-o', 'command=']);
  } catch {
    cmd = '';
  }
  const looksLikeDaemon = cmd.includes(' daemon ') || cmd.includes('daemon start') || cmd.includes('daemon start-sync');
  if (!looksLikeDaemon) {
    console.warn(`[local] refusing to kill pid ${pid} from lock file (doesn't look like daemon): ${cmd.trim()}`);
    return false;
  }

  // Hard safety: only kill if we can prove the PID is associated with this stack home dir.
  // We do this by checking that `lsof -p <pid>` includes the lock path (or state file path).
  let ownsLock = false;
  try {
    const out = await runCapture('sh', ['-lc', `command -v lsof >/dev/null 2>&1 && lsof -nP -p ${pid} 2>/dev/null || true`]);
    ownsLock = out.includes(lockPath) || out.includes(join(cliHomeDir, 'daemon.state.json')) || out.includes(join(cliHomeDir, 'logs'));
  } catch {
    ownsLock = false;
  }
  if (!ownsLock) {
    console.warn(
      `[local] refusing to kill pid ${pid} from lock file (could be unrelated; lsof did not show ownership of ${cliHomeDir})`
    );
    return false;
  }

  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    return false;
  }
  await delay(500);
  try {
    process.kill(pid, 0);
    // Still alive: hard kill.
    process.kill(pid, 'SIGKILL');
  } catch {
    // exited
  }
  console.log(`[local] killed stuck daemon pid ${pid} (from ${lockPath})`);
  return true;
}

async function waitForCredentialsFile({ path, timeoutMs, isShuttingDown }) {
  const deadline = Date.now() + timeoutMs;
  while (!isShuttingDown() && Date.now() < deadline) {
    try {
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf-8').trim();
        if (raw.length > 0) {
          return true;
        }
      }
    } catch {
      // ignore
    }
    await delay(500);
  }
  return false;
}

export function getDaemonEnv({ baseEnv, cliHomeDir, internalServerUrl, publicServerUrl }) {
  return {
    ...baseEnv,
    HAPPY_SERVER_URL: internalServerUrl,
    HAPPY_WEBAPP_URL: publicServerUrl,
    HAPPY_HOME_DIR: cliHomeDir,
  };
}

export async function stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir }) {
  const env = {
    ...process.env,
    HAPPY_SERVER_URL: internalServerUrl,
    HAPPY_HOME_DIR: cliHomeDir,
  };

  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], env, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // If the daemon never wrote daemon.state.json (e.g. it got stuck in auth in a non-interactive context),
  // stopLocalDaemon() can't find it. Fall back to the lock file PID.
  await killDaemonFromLockFile({ cliHomeDir });
}

export async function startLocalDaemonWithAuth({
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  isShuttingDown,
  forceRestart = false,
}) {
  const stackName = (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
  const baseEnv = { ...process.env };
  const daemonEnv = getDaemonEnv({ baseEnv, cliHomeDir, internalServerUrl, publicServerUrl });

  // If this is a migrated/new stack home dir, seed credentials from the user's existing login (best-effort)
  // to avoid requiring an interactive auth flow under launchd.
  await seedCredentialsIfMissing({ cliHomeDir });

  const existing = checkDaemonState(cliHomeDir);
  if (!forceRestart && (existing.status === 'running' || existing.status === 'starting')) {
    // eslint-disable-next-line no-console
    console.log(`[local] daemon already running for stack home (pid=${existing.pid})`);
    return;
  }

  // Stop any existing daemon for THIS stack home dir.
  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // Best-effort: for the main stack, also stop the legacy global daemon home (~/.happy) to prevent legacy overlap.
  if (stackName === 'main') {
    const legacyEnv = { ...daemonEnv, HAPPY_HOME_DIR: join(homedir(), '.happy') };
    try {
      await new Promise((resolve) => {
        const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], legacyEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.on('exit', () => resolve());
      });
    } catch {
      // ignore
    }
    // If state is missing and stop couldn't find it, force-stop the lock PID (otherwise repeated restarts accumulate daemons).
    await killDaemonFromLockFile({ cliHomeDir: join(homedir(), '.happy') });
    await cleanupStaleDaemonState(join(homedir(), '.happy'));
  }

  // If state is missing and stop couldn't find it, force-stop the lock PID (otherwise repeated restarts accumulate daemons).
  await killDaemonFromLockFile({ cliHomeDir });

  // Clean up stale lock/state files that can block daemon start.
  await cleanupStaleDaemonState(cliHomeDir);

  const credentialsPath = join(cliHomeDir, 'access.key');

  const startOnce = async () => {
    const exitCode = await new Promise((resolve) => {
      const proc = spawnProc('daemon', cliBin, ['daemon', 'start'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', (code) => resolve(code ?? 0));
    });

    if (exitCode === 0) {
      return { ok: true, exitCode, excerpt: null, logPath: null };
    }

    const logPath = getLatestDaemonLogPath(cliHomeDir) || getLatestDaemonLogPath(join(homedir(), '.happy'));
    const excerpt = logPath ? readLastLines(logPath, 120) : null;
    return { ok: false, exitCode, excerpt, logPath };
  };

  const first = await startOnce();
  if (!first.ok) {
    if (first.excerpt) {
      console.error(`[local] daemon failed to start; last daemon log (${first.logPath}):\n${first.excerpt}`);
    } else {
      console.error('[local] daemon failed to start; no daemon log found');
    }

    if (excerptIndicatesMissingAuth(first.excerpt)) {
      const copyHint = authCopyFromMainHint();
      console.error(
        `[local] daemon is not authenticated yet (expected on first run).\n` +
        `[local] Keeping the server running so you can login.\n` +
        `[local] In another terminal, run:\n` +
        `${authLoginHint()}\n` +
        (copyHint ? `[local] Or (recommended if main is already logged in):\n${copyHint}\n` : '') +
        `[local] Waiting for credentials at ${credentialsPath}...`
      );

      const ok = await waitForCredentialsFile({ path: credentialsPath, timeoutMs: 10 * 60_000, isShuttingDown });
      if (!ok) {
        throw new Error('Timed out waiting for daemon credentials (auth login not completed)');
      }

      console.log('[local] credentials detected, retrying daemon start...');
      const second = await startOnce();
      if (!second.ok) {
        if (second.excerpt) {
          console.error(`[local] daemon still failed to start; last daemon log (${second.logPath}):\n${second.excerpt}`);
        }
        throw new Error('Failed to start daemon (after credentials were created)');
      }
    } else {
      const copyHint = authCopyFromMainHint();
      console.error(
        `[local] daemon failed to start (server returned an error).\n` +
          `[local] Try:\n` +
          `- happys doctor\n` +
          (copyHint ? `- ${copyHint}\n` : '') +
          `- ${authLoginHint()}`
      );
      throw new Error('Failed to start daemon');
    }
  }

  // Confirm daemon status (best-effort)
  try {
    await run('node', [cliBin, 'daemon', 'status'], { env: daemonEnv });
  } catch {
    // ignore
  }
}

export async function daemonStatusSummary({ cliBin, cliHomeDir, internalServerUrl, publicServerUrl }) {
  const env = getDaemonEnv({ baseEnv: process.env, cliHomeDir, internalServerUrl, publicServerUrl });
  return await runCapture('node', [cliBin, 'daemon', 'status'], { env });
}
