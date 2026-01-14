import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { killProcessTree } from './utils/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths.mjs';
import { killPortListeners } from './utils/ports.mjs';
import { getServerComponentName, isHappyServerRunning } from './utils/server.mjs';
import { requireDir } from './utils/pm.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { isDaemonRunning, stopLocalDaemon } from './daemon.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/validate.mjs';
import { getExpoStatePaths, isStateProcessRunning } from './utils/expo.mjs';
import { isPidAlive, readStackRuntimeStateFile, recordStackRuntimeStart } from './utils/stack_runtime_state.mjs';
import { resolveStackContext } from './utils/stack_context.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server_urls.mjs';
import { ensureDevCliReady, prepareDaemonAuthSeed, startDevDaemon, watchHappyCliAndRestartDaemon } from './utils/dev_daemon.mjs';
import { startDevServer, watchDevServerAndRestart } from './utils/dev_server.mjs';
import { startDevExpoWebUi } from './utils/dev_expo_web.mjs';
import { resolveLocalhostHost } from './utils/localhost_host.mjs';
import { openUrlInBrowser } from './utils/browser.mjs';
import { waitForHttpOk } from './utils/server.mjs';

function sanitizeDnsLabel(raw, { fallback = 'stack' } = {}) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return s || fallback;
}

