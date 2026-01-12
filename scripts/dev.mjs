import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { killProcessTree } from './utils/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths.mjs';
import { killPortListeners, pickNextFreeTcpPort } from './utils/ports.mjs';
import { getServerComponentName, isHappyServerRunning, waitForServerReady } from './utils/server.mjs';
import { ensureDepsInstalled, pmSpawnBin, pmSpawnScript, requireDir } from './utils/pm.mjs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { homedir } from 'node:os';
import { isDaemonRunning, startLocalDaemonWithAuth, stopLocalDaemon } from './daemon.mjs';
import { resolvePublicServerUrl } from './tailscale.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { assertServerComponentDirMatches, assertServerPrismaProviderMatches } from './utils/validate.mjs';
import { applyHappyServerMigrations, ensureHappyServerManagedInfra } from './utils/happy_server_infra.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, isStateProcessRunning, killPid, wantsExpoClearCache, writePidState } from './utils/expo.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from './utils/stack_startup.mjs';

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
      data: { flags: ['--server=happy-server|happy-server-light', '--no-ui', '--no-daemon', '--restart'], json: true },
      text: [
        '[dev] usage:',
        '  happys dev [--server=happy-server|happy-server-light] [--restart] [--json]',
        '  note: --json prints the resolved config (dry-run) and exits.',
      ].join('\n'),
    });
    return;
  }
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

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for dev (pick one: happy-server-light or happy-server)`);
  }

  const startUi = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_UI ?? '1') !== '0';
  const startDaemon = !flags.has('--no-daemon') && (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';

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
  const baseEnv = { ...process.env };

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

  // Start server (only if not already healthy)
  if (!serverAlreadyRunning || restart) {
    await killPortListeners(serverPort, { label: 'server' });
  }
  const serverEnv = {
    ...baseEnv,
    PORT: String(serverPort),
    PUBLIC_URL: publicServerUrl,
    // Avoid noisy failures if a previous run left the metrics port busy.
    METRICS_ENABLED: baseEnv.METRICS_ENABLED ?? 'false',
  };
  if (serverComponentName === 'happy-server-light') {
    const dataDir = baseEnv.HAPPY_SERVER_LIGHT_DATA_DIR?.trim()
      ? baseEnv.HAPPY_SERVER_LIGHT_DATA_DIR.trim()
      : join(autostart.baseDir, 'server-light');
    serverEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    serverEnv.HAPPY_SERVER_LIGHT_FILES_DIR = baseEnv.HAPPY_SERVER_LIGHT_FILES_DIR?.trim()
      ? baseEnv.HAPPY_SERVER_LIGHT_FILES_DIR.trim()
      : join(dataDir, 'files');
  }
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
      Object.assign(serverEnv, infra.env);
    }

    const autoMigrate = (baseEnv.HAPPY_STACKS_PRISMA_MIGRATE ?? baseEnv.HAPPY_LOCAL_PRISMA_MIGRATE ?? '1') !== '0';
    if (autoMigrate) {
      await applyHappyServerMigrations({ serverDir, env: serverEnv });
    }
  }
  await ensureDepsInstalled(serverDir, serverComponentName);

  // Reliability:
  // - Ensure schema exists (server-light: db push; happy-server: migrate deploy if tables missing)
  // - Auto-seed from main only when needed (non-main + non-interactive default, and only if missing creds or 0 accounts)
  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const acct = await getAccountCountForServerComponent({
    serverComponentName,
    serverDir,
    env: serverEnv,
    bestEffort: serverComponentName === 'happy-server',
  });
  await prepareDaemonAuthSeedIfNeeded({
    rootDir,
    env: baseEnv,
    stackName: autostart.stackName,
    cliHomeDir,
    startDaemon,
    isInteractive,
    accountCount: typeof acct.accountCount === 'number' ? acct.accountCount : null,
    quiet: false,
  });
  // For happy-server: the upstream `dev` script is not stack-safe (kills fixed ports, reads .env.dev).
  // Use `start` and rely on stack-scoped env + optional migrations above.
  //
  // For happy-server-light: the upstream `dev` script runs `prisma db push` automatically. If you want to skip
  // it (e.g. big sqlite DB), set HAPPY_STACKS_PRISMA_PUSH=0 to use `start` even in dev mode.
  const prismaPush = (baseEnv.HAPPY_STACKS_PRISMA_PUSH ?? baseEnv.HAPPY_LOCAL_PRISMA_PUSH ?? '1').trim() !== '0';
  const serverScript =
    serverComponentName === 'happy-server'
      ? 'start'
      : serverComponentName === 'happy-server-light' && !prismaPush
        ? 'start'
        : 'dev';
  if (!serverAlreadyRunning || restart) {
    const server = await pmSpawnScript({ label: 'server', dir: serverDir, script: serverScript, env: serverEnv });
    children.push(server);
    await waitForServerReady(internalServerUrl);
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

  // Start daemon (detached daemon process managed by happy-cli)
  if (startDaemon) {
    await startLocalDaemonWithAuth({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
      isShuttingDown: () => shuttingDown,
      forceRestart: restart,
    });
  }

  // Start UI (Expo web dev server)
  if (startUi) {
    await ensureDepsInstalled(uiDir, 'happy');
    const uiEnv = { ...baseEnv };
    delete uiEnv.CI;
    uiEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = publicServerUrl;
    uiEnv.EXPO_PUBLIC_DEBUG = uiEnv.EXPO_PUBLIC_DEBUG ?? '1';

    await ensureExpoIsolationEnv({
      env: uiEnv,
      stateDir: uiPaths.stateDir,
      expoHomeDir: uiPaths.expoHomeDir,
      tmpDir: uiPaths.tmpDir,
    });

    // Expo uses Metro (default 8081). If it's already used by another worktree/stack,
    // Expo prompts to pick another port, which fails in non-interactive mode.
    // Pick a free port up-front to make LLM/CI/service runs reliable.
    const defaultMetroPort = 8081;
    const metroPort = await pickNextFreeTcpPort(defaultMetroPort);
    uiEnv.RCT_METRO_PORT = String(metroPort);
    // eslint-disable-next-line no-console
    console.log(`[local] ui: starting Expo web (metro port=${metroPort})`);

    const uiArgs = ['start', '--web', '--port', String(metroPort)];
    if (wantsExpoClearCache({ env: baseEnv })) {
      uiArgs.push('--clear');
    }

    if (!uiAlreadyRunning || restart) {
      if (restart && uiRunning.state?.pid) {
        const prevPid = Number(uiRunning.state.pid);
        const prevPort = Number(uiRunning.state.port);
        if (Number.isFinite(prevPort) && prevPort > 0) {
          await killPortListeners(prevPort, { label: 'ui' });
        }
        await killPid(prevPid);
        uiAlreadyRunning = false;
      }
      const ui = await pmSpawnBin({ label: 'ui', dir: uiDir, bin: 'expo', args: uiArgs, env: uiEnv });
      children.push(ui);
      try {
        await writePidState(uiPaths.statePath, { pid: ui.pid, port: metroPort, uiDir, startedAt: new Date().toISOString() });
      } catch {
        // ignore
      }
    } else {
      console.log('[local] ui already running (skipping Expo start)');
    }
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
