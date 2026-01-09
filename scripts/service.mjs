import './utils/env.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { getDefaultAutostartPaths, getRootDir } from './utils/paths.mjs';
import { ensureMacAutostartDisabled, ensureMacAutostartEnabled } from './utils/pm.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';

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
  // If an env file is provided, prefer persisting only its path.
  // This allows changing stack config without reinstalling the LaunchAgent.
  const envFile = process.env.HAPPY_LOCAL_ENV_FILE?.trim() ? process.env.HAPPY_LOCAL_ENV_FILE.trim() : '';
  if (envFile) {
    return { HAPPY_LOCAL_ENV_FILE: envFile };
  }

  const { baseDir } = getDefaultAutostartPaths();

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT?.trim() ? process.env.HAPPY_LOCAL_SERVER_PORT.trim() : '3005';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(baseDir, 'ui');

  const env = {
    HAPPY_LOCAL_SERVER_PORT: String(serverPort),
    HAPPY_LOCAL_SERVER_URL: process.env.HAPPY_LOCAL_SERVER_URL ?? '',
    // Select server implementation (happy-server-light vs happy-server)
    HAPPY_LOCAL_SERVER_COMPONENT: process.env.HAPPY_LOCAL_SERVER_COMPONENT ?? '',
    HAPPY_LOCAL_DAEMON: process.env.HAPPY_LOCAL_DAEMON ?? '1',
    HAPPY_LOCAL_SERVE_UI: process.env.HAPPY_LOCAL_SERVE_UI ?? '1',
    HAPPY_LOCAL_UI_PREFIX: process.env.HAPPY_LOCAL_UI_PREFIX ?? '/',
    HAPPY_LOCAL_UI_BUILD_DIR: uiBuildDir,
    HAPPY_LOCAL_CLI_HOME_DIR: process.env.HAPPY_LOCAL_CLI_HOME_DIR ?? '',
    // Component dir overrides (worktrees / external checkouts).
    HAPPY_LOCAL_COMPONENT_DIR_HAPPY: process.env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY ?? '',
    HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI: process.env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI ?? '',
    HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT: process.env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT ?? '',
    HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER: process.env.HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER ?? '',
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
  const { primaryLabel: label } = getDefaultAutostartPaths();
  const env = getAutostartEnv();
  await ensureMacAutostartEnabled({ rootDir, label, env });
  console.log('[local] service installed (macOS LaunchAgent)');
}

export async function uninstallService() {
  if (process.platform !== 'darwin') {
    return;
  }
  const { primaryPlistPath, legacyPlistPath, primaryLabel, legacyLabel } = getDefaultAutostartPaths();

  // Disable both labels (primary + legacy) best-effort.
  await ensureMacAutostartDisabled({ label: primaryLabel });
  await ensureMacAutostartDisabled({ label: legacyLabel });
  try {
    await rm(primaryPlistPath, { force: true });
  } catch {
    // ignore
  }
  try {
    await rm(legacyPlistPath, { force: true });
  } catch {
    // ignore
  }
  console.log('[local] service uninstalled (plist removed)');
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

  const { label } = getDefaultAutostartPaths();

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
  await launchctlTry(['enable', `gui/${uid}/${label}`]);
  await launchctlTry(['kickstart', '-k', `gui/${uid}/${label}`]);
}

async function stopLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: pnpm service:install (or pnpm bootstrap -- --autostart)`);
  }

  const { label } = getDefaultAutostartPaths();

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
  await launchctlTry(['bootout', `gui/${uid}/${label}`]);
}

async function showStatus() {
  const { plistPath, stdoutPath, stderrPath, label } = getDefaultAutostartPaths();
  const internalUrl = getInternalUrl();

  console.log(`label: ${label}`);
  console.log(`plist: ${plistPath} ${existsSync(plistPath) ? '(present)' : '(missing)'}`);
  console.log(`logs:`);
  console.log(`  stdout: ${stdoutPath}`);
  console.log(`  stderr: ${stderrPath}`);

  try {
    const list = await runCapture('launchctl', ['list']);
    const line = list
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.endsWith(` ${label}`) || l === label || l.includes(`\t${label}`));
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
  const argv = process.argv.slice(2);
  const json = wantsJson(argv);
  if (wantsHelp(argv) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'tail'] },
      text: [
        '[service] usage:',
        '  pnpm service:install [--json]',
        '  pnpm service:uninstall [--json]',
        '  pnpm service:status [--json]',
        '  pnpm service:start|stop|restart [--json]',
        '  pnpm service:enable|disable [--json]',
        '  pnpm logs [--json]',
        '  pnpm logs:tail',
      ].join('\n'),
    });
    return;
  }
  switch (cmd) {
    case 'install':
      await installService();
      if (json) printResult({ json, data: { ok: true, action: 'install' } });
      return;
    case 'uninstall':
      await uninstallService();
      if (json) printResult({ json, data: { ok: true, action: 'uninstall' } });
      return;
    case 'status':
      if (json) {
        const { plistPath, stdoutPath, stderrPath, label } = getDefaultAutostartPaths();
        let launchctlLine = null;
        try {
          const list = await runCapture('launchctl', ['list']);
          launchctlLine =
            list
              .split('\n')
              .map((l) => l.trim())
              .find((l) => l.endsWith(` ${label}`) || l === label || l.includes(`\t${label}`)) ?? null;
        } catch {
          launchctlLine = null;
        }

        const internalUrl = getInternalUrl();
        let health = null;
        try {
          const res = await fetch(`${internalUrl}/health`, { method: 'GET' });
          const body = await res.text();
          health = { ok: res.ok, status: res.status, body: body.trim() };
        } catch {
          health = { ok: false, status: null, body: null };
        }

        printResult({
          json,
          data: { label, plistPath, stdoutPath, stderrPath, internalUrl, launchctlLine, health },
        });
      } else {
        await showStatus();
      }
      return;
    case 'start':
      await startLaunchAgent({ persistent: false });
      if (json) printResult({ json, data: { ok: true, action: 'start' } });
      return;
    case 'stop':
      await stopLaunchAgent({ persistent: false });
      if (json) printResult({ json, data: { ok: true, action: 'stop' } });
      return;
    case 'restart':
      await stopLaunchAgent({ persistent: false });
      await startLaunchAgent({ persistent: false });
      if (json) printResult({ json, data: { ok: true, action: 'restart' } });
      return;
    case 'enable':
      await startLaunchAgent({ persistent: true });
      if (json) printResult({ json, data: { ok: true, action: 'enable' } });
      return;
    case 'disable':
      await stopLaunchAgent({ persistent: true });
      if (json) printResult({ json, data: { ok: true, action: 'disable' } });
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


