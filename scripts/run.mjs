import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { pathExists } from './utils/fs.mjs';
import { killProcessTree, runCapture } from './utils/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths.mjs';
import { killPortListeners } from './utils/ports.mjs';
import { getServerComponentName, waitForServerReady } from './utils/server.mjs';
import { pmSpawnScript, requireDir } from './utils/pm.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { maybeResetTailscaleServe, resolvePublicServerUrl } from './tailscale.mjs';
import { startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';

/**
 * Run the local stack in "production-like" mode:
 * - happy-server-light
 * - happy-cli daemon
 * - serve prebuilt UI via happy-server-light (/)
 *
 * No Expo dev server.
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--server=happy-server|happy-server-light', '--no-ui', '--no-daemon'], json: true },
      text: [
        '[start] usage:',
        '  happys start [--server=happy-server|happy-server-light] [--json]',
        '  (legacy in a cloned repo): pnpm start [-- --server=happy-server|happy-server-light] [--json]',
        '  note: --json prints the resolved config (dry-run) and exits.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT
    ? parseInt(process.env.HAPPY_LOCAL_SERVER_PORT, 10)
    : 3005;

  // Internal URL used by local processes on this machine.
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  // Public URL is what you might share/open (e.g. https://<machine>.<tailnet>.ts.net).
  // We auto-prefer the Tailscale HTTPS URL when available, unless explicitly overridden.
  const defaultPublicUrl = `http://localhost:${serverPort}`;
  const envPublicUrl = process.env.HAPPY_LOCAL_SERVER_URL?.trim() ? process.env.HAPPY_LOCAL_SERVER_URL.trim() : '';
  let publicServerUrl = envPublicUrl || defaultPublicUrl;

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for run (pick one: happy-server-light or happy-server)`);
  }

  const startDaemon = !flags.has('--no-daemon') && (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';
  const serveUiWanted = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const serveUi = serveUiWanted && serverComponentName === 'happy-server-light';
  const uiPrefix = process.env.HAPPY_LOCAL_UI_PREFIX?.trim() ? process.env.HAPPY_LOCAL_UI_PREFIX.trim() : '/';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(getDefaultAutostartPaths().baseDir, 'ui');

  const enableTailscaleServe = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  await requireDir(serverComponentName, serverDir);
  await requireDir('happy-cli', cliDir);

  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(getDefaultAutostartPaths().baseDir, 'cli');

  if (json) {
    printResult({
      json,
      data: {
        mode: 'start',
        serverComponentName,
        serverDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startDaemon,
        serveUi,
        uiPrefix,
        uiBuildDir,
        cliHomeDir,
      },
    });
    return;
  }

  if (serveUiWanted && !serveUi) {
    console.log(`[local] ui serving disabled (requires happy-server-light; you are using ${serverComponentName})`);
  }

  if (serveUi && !(await pathExists(uiBuildDir))) {
    throw new Error(`[local] UI build directory not found at ${uiBuildDir}. Run: happys build (legacy in a cloned repo: pnpm build)`);
  }

  const children = [];
  let shuttingDown = false;
  const baseEnv = { ...process.env };

  // Public URL automation: auto-prefer https://*.ts.net on every start.
  const resolved = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: true,
  });
  publicServerUrl = resolved.publicServerUrl;

  // Server
  // If a previous run left a server behind, free the port first (prevents false "ready" checks).
  await killPortListeners(serverPort, { label: 'server' });

  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    // Used by server-light for generating public file URLs.
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    // You can override with METRICS_ENABLED=true if you want it.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
    ...(serveUi
      ? {
          HAPPY_SERVER_LIGHT_UI_DIR: uiBuildDir,
          HAPPY_SERVER_LIGHT_UI_PREFIX: uiPrefix,
        }
      : {}),
  };

  const server = await pmSpawnScript({ label: 'server', dir: serverDir, script: 'dev', env: serverEnv });
  children.push(server);

  await waitForServerReady(internalServerUrl);
  console.log(`[local] server ready at ${internalServerUrl}`);

  if (enableTailscaleServe) {
    try {
      const status = await runCapture(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), 'status']);
      const line = status.split('\n').find((l) => l.toLowerCase().includes('https://'))?.trim();
      if (line) {
        console.log(`[local] tailscale serve: ${line}`);
      } else {
        console.log('[local] tailscale serve enabled');
      }
    } catch {
      console.log('[local] tailscale serve enabled');
    }
  }

  if (serveUi) {
    const localUi = internalServerUrl.replace(/\/+$/, '') + '/';
    console.log(`[local] ui served locally at ${localUi}`);
    if (publicServerUrl && publicServerUrl !== internalServerUrl && publicServerUrl !== localUi && publicServerUrl !== defaultPublicUrl) {
      const pubUi = publicServerUrl.replace(/\/+$/, '') + '/';
      console.log(`[local] public url: ${pubUi}`);
    }
    if (enableTailscaleServe) {
      console.log('[local] tip: use the HTTPS *.ts.net URL for remote access');
    }

    console.log(
      `[local] tip: to run 'happy' from your terminal *against this local server* (and have sessions show up in the UI), use:\n` +
      `export HAPPY_SERVER_URL=\"${internalServerUrl}\"\n` +
      `export HAPPY_HOME_DIR=\"${cliHomeDir}\"\n` +
      `export HAPPY_WEBAPP_URL=\"${publicServerUrl}\"\n`
    );
  }

  // Daemon
  if (startDaemon) {
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => shuttingDown,
    });
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

    await maybeResetTailscaleServe();
  };

  process.on('SIGINT', () => shutdown().then(() => process.exit(0)));
  process.on('SIGTERM', () => shutdown().then(() => process.exit(0)));

  // Keep running
  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[local] failed:', err);
  process.exit(1);
});
