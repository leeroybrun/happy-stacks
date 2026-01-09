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

function getAutostartEnv({ rootDir }) {
  // IMPORTANT:
  // LaunchAgents should NOT bake the entire config into the plist, because that would require
  // reinstalling the service for any config change (server flavor, worktrees, ports, etc).
  //
  // Instead, persist only the env file path; `scripts/utils/env.mjs` will load it on every start.
  //
  // Stack installs:
  // - `pnpm stack service:install <name>` runs `scripts/service.mjs` under a stack env already
  //   (HAPPY_LOCAL_ENV_FILE points at ~/.happy/stacks/<name>/env or legacy path), so we persist that.
  //
  // Main installs:
  // - default to repo `env.local` so server flavor/worktree changes apply on restart without reinstall.

  const stacksEnvFile = process.env.HAPPY_STACKS_ENV_FILE?.trim() ? process.env.HAPPY_STACKS_ENV_FILE.trim() : '';
  const localEnvFile = process.env.HAPPY_LOCAL_ENV_FILE?.trim() ? process.env.HAPPY_LOCAL_ENV_FILE.trim() : '';
  const envFile = stacksEnvFile || localEnvFile || join(rootDir, 'env.local');

  // Persist both prefixes for backwards compatibility.
  return {
    HAPPY_STACKS_ENV_FILE: envFile,
    HAPPY_LOCAL_ENV_FILE: envFile,
  };
}

export async function installService() {
  if (process.platform !== 'darwin') {
    throw new Error('[local] service install is only supported on macOS (LaunchAgents).');
  }
  const rootDir = getRootDir(import.meta.url);
  const { primaryLabel: label } = getDefaultAutostartPaths();
  const env = getAutostartEnv({ rootDir });
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