/**
 * Dev mode stack:
 * - happy-server-light
 * - happy-cli daemon
 * - Expo web dev server (watch/reload)
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--server=happy-server|happy-server-light', '--no-ui', '--no-daemon', '--restart', '--watch', '--no-watch', '--no-browser'], json: true },
      text: [
        '[dev] usage:',
        '  happys dev [--server=happy-server|happy-server-light] [--restart] [--json]',
        '  happys dev --watch      # rebuild/restart happy-cli daemon on file changes (TTY default)',
        '  happys dev --no-watch   # disable watch mode (always disabled in non-interactive mode)',
        '  happys dev --no-browser # do not open the UI in your browser automatically',
        '  note: --json prints the resolved config (dry-run) and exits.',
      ].join('\n'),
    });
    return;
  }
  const rootDir = getRootDir(import.meta.url);

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for dev (pick one: happy-server-light or happy-server)`);
  }

  const startUi = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_UI ?? '1') !== '0';
  const startDaemon = !flags.has('--no-daemon') && (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';
  const noBrowser = flags.has('--no-browser') || (process.env.HAPPY_STACKS_NO_BROWSER ?? process.env.HAPPY_LOCAL_NO_BROWSER ?? '').toString().trim() === '1';

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const uiDir = getComponentDir(rootDir, 'happy');
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });
  assertServerPrismaProviderMatches({ serverComponentName, serverDir });

  await requireDir(serverComponentName, serverDir);
  await requireDir('happy', uiDir);
  await requireDir('happy-cli', cliDir);

  const cliBin = join(cliDir, 'bin', 'happy.mjs');
  const autostart = getDefaultAutostartPaths();
  const baseEnv = { ...process.env };
  const stackCtx = resolveStackContext({ env: baseEnv, autostart });
  const { stackMode, runtimeStatePath, stackName, envPath, ephemeral } = stackCtx;

  const serverPort = resolveServerPortFromEnv({ env: baseEnv, defaultPort: 3005 });
  // IMPORTANT:
  // - Only the main stack should ever auto-enable (or prefer) Tailscale Serve by default.
  // - Non-main stacks should default to localhost URLs unless the user explicitly configured a public URL
  //   OR Tailscale Serve is already configured for this stack's internal URL (status matches).
  const allowEnableTailscale = !stackMode || stackName === 'main';
  const resolvedUrls = await resolveServerUrls({ env: baseEnv, serverPort, allowEnable: allowEnableTailscale });
  const internalServerUrl = resolvedUrls.internalServerUrl;
  let publicServerUrl = resolvedUrls.publicServerUrl;
  if (stackMode && stackName !== 'main' && !resolvedUrls.envPublicUrl) {
    const src = String(resolvedUrls.publicServerUrlSource ?? '');
    const hasStackScopedTailscale = src.startsWith('tailscale-');
    if (!hasStackScopedTailscale) {
      publicServerUrl = resolvedUrls.defaultPublicUrl;
    }
  }
  const uiApiUrl = resolvedUrls.defaultPublicUrl;
  const restart = flags.has('--restart');
  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(autostart.baseDir, 'cli');

  if (json) {
    printResult({
      json,
      data: {
        mode: 'dev',
        serverComponentName,
        serverDir,
        uiDir,
        cliDir,
        serverPort,
        internalServerUrl,
        publicServerUrl,
        startUi,
        startDaemon,
        cliHomeDir,
      },
    });
    return;
  }

  const children = [];
  let shuttingDown = false;

  // Ensure happy-cli is install+build ready before starting the daemon.
  // Worktrees often don't have dist/ built yet, which causes MODULE_NOT_FOUND on dist/index.mjs.
  const buildCli = (baseEnv.HAPPY_STACKS_CLI_BUILD ?? baseEnv.HAPPY_LOCAL_CLI_BUILD ?? '1').toString().trim() !== '0';
  await ensureDevCliReady({ cliDir, buildCli });

  // Watch mode (interactive only by default): rebuild happy-cli and restart daemon when code changes.
  const watchEnabled =
    flags.has('--watch') || (!flags.has('--no-watch') && Boolean(process.stdin.isTTY && process.stdout.isTTY));
  const watchers = [];

  const serverAlreadyRunning = await isHappyServerRunning(internalServerUrl);
  const daemonAlreadyRunning = startDaemon ? isDaemonRunning(cliHomeDir) : false;

  // UI dev server state (worktree-scoped)
  const uiPaths = getExpoStatePaths({ baseDir: autostart.baseDir, kind: 'ui-dev', projectDir: uiDir, stateFileName: 'ui.state.json' });
  const uiRunning = startUi ? await isStateProcessRunning(uiPaths.statePath) : { running: false, state: null };
  let uiAlreadyRunning = Boolean(uiRunning.running);

  if (!restart && serverAlreadyRunning && (!startDaemon || daemonAlreadyRunning) && (!startUi || uiAlreadyRunning)) {
    console.log(`[local] dev: stack already running (server=${internalServerUrl}${startDaemon ? ` daemon=${daemonAlreadyRunning ? 'running' : 'stopped'}` : ''}${startUi ? ` ui=${uiAlreadyRunning ? 'running' : 'stopped'}` : ''})`);
    return;
  }

  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeStart(runtimeStatePath, {
      stackName,
      script: 'dev.mjs',
      ephemeral,
      ownerPid: process.pid,
      ports: { server: serverPort },
    }).catch(() => {});
  }

  // Start server (only if not already healthy)
  // NOTE: In stack mode we avoid killing arbitrary port listeners (fail-closed instead).
  if ((!serverAlreadyRunning || restart) && !stackMode) {
    await killPortListeners(serverPort, { label: 'server' });
  }

  const { serverEnv, serverScript, serverProc } = await startDevServer({
    serverComponentName,
    serverDir,
    autostart,
    baseEnv,
    serverPort,
    internalServerUrl,
    publicServerUrl,
    envPath,
    stackMode,
    runtimeStatePath,
    serverAlreadyRunning,
    restart,
    children,
  });

  if (!serverAlreadyRunning || restart) {
    console.log(`[local] server ready at ${internalServerUrl}`);
  } else {
    console.log(`[local] server already running at ${internalServerUrl}`);
  }
  console.log(
    `[local] tip: to run 'happy' from your terminal *against this local server* (and have sessions show up in the UI), use:\n` +
    `export HAPPY_SERVER_URL=\"${internalServerUrl}\"\n` +
      `export HAPPY_HOME_DIR=\"${cliHomeDir}\"\n` +
    `export HAPPY_WEBAPP_URL=\"${publicServerUrl}\"\n`
  );

  // Reliability before daemon start:
  // - Ensure schema exists (server-light: db push; happy-server: migrate deploy if tables missing)
  // - Auto-seed from main only when needed (non-main + non-interactive default, and only if missing creds or 0 accounts)
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  await prepareDaemonAuthSeed({
    rootDir,
    env: baseEnv,
    stackName,
    cliHomeDir,
    startDaemon,
    isInteractive,
    serverComponentName,
    serverDir,
    serverEnv,
    quiet: false,
  });

  await startDevDaemon({
    startDaemon,
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    restart,
    isShuttingDown: () => shuttingDown,
  });

  const cliWatcher = watchHappyCliAndRestartDaemon({
    enabled: watchEnabled,
    startDaemon,
    buildCli,
    cliDir,
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown: () => shuttingDown,
  });
  if (cliWatcher) watchers.push(cliWatcher);

  const serverProcRef = { current: serverProc };
  if (stackMode && runtimeStatePath && !serverProcRef.current?.pid) {
    // If the server was already running when we started dev, `startDevServer` won't spawn a new process
    // (and therefore we don't have a ChildProcess handle). For safe watch/restart we need a PID.
    const state = await readStackRuntimeStateFile(runtimeStatePath);
    const pid = state?.processes?.serverPid;
    if (isPidAlive(pid)) {
      serverProcRef.current = { pid: Number(pid), exitCode: null };
    }
  }
  const serverWatcher = watchDevServerAndRestart({
    enabled: watchEnabled && Boolean(serverProcRef.current?.pid),
    stackMode,
    serverComponentName,
    serverDir,
    serverPort,
    internalServerUrl,
    serverScript,
    serverEnv,
    runtimeStatePath,
    stackName,
    envPath,
    children,
    serverProcRef,
    isShuttingDown: () => shuttingDown,
  });
  if (serverWatcher) watchers.push(serverWatcher);
  if (watchEnabled && stackMode && serverComponentName === 'happy-server' && !serverWatcher) {
    console.warn(
      `[local] watch: server restart is disabled because the running server PID is unknown.\n` +
        `[local] watch: fix: re-run with --restart so Happy Stacks can (re)spawn the server and track its PID.`
    );
  }

  const uiRes = await startDevExpoWebUi({
    startUi,
    uiDir,
    autostart,
    baseEnv,
    apiServerUrl: uiApiUrl,
    restart,
    stackMode,
    runtimeStatePath,
    stackName,
    envPath,
    children,
  });
  if (startUi) {
    const host = resolveLocalhostHost({ stackMode, stackName });
    if (uiRes?.reason === 'already_running' && uiRes.port) {
      console.log(`[local] ui already running (pid=${uiRes.pid}, port=${uiRes.port})`);
      console.log(`[local] ui: open http://${host}:${uiRes.port}`);
    } else if (uiRes?.skipped === false && uiRes.port) {
      console.log(`[local] ui: open http://${host}:${uiRes.port}`);
    } else if (uiRes?.skipped && uiRes?.reason === 'already_running') {
      console.log('[local] ui already running (skipping Expo start)');
    }

    const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const shouldOpen = isInteractive && !noBrowser && Boolean(uiRes?.port);
    if (shouldOpen) {
      const url = `http://${host}:${uiRes.port}`;
      // Prefer localhost for readiness checks (faster/more reliable), but open the stack-scoped hostname.
      await waitForHttpOk(`http://localhost:${uiRes.port}`, { timeoutMs: 30_000 }).catch(() => {});
      const res = await openUrlInBrowser(url);
      if (!res.ok) {
        console.warn(`[local] ui: failed to open browser automatically (${res.error}).`);
      }
    }
  }

  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    console.log('\n[local] shutting down...');

    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // ignore
      }
    }

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
