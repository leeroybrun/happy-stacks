import {
  ensureDepsInstalled,
  getComponentDir,
  getRootDir,
  killPortListeners,
  killProcessTree,
  pmSpawnScript,
  requireDir,
  spawnProc,
  waitForServerReady,
} from './shared.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';

function cleanupStaleDaemonState(homeDir) {
  const statePath = join(homeDir, 'daemon.state.json');
  const lockPath = join(homeDir, 'daemon.state.json.lock');

  if (!existsSync(lockPath)) {
    return;
  }

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

/**
 * Dev mode stack:
 * - happy-server-light
 * - happy-cli daemon
 * - Expo web dev server (watch/reload)
 */

async function main() {
  const rootDir = getRootDir(import.meta.url);

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT
    ? parseInt(process.env.HAPPY_LOCAL_SERVER_PORT, 10)
    : 3005;

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const publicServerUrl = process.env.HAPPY_LOCAL_SERVER_URL?.trim()
    ? process.env.HAPPY_LOCAL_SERVER_URL.trim()
    : internalServerUrl;

  const startUi = (process.env.HAPPY_LOCAL_UI ?? '1') !== '0';
  const startDaemon = (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';

  const serverDir = getComponentDir(rootDir, 'happy-server-light');
  const uiDir = getComponentDir(rootDir, 'happy');
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  await requireDir('happy-server-light', serverDir);
  await requireDir('happy', uiDir);
  await requireDir('happy-cli', cliDir);

  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  const children = [];
  let shuttingDown = false;
  const baseEnv = { ...process.env };

  // Start server-light
  await killPortListeners(serverPort, { label: 'server' });
  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };
  await ensureDepsInstalled(serverDir, 'happy-server-light');
  const server = await pmSpawnScript({ label: 'server', dir: serverDir, script: 'dev', env: serverEnv });
  children.push(server);

  await waitForServerReady(internalServerUrl);
  console.log(`[local] server ready at ${internalServerUrl}`);
  console.log(
    `[local] tip: to run 'happy' from your terminal *against this local server* (and have sessions show up in the UI), use:\n` +
    `export HAPPY_SERVER_URL=\"${internalServerUrl}\"\n` +
    `export HAPPY_HOME_DIR=\"${join(homedir(), '.happy', 'local', 'cli')}\"\n` +
    `export HAPPY_WEBAPP_URL=\"${publicServerUrl}\"\n`
  );

  // Start daemon (detached daemon process managed by happy-cli)
  if (startDaemon) {
    const daemonEnv = { ...baseEnv, HAPPY_SERVER_URL: internalServerUrl };
    // Stop any existing daemon before starting a fresh one.
    try {
      await new Promise((resolve) => {
        const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
        proc.on('exit', () => resolve());
      });
    } catch {
      // ignore
    }
    cleanupStaleDaemonState(join(homedir(), '.happy'));
    await new Promise((resolve) => {
      const proc = spawnProc('daemon', cliBin, ['daemon', 'start'], daemonEnv, { stdio: ['ignore', 'pipe', 'pipe'] });
      proc.on('exit', () => resolve());
    });
  }

  // Start UI (Expo web dev server)
  if (startUi) {
    await ensureDepsInstalled(uiDir, 'happy');
    const uiEnv = { ...baseEnv };
    delete uiEnv.CI;
    uiEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = publicServerUrl;
    uiEnv.EXPO_PUBLIC_DEBUG = uiEnv.EXPO_PUBLIC_DEBUG ?? '1';
    const ui = await pmSpawnScript({ label: 'ui', dir: uiDir, script: 'web', env: uiEnv });
    children.push(ui);
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n[local] shutting down...');

    if (startDaemon) {
      try {
        await new Promise((resolve) => {
          const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], { ...process.env, HAPPY_SERVER_URL: internalServerUrl });
          proc.on('exit', () => resolve());
        });
      } catch {
        // ignore
      }
    }

    for (const child of children) {
      if (child.exitCode == null) {
        killProcessTree(child, 'SIGINT');
      }
    }

    await delay(1500);
    for (const child of children) {
      if (child.exitCode == null) {
        killProcessTree(child, 'SIGKILL');
      }
    }
  };

  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[local] failed:', err);
  process.exit(1);
});

