import {
  ensureDepsInstalled,
  getComponentDir,
  getRootDir,
  killPortListeners,
  killProcessTree,
  parseArgs,
  pmSpawnScript,
  requireDir,
  waitForServerReady,
} from './shared.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { resolvePublicServerUrl } from './tailscale.mjs';

/**
 * Dev mode stack:
 * - happy-server-light
 * - happy-cli daemon
 * - Expo web dev server (watch/reload)
 */

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const rootDir = getRootDir(import.meta.url);

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT
    ? parseInt(process.env.HAPPY_LOCAL_SERVER_PORT, 10)
    : 3005;

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const defaultPublicUrl = `http://localhost:${serverPort}`;
  const envPublicUrl = process.env.HAPPY_LOCAL_SERVER_URL?.trim() ? process.env.HAPPY_LOCAL_SERVER_URL.trim() : '';
  const resolved = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: true,
  });
  const publicServerUrl = resolved.publicServerUrl;

  const startUi = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_UI ?? '1') !== '0';
  const startDaemon = !flags.has('--no-daemon') && (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';

  const serverDir = getComponentDir(rootDir, 'happy-server-light');
  const uiDir = getComponentDir(rootDir, 'happy');
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  await requireDir('happy-server-light', serverDir);
  await requireDir('happy', uiDir);
  await requireDir('happy-cli', cliDir);

  const cliBin = join(cliDir, 'bin', 'happy.mjs');
  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(homedir(), '.happy', 'local', 'cli');

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
      `export HAPPY_HOME_DIR=\"${cliHomeDir}\"\n` +
    `export HAPPY_WEBAPP_URL=\"${publicServerUrl}\"\n`
  );

  // Start daemon (detached daemon process managed by happy-cli)
  if (startDaemon) {
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => shuttingDown,
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
      await stopLocalDaemon({ cliBin, internalServerUrl, cliHomeDir });
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

