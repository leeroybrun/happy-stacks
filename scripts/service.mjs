import {
  ensureMacAutostartDisabled,
  ensureMacAutostartEnabled,
  getDefaultAutostartPaths,
  getRootDir,
  run,
  runCapture,
} from './shared.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Manage the macOS LaunchAgent installed by `pnpm bootstrap -- --autostart`.
 *
 * Commands:
 * - install | uninstall
 * - status
 * - start | stop | restart
 * - enable | disable (same as start/stop but explicitly persistent)
 * - logs (print last N lines)
 * - tail (follow logs)
 */

const LABEL = 'com.happy.local';

function getUid() {
  // Prefer env var if present; otherwise fall back.
  // (LaunchAgents run in a user context so this is fine.)
  const n = Number(process.env.UID);
  return Number.isFinite(n) ? n : null;
}

function getInternalUrl() {
  const port = process.env.HAPPY_LOCAL_SERVER_PORT?.trim() ? Number(process.env.HAPPY_LOCAL_SERVER_PORT) : 3005;
  return `http://127.0.0.1:${port}`;
}

function getAutostartEnv() {
  const { baseDir } = getDefaultAutostartPaths();

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT?.trim() ? process.env.HAPPY_LOCAL_SERVER_PORT.trim() : '3005';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(baseDir, 'ui');

  const env = {
    HAPPY_LOCAL_SERVER_PORT: String(serverPort),
    HAPPY_LOCAL_SERVER_URL: process.env.HAPPY_LOCAL_SERVER_URL ?? '',
    HAPPY_LOCAL_DAEMON: process.env.HAPPY_LOCAL_DAEMON ?? '1',
    HAPPY_LOCAL_SERVE_UI: process.env.HAPPY_LOCAL_SERVE_UI ?? '1',
    HAPPY_LOCAL_UI_PREFIX: process.env.HAPPY_LOCAL_UI_PREFIX ?? '/',
    HAPPY_LOCAL_UI_BUILD_DIR: uiBuildDir,
    HAPPY_LOCAL_CLI_HOME_DIR: process.env.HAPPY_LOCAL_CLI_HOME_DIR ?? '',
    // Optional: Tailscale Serve (secure context / remote access).
    HAPPY_LOCAL_TAILSCALE_SERVE: process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '',
    HAPPY_LOCAL_TAILSCALE_SERVE_PATH: process.env.HAPPY_LOCAL_TAILSCALE_SERVE_PATH ?? '',
    HAPPY_LOCAL_TAILSCALE_UPSTREAM: process.env.HAPPY_LOCAL_TAILSCALE_UPSTREAM ?? '',
    HAPPY_LOCAL_TAILSCALE_RESET_ON_EXIT: process.env.HAPPY_LOCAL_TAILSCALE_RESET_ON_EXIT ?? '',
    HAPPY_LOCAL_TAILSCALE_PREFER_PUBLIC_URL: process.env.HAPPY_LOCAL_TAILSCALE_PREFER_PUBLIC_URL ?? '',
    HAPPY_LOCAL_TAILSCALE_BIN: process.env.HAPPY_LOCAL_TAILSCALE_BIN ?? '',
    // If you use a custom env file, persist it for the LaunchAgent too.
    HAPPY_LOCAL_ENV_FILE: process.env.HAPPY_LOCAL_ENV_FILE ?? '',
  };

  // Drop empty env vars (LaunchAgent env dict is annoying with blanks)
  for (const [k, v] of Object.entries(env)) {
    if (!String(v).trim()) {
      delete env[k];
    }
  }

  return env;
}

export async function installService() {
  if (process.platform !== 'darwin') {
    throw new Error('[local] service install is only supported on macOS (LaunchAgents).');
  }
  const rootDir = getRootDir(import.meta.url);
  const env = getAutostartEnv();
  await ensureMacAutostartEnabled({ rootDir, env });
  console.log('[local] service installed (macOS LaunchAgent)');
}

export async function uninstallService() {
  if (process.platform !== 'darwin') {
    return;
  }
  const { plistPath } = getDefaultAutostartPaths();
  await ensureMacAutostartDisabled({});
  try {
    await rm(plistPath, { force: true });
    console.log('[local] service uninstalled (plist removed)');
  } catch {
    // ignore
  }
}

async function launchctlTry(args) {
  try {
    await runCapture('launchctl', args);
    return true;
  } catch {
    return false;
  }
}

