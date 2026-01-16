import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { killProcessTree, runCapture, spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { killPortListeners } from './utils/net/ports.mjs';
import { getServerComponentName, isHappyServerRunning, waitForServerReady } from './utils/server/server.mjs';
import { ensureCliBuilt, ensureDepsInstalled, pmExecBin, pmSpawnScript, requireDir } from './utils/proc/pm.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { maybeResetTailscaleServe } from './tailscale.mjs';
import { isDaemonRunning, startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/server/validate.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from './utils/server/infra/happy_server_infra.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from './utils/stack/startup.mjs';
import { recordStackRuntimeStart, recordStackRuntimeUpdate } from './utils/stack/runtime_state.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { resolveLocalhostHost } from './utils/paths/localhost_host.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { startDevExpoMobile } from './utils/dev/expo_mobile.mjs';

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
      data: { flags: ['--server=happy-server|happy-server-light', '--no-ui', '--no-daemon', '--restart', '--no-browser', '--mobile'], json: true },
      text: [
        '[start] usage:',
        '  happys start [--server=happy-server|happy-server-light] [--restart] [--json]',
        '  (legacy in a cloned repo): pnpm start [-- --server=happy-server|happy-server-light] [--json]',
        '  note: --json prints the resolved config (dry-run) and exits.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const serverPort = resolveServerPortFromEnv({ defaultPort: 3005 });

  // Internal URL used by local processes on this machine.
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  // Public URL is what you might share/open (e.g. https://<machine>.<tailnet>.ts.net).
  // We auto-prefer the Tailscale HTTPS URL when available, unless explicitly overridden.
  const { defaultPublicUrl, envPublicUrl, publicServerUrl: publicServerUrlPreview } = getPublicServerUrlEnvOverride({ serverPort });
  let publicServerUrl = publicServerUrlPreview;

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for run (pick one: happy-server-light or happy-server)`);
  }

  const startDaemon = !flags.has('--no-daemon') && (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';
  const serveUiWanted = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const serveUi = serveUiWanted;
  const startMobile = flags.has('--mobile') || flags.has('--with-mobile');
  const noBrowser = flags.has('--no-browser') || (process.env.HAPPY_STACKS_NO_BROWSER ?? process.env.HAPPY_LOCAL_NO_BROWSER ?? '').toString().trim() === '1';
  const uiPrefix = process.env.HAPPY_LOCAL_UI_PREFIX?.trim() ? process.env.HAPPY_LOCAL_UI_PREFIX.trim() : '/';
  const autostart = getDefaultAutostartPaths();
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(autostart.baseDir, 'ui');

  const enableTailscaleServe = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const uiDir = getComponentDir(rootDir, 'happy');

  assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
  assertServerPrismaProviderMatches({ serverComponentName, serverDir });

  await requireDir(serverComponentName, serverDir);
  await requireDir('happy-cli', cliDir);
  if (startMobile) {
    await requireDir('happy', uiDir);
  }

  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(autostart.baseDir, 'cli');
  const restart = flags.has('--restart');

  if (json) {
    printResult({
      json,
      data: {
        mode: 'start',
        serverComponentName,
        serverDir,
        uiDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startDaemon,
        serveUi,
        startMobile,
        uiPrefix,
        uiBuildDir,
        cliHomeDir,
      },
    });
    return;
  }

  if (serveUi && !(await pathExists(uiBuildDir))) {
    if (serverComponentName === 'happy-server-light') {
      throw new Error(`[local] UI build directory not found at ${uiBuildDir}. Run: happys build (legacy in a cloned repo: pnpm build)`);
    }
    // For happy-server, UI serving is optional via the UI gateway.
    console.log(`[local] UI build directory not found at ${uiBuildDir}; UI gateway will be disabled`);
  }

  const children = [];
  let shuttingDown = false;
  const baseEnv = { ...process.env };
  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;

  // Ensure happy-cli is install+build ready before starting the daemon.
  const buildCli = (baseEnv.HAPPY_STACKS_CLI_BUILD ?? baseEnv.HAPPY_LOCAL_CLI_BUILD ?? '1').toString().trim() !== '0';
  await ensureCliBuilt(cliDir, { buildCli });

  // Ensure server deps exist before any Prisma/docker work.
  await ensureDepsInstalled(serverDir, serverComponentName);
  if (startMobile) {
    await ensureDepsInstalled(uiDir, 'happy');
  }

  // Public URL automation:
  // - Only the main stack should ever auto-enable Tailscale Serve by default.
  // - Non-main stacks default to localhost unless the user explicitly configured a public URL
  //   OR Tailscale Serve is already configured for this stack's internal URL (status matches).
  const allowEnableTailscale = !stackMode || stackName === 'main';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  if (stackMode && stackName !== 'main' && !resolvedUrls.envPublicUrl) {
    const src = String(resolvedUrls.publicServerUrlSource ?? '');
    const hasStackScopedTailscale = src.startsWith('tailscale-');
    publicServerUrl = hasStackScopedTailscale ? resolvedUrls.publicServerUrl : resolvedUrls.defaultPublicUrl;
  } else {
    publicServerUrl = resolvedUrls.publicServerUrl;
  }

  const serverAlreadyRunning = await isHappyServerRunning(internalServerUrl);
  const daemonAlreadyRunning = startDaemon ? isDaemonRunning(cliHomeDir) : false;
  if (!restart && serverAlreadyRunning && (!startDaemon || daemonAlreadyRunning)) {
    console.log(`[local] start: stack already running (server=${internalServerUrl}${startDaemon ? ` daemon=${daemonAlreadyRunning ? 'running' : 'stopped'}` : ''})`);
    return;
  }

  // Stack runtime state (stack-scoped commands only): record the runner PID + chosen ports so stop/restart never kills other stacks.
  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'run.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: { server: serverPort },
    }).catch(() => {});
  }

  // Server
  // If a previous run left a server behind, free the port first (prevents false "ready" checks).
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if ((!serverAlreadyRunning || restart) && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    // Used by server-light for generating public file URLs.
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    // You can override with METRICS_ENABLED=true if you want it.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
    ...(serveUi && serverComponentName === 'happy-server-light'
      ? {
          HAPPY_SERVER_LIGHT_UI_DIR: uiBuildDir,
          HAPPY_SERVER_LIGHT_UI_PREFIX: uiPrefix,
        }
      : {}),
  };
  let serverLightAccountCount = null;
  let happyServerAccountCount = null;
  if (serverComponentName === 'happy-server-light') {
    const dataDir = baseEnv.HAPPY_SERVER_LIGHT_DATA_DIR?.trim()
      ? baseEnv.HAPPY_SERVER_LIGHT_DATA_DIR.trim()
      : join(autostart.baseDir, 'server-light');
    serverEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    serverEnv.HAPPY_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPY_SERVER_LIGHT_FILES_DIR?.trim()
      ? baseEnv.HAPPY_SERVER_LIGHT_FILES_DIR.trim()
      : join(dataDir, 'files');
    serverEnv.DATABASE_URL = baseEnv.DATABASE_URL?.trim()
      ? baseEnv.DATABASE_URL.trim()
      : `file:${join(dataDir, 'happy-server-light.sqlite')}`;

    // Reliability: ensure DB schema exists before daemon hits /v1/machines (health checks don't cover DB readiness).
    const acct = await getAccountCountForServerComponent({
      serverComponentName,
      serverDir,
      env: serverEnv,
      bestEffort: false,
    });
    serverLightAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
  }
  let effectiveInternalServerUrl = internalServerUrl;
  if (serverComponentName === 'happy-server') {
    const managed = (baseEnv.HAPPY_STACKS_MANAGED_INFRA ?? baseEnv.HAPPY_LOCAL_MANAGED_INFRA ?? '1') !== '0';
    if (managed) {
      const envPath = baseEnv.HAPPY_STACKS_ENV_FILE ?? baseEnv.HAPPY_LOCAL_ENV_FILE ?? '';
      const infra = await ensureHappyServerManagedInfra({
        stackName: autostart.stackName,
        baseDir: autostart.baseDir,
        serverPort,
        publicServerUrl,
        envPath,
        env: baseEnv,
      });

      // Backend runs on a separate port; gateway owns the public port.
      const backendPortRaw = (baseEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT ?? baseEnv.HAPPY_LOCAL_HAPPY_SERVER_BACKEND_PORT ?? '').trim();
      const backendPort = backendPortRaw ? Number(backendPortRaw) : serverPort + 10;
      const backendUrl = `http://127.0.0.1:${backendPort}`;
      if (!stackMode) {
        await killPortListeners(backendPort, { label: 'happy-server-backend' });
      }

      const backendEnv = { ...serverEnv, ...infra.env, PORT: String(backendPort) };
      const autoMigrate = (baseEnv.HAPPY_STACKS_PRISMA_MIGRATE ?? baseEnv.HAPPY_LOCAL_PRISMA_MIGRATE ?? '1') !== '0';
      if (autoMigrate) {
        await applyHappyServerMigrations({ serverDir, env: backendEnv });
      }
      // Account probe should use the *actual* DATABASE_URL/infra env (ephemeral stacks do not persist it in env files).
      const acct = await getAccountCountForServerComponent({
        serverComponentName,
        serverDir,
        env: backendEnv,
        bestEffort: true,
      });
      happyServerAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;

      const backend = await pmSpawnScript({ label: 'server', dir: serverDir, script: 'start', env: backendEnv });
      children.push(backend);
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdate(runtimeStatePath, {
          ports: { server: serverPort, backend: backendPort },
          processes: { happyServerBackendPid: backend.pid },
        }).catch(() => {});
      }
      await waitForServerReady(backendUrl);

      const gatewayArgs = [
        join(rootDir, 'scripts', 'ui_gateway.mjs'),
        `--port=${serverPort}`,
        `--backend-url=${backendUrl}`,
        `--minio-port=${infra.env.S3_PORT}`,
        `--bucket=${infra.env.S3_BUCKET}`,
      ];
      if (serveUi && (await pathExists(uiBuildDir))) {
        gatewayArgs.push(`--ui-dir=${uiBuildDir}`);
      } else {
        gatewayArgs.push('--no-ui');
      }

      const gateway = spawnProc('ui', process.execPath, gatewayArgs, { ...backendEnv, PORT: String(serverPort) }, { cwd: rootDir });
      children.push(gateway);
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdate(runtimeStatePath, { processes: { uiGatewayPid: gateway.pid } }).catch(() => {});
      }
      await waitForServerReady(internalServerUrl);
      effectiveInternalServerUrl = internalServerUrl;

      // Skip default server spawn below
    }
  }

  // Default server start (happy-server-light, or happy-server without managed infra).
  if (!(serverComponentName === 'happy-server' && (baseEnv.HAPPY_STACKS_MANAGED_INFRA ?? baseEnv.HAPPY_LOCAL_MANAGED_INFRA ?? '1') !== '0')) {
    if (!serverAlreadyRunning || restart) {
      const server = await pmSpawnScript({ label: 'server', dir: serverDir, script: 'start', env: serverEnv });
      children.push(server);
      if (stackMode && runtimeStatePath) {
        await recordStackRuntimeUpdate(runtimeStatePath, { processes: { serverPid: server.pid } }).catch(() => {});
      }
      await waitForServerReady(internalServerUrl);
    } else {
      console.log(`[local] server already running at ${internalServerUrl}`);
    }
  }

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
    const localUi = effectiveInternalServerUrl.replace(/\/+$/, '') + '/';
    console.log(`[local] ui served locally at ${localUi}`);
    if (publicServerUrl && publicServerUrl !== effectiveInternalServerUrl && publicServerUrl !== localUi && publicServerUrl !== defaultPublicUrl) {
      const pubUi = publicServerUrl.replace(/\/+$/, '') + '/';
      console.log(`[local] public url: ${pubUi}`);
    }
    if (enableTailscaleServe) {
      console.log('[local] tip: use the HTTPS *.ts.net URL for remote access');
    }

    console.log(
      `[local] tip: to run 'happy' from your terminal *against this local server* (and have sessions show up in the UI), use:\n` +
      `export HAPPY_SERVER_URL=\"${effectiveInternalServerUrl}\"\n` +
      `export HAPPY_HOME_DIR=\"${cliHomeDir}\"\n` +
      `export HAPPY_WEBAPP_URL=\"${publicServerUrl}\"\n`
    );

    // Auto-open UI (interactive only) using the stack-scoped hostname when applicable.
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (isInteractive && !noBrowser) {
      const host = resolveLocalhostHost({ stackMode, stackName: autostart.stackName });
      const prefix = uiPrefix.startsWith('/') ? uiPrefix : `/${uiPrefix}`;
      const openUrl = `http://${host}:${serverPort}${prefix}`;
      const res = await openUrlInBrowser(openUrl);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  // Daemon
  if (startDaemon) {
    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    if (serverComponentName === 'happy-server' && happyServerAccountCount == null) {
      const acct = await getAccountCountForServerComponent({
        serverComponentName,
        serverDir,
        env: serverEnv,
        bestEffort: true,
      });
      happyServerAccountCount = typeof acct.accountCount === 'number' ? acct.accountCount : null;
    }
    const accountCount =
      serverComponentName === 'happy-server-light' ? serverLightAccountCount : happyServerAccountCount;
    await prepareDaemonAuthSeedIfNeeded({
      rootDir,
      env: baseEnv,
      stackName: autostart.stackName,
      cliHomeDir,
      startDaemon,
      isInteractive,
      accountCount,
      quiet: false,
    });
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl: effectiveInternalServerUrl,
      publicServerUrl,
      isShuttingDown: () => shuttingDown,
      forceRestart: restart,
    });
  }

  // Optional: start Expo dev-client Metro for mobile reviewers.
  if (startMobile) {
    await startDevExpoMobile({
      startMobile,
      uiDir,
      autostart,
      baseEnv,
      apiServerUrl: publicServerUrl,
      restart,
      stackMode,
      runtimeStatePath,
      stackName,
      envPath,
      children,
    });
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n[local] shutting down...');

    if (startDaemon) {
        await stopLocalDaemon({ cliBin, internalServerUrl: effectiveInternalServerUrl, cliHomeDir });
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
