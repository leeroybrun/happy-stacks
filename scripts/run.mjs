import { getComponentDir, getDefaultAutostartPaths, getRootDir, killPortListeners, killProcessTree, parseArgs, pathExists, pmSpawnScript, requireDir, run as runCmd, runCapture, spawnProc, waitForServerReady } from './shared.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Run the local stack in "production-like" mode:
 * - happy-server-light
 * - happy-cli daemon
 * - serve prebuilt UI via happy-server-light (/ui)
 *
 * No Expo dev server.
 */

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const rootDir = getRootDir(import.meta.url);

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT
    ? parseInt(process.env.HAPPY_LOCAL_SERVER_PORT, 10)
    : 3005;

  // Internal URL used by local processes on this machine.
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  // Public URL is what you might share/open (e.g. https://<machine>.<tailnet>.ts.net).
  const publicServerUrl = process.env.HAPPY_LOCAL_SERVER_URL?.trim()
    ? process.env.HAPPY_LOCAL_SERVER_URL.trim()
    : internalServerUrl;

  const startDaemon = (process.env.HAPPY_LOCAL_DAEMON ?? '1') !== '0';
  const serveUi = !flags.has('--no-ui') && (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const uiPrefix = process.env.HAPPY_LOCAL_UI_PREFIX?.trim() ? process.env.HAPPY_LOCAL_UI_PREFIX.trim() : '/';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(getDefaultAutostartPaths().baseDir, 'ui');

  const enableTailscaleServe = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';
  const resetTailscaleOnExit = (process.env.HAPPY_LOCAL_TAILSCALE_RESET_ON_EXIT ?? '0') === '1';
  const tailscaleServePath = process.env.HAPPY_LOCAL_TAILSCALE_SERVE_PATH?.trim()
    ? process.env.HAPPY_LOCAL_TAILSCALE_SERVE_PATH.trim()
    : '/';
  const tailscaleUpstream = process.env.HAPPY_LOCAL_TAILSCALE_UPSTREAM?.trim()
    ? process.env.HAPPY_LOCAL_TAILSCALE_UPSTREAM.trim()
    : internalServerUrl;

  const serverDir = getComponentDir(rootDir, 'happy-server-light');
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  await requireDir('happy-server-light', serverDir);
  await requireDir('happy-cli', cliDir);

  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(homedir(), '.happy', 'local', 'cli');

  function cleanupStaleDaemonState(homeDir) {
    const statePath = join(homeDir, 'daemon.state.json');
    const lockPath = join(homeDir, 'daemon.state.json.lock');

    if (!existsSync(lockPath)) {
      return;
    }

    // If we can prove a daemon PID is running, keep the lock.
    if (existsSync(statePath)) {
      try {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        const pid = typeof state?.pid === 'number' ? state.pid : null;
        if (pid) {
          try {
            process.kill(pid, 0);
            return; // daemon is running
          } catch {
            // stale pid
          }
        }
      } catch {
        // corrupt state
      }
    }

    // No running daemon, but lock exists -> stale.
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

  async function waitForCredentialsFile({ path, timeoutMs }) {
    const deadline = Date.now() + timeoutMs;
    while (!shuttingDown && Date.now() < deadline) {
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

  if (serveUi && !(await pathExists(uiBuildDir))) {
    throw new Error(`[local] UI build directory not found at ${uiBuildDir}. Run: pnpm build`);
  }

  const children = [];
  let shuttingDown = false;
  const baseEnv = { ...process.env };

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

  // Optionally enable HTTPS access over Tailscale ("secure context" for WebCrypto).
  if (enableTailscaleServe) {
    try {
      // Newer Tailscale CLI: `tailscale serve --bg [--set-path=/foo] http://127.0.0.1:3005`
      const serveArgs = ['serve', '--bg'];
      if (tailscaleServePath && tailscaleServePath !== '/' && tailscaleServePath !== '') {
        serveArgs.push(`--set-path=${tailscaleServePath}`);
      }
      serveArgs.push(tailscaleUpstream);
      await runCmd('tailscale', serveArgs);
      try {
        const status = await runCapture('tailscale', ['serve', 'status']);
        const line = status
          .split('\n')
          .find((l) => l.toLowerCase().includes('https://'))?.trim();
        if (line) {
          console.log(`[local] tailscale serve enabled: ${line}`);
        } else {
          console.log('[local] tailscale serve enabled');
        }
      } catch {
        console.log('[local] tailscale serve enabled');
      }
    } catch (e) {
      console.error('[local] failed to enable tailscale serve (is Tailscale running/authenticated?):', e);
    }
  }

  if (serveUi) {
    const localUi = internalServerUrl.replace(/\/+$/, '') + '/';
    console.log(`[local] ui served locally at ${localUi}`);
    if (publicServerUrl && publicServerUrl !== internalServerUrl) {
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
    const daemonEnv = {
      ...baseEnv,
      HAPPY_SERVER_URL: internalServerUrl,
      HAPPY_WEBAPP_URL: publicServerUrl,
      HAPPY_HOME_DIR: cliHomeDir,
    };

    // Stop any existing daemon (best-effort) in both legacy and local home dirs.
    const legacyEnv = { ...daemonEnv, HAPPY_HOME_DIR: join(homedir(), '.happy') };
    // Stop any existing daemon (old version / wrong server) before starting a fresh one.
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

    const startDaemonOnce = async () => {
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

    const first = await startDaemonOnce();
    if (!first.ok) {
      if (first.excerpt) {
        console.error(`[local] daemon failed to start; last daemon log (${first.logPath}):\n${first.excerpt}`);
      } else {
        console.error('[local] daemon failed to start; no daemon log found');
      }

      // If this is a first-time local setup, the daemon may need an explicit auth login.
      if (excerptIndicatesMissingAuth(first.excerpt)) {
        console.error(
          `[local] daemon is not authenticated yet (expected on first run).\n` +
          `[local] Keeping the server running so you can login.\n` +
          `[local] In another terminal, run:\n` +
          `HAPPY_HOME_DIR=\"${cliHomeDir}\" HAPPY_SERVER_URL=\"${internalServerUrl}\" HAPPY_WEBAPP_URL=\"${publicServerUrl}\" node \"${cliBin}\" auth login --force\n` +
          `[local] Waiting for credentials at ${credentialsPath}...`
        );

        const ok = await waitForCredentialsFile({ path: credentialsPath, timeoutMs: 10 * 60_000 });
        if (!ok) {
          throw new Error('Timed out waiting for daemon credentials (auth login not completed)');
        }

        console.log('[local] credentials detected, retrying daemon start...');
        const second = await startDaemonOnce();
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
      await runCmd('node', [cliBin, 'daemon', 'status'], { env: daemonEnv });
    } catch {
      // ignore
    }
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
          const proc = spawnProc('daemon', cliBin, ['daemon', 'stop'], {
            ...process.env,
            HAPPY_SERVER_URL: internalServerUrl,
            HAPPY_HOME_DIR: cliHomeDir,
          });
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

    if (enableTailscaleServe && resetTailscaleOnExit) {
      try {
        await runCmd('tailscale', ['serve', 'reset']);
        console.log('[local] tailscale serve reset');
      } catch {
        // ignore
      }
    }
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