async function startLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: pnpm service:install (or pnpm bootstrap -- --autostart)`);
  }

  // Old-style (works on many systems)
  if (persistent) {
    if (await launchctlTry(['load', '-w', plistPath])) {
      return;
    }
  } else {
    if (await launchctlTry(['load', plistPath])) {
      return;
    }
  }

  // Modern fallback (more reliable on newer macOS)
  const uid = getUid();
  if (uid == null) {
    throw new Error('[local] Unable to determine UID for launchctl bootstrap.');
  }

  // bootstrap requires the plist
  await run('launchctl', ['bootstrap', `gui/${uid}`, plistPath]);
  await launchctlTry(['enable', `gui/${uid}/${LABEL}`]);
  await launchctlTry(['kickstart', '-k', `gui/${uid}/${LABEL}`]);
}

async function stopLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: pnpm service:install (or pnpm bootstrap -- --autostart)`);
  }

  // Old-style
  if (persistent) {
    if (await launchctlTry(['unload', '-w', plistPath])) {
      return;
    }
  } else {
    if (await launchctlTry(['unload', plistPath])) {
      return;
    }
  }

  // Modern fallback
  const uid = getUid();
  if (uid == null) {
    return;
  }
  await launchctlTry(['bootout', `gui/${uid}/${LABEL}`]);
}

async function showStatus() {
  const { plistPath, stdoutPath, stderrPath } = getDefaultAutostartPaths();
  const internalUrl = getInternalUrl();

  console.log(`label: ${LABEL}`);
  console.log(`plist: ${plistPath} ${existsSync(plistPath) ? '(present)' : '(missing)'}`);
  console.log(`logs:`);
  console.log(`  stdout: ${stdoutPath}`);
  console.log(`  stderr: ${stderrPath}`);

  try {
    const list = await runCapture('launchctl', ['list']);
    const line = list
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.endsWith(` ${LABEL}`) || l === LABEL || l.includes(`\t${LABEL}`));
    console.log(`launchctl: ${line ? line : '(not listed)'}`);
  } catch {
    console.log('launchctl: (unable to query)');
  }

  // Health can briefly be unavailable right after install/restart; retry a bit.
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      const res = await fetch(`${internalUrl}/health`, { method: 'GET' });
      const body = await res.text();
      console.log(`health: ${res.status} ${body.trim()}`);
      break;
    } catch {
      if (Date.now() >= deadline) {
        console.log(`health: unreachable (${internalUrl})`);
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}

async function showLogs(lines = 120) {
  const { stdoutPath, stderrPath } = getDefaultAutostartPaths();
  // Use tail if available.
  await run('tail', ['-n', String(lines), stderrPath, stdoutPath]);
}

async function tailLogs() {
  const { stdoutPath, stderrPath } = getDefaultAutostartPaths();
  const child = spawn('tail', ['-f', stderrPath, stdoutPath], { stdio: 'inherit' });
  await new Promise((resolve) => child.on('exit', resolve));
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('[local] service commands are only supported on macOS (LaunchAgents).');
  }

  const cmd = process.argv[2] || 'status';
  switch (cmd) {
    case 'install':
      await installService();
      return;
    case 'uninstall':
      await uninstallService();
      return;
    case 'status':
      await showStatus();
      return;
    case 'start':
      await startLaunchAgent({ persistent: false });
      return;
    case 'stop':
      await stopLaunchAgent({ persistent: false });
      return;
    case 'restart':
      await stopLaunchAgent({ persistent: false });
      await startLaunchAgent({ persistent: false });
      return;
    case 'enable':
      await startLaunchAgent({ persistent: true });
      return;
    case 'disable':
      await stopLaunchAgent({ persistent: true });
      return;
    case 'logs':
      await showLogs();
      return;
    case 'tail':
      await tailLogs();
      return;
    default:
      throw new Error(`[local] unknown command: ${cmd}`);
  }
}

function isDirectExecution() {
  try {
    const selfPath = resolve(fileURLToPath(import.meta.url));
    const argvPath = process.argv[1] ? resolve(process.argv[1]) : '';
    return selfPath === argvPath;
  } catch {
    return false;
  }
}

if (isDirectExecution()) {
  main().catch((err) => {
    console.error('[local] failed:', err);
    process.exit(1);
  });
}


