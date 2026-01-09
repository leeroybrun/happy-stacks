import { spawnProc, run, runCapture } from './utils/proc.mjs';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
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

export function cleanupStaleDaemonState(homeDir) {
  const statePath = join(homeDir, 'daemon.state.json');
  const lockPath = join(homeDir, 'daemon.state.json.lock');

  if (!existsSync(lockPath)) {
    return;
  }

  // If state PID exists and is running, keep lock/state.
  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = typeof state?.pid === 'number' ? state.pid : null;
      if (pid) {
        try {
          process.kill(pid, 0);
          return;
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
}

export async function startLocalDaemonWithAuth({
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  isShuttingDown,
}) {
  const baseEnv = { ...process.env };
  const daemonEnv = getDaemonEnv({ baseEnv, cliHomeDir, internalServerUrl, publicServerUrl });

  // Stop any existing daemon (best-effort) in both legacy and local home dirs.
  const legacyEnv = { ...daemonEnv, HAPPY_HOME_DIR: join(homedir(), '.happy') };
  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], legacyEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }
  try {
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  } catch {
    // ignore
  }

  // Clean up stale lock/state files that can block daemon start.
  cleanupStaleDaemonState(join(homedir(), '.happy'));
  cleanupStaleDaemonState(cliHomeDir);

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
      console.error(
        `[local] daemon is not authenticated yet (expected on first run).\n` +
        `[local] Keeping the server running so you can login.\n` +
        `[local] In another terminal, run:\n` +
        `HAPPY_HOME_DIR=\"${cliHomeDir}\" HAPPY_SERVER_URL=\"${internalServerUrl}\" HAPPY_WEBAPP_URL=\"${publicServerUrl}\" node \"${cliBin}\" auth login --force\n` +
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
      console.error(`[local] To re-auth against the local server, run:\n` +
        `HAPPY_HOME_DIR=\"${cliHomeDir}\" HAPPY_SERVER_URL=\"${internalServerUrl}\" HAPPY_WEBAPP_URL=\"${publicServerUrl}\" ` +
        `node \"${cliBin}\" auth login --force`);
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

