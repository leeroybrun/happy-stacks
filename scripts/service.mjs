import './utils/env.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { getDefaultAutostartPaths, getRootDir, resolveStackEnvPath } from './utils/paths.mjs';
import { ensureMacAutostartDisabled, ensureMacAutostartEnabled } from './utils/pm.mjs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

/**
 * Manage the macOS LaunchAgent installed by `happys bootstrap -- --autostart`.
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
  // - `happys stack service <name> ...` runs under a stack env already, so we persist that pointer.
  //
  // Main installs:
  // - default to the main stack env (outside the repo): ~/.happy/stacks/main/env

  const stacksEnvFile = process.env.HAPPY_STACKS_ENV_FILE?.trim() ? process.env.HAPPY_STACKS_ENV_FILE.trim() : '';
  const localEnvFile = process.env.HAPPY_LOCAL_ENV_FILE?.trim() ? process.env.HAPPY_LOCAL_ENV_FILE.trim() : '';
  const envFile = stacksEnvFile || localEnvFile || resolveStackEnvPath('main').envPath;

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
  // Ensure the env file exists so the service never points at a missing path.
  try {
    const envFile = env.HAPPY_STACKS_ENV_FILE;
    await mkdir(dirname(envFile), { recursive: true });
    if (!existsSync(envFile)) {
      await writeFile(envFile, '', { flag: 'a' });
    }
  } catch {
    // ignore
  }
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

async function restartLaunchAgentBestEffort() {
  const { plistPath, label } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: happys service:install (or happys bootstrap -- --autostart)`);
  }
  const uid = getUid();
  if (uid == null) {
    return false;
  }
  // Prefer kickstart -k to avoid overlapping stop/start windows (which can stop a freshly started daemon).
  return await launchctlTry(['kickstart', '-k', `gui/${uid}/${label}`]);
}

async function startLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: happys service:install (or happys bootstrap -- --autostart)`);
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

async function postStartDiagnostics() {
  const rootDir = getRootDir(import.meta.url);
  const internalUrl = getInternalUrl();

  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(getDefaultAutostartPaths().baseDir, 'cli');

  const publicUrl =
    process.env.HAPPY_LOCAL_SERVER_URL?.trim()
      ? process.env.HAPPY_LOCAL_SERVER_URL.trim()
      : internalUrl.replace('127.0.0.1', 'localhost');

  const cliDir = join(rootDir, 'components', 'happy-cli');
  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  const accessKey = join(cliHomeDir, 'access.key');
  const stateFile = join(cliHomeDir, 'daemon.state.json');
  const lockFile = join(cliHomeDir, 'daemon.state.json.lock');
  const logsDir = join(cliHomeDir, 'logs');

  const readLastLines = async (path, lines = 60) => {
    try {
      const raw = await readFile(path, 'utf-8');
      const parts = raw.split('\n');
      return parts.slice(Math.max(0, parts.length - lines)).join('\n');
    } catch {
      return null;
    }
  };

  const latestDaemonLog = async () => {
    try {
      const ls = await runCapture('bash', ['-lc', `ls -1t "${logsDir}"/*-daemon.log 2>/dev/null | head -1 || true`]);
      const p = ls.trim();
      return p || null;
    } catch {
      return null;
    }
  };

  const checkOnce = async () => {
    // If state exists, trust it.
    if (existsSync(stateFile)) {
      try {
        const raw = await readFile(stateFile, 'utf-8');
        const s = JSON.parse(raw);
        const pid = Number(s?.pid);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            return { ok: true, kind: 'running', pid };
          } catch {
            return { ok: false, kind: 'stale_state', pid };
          }
        }
      } catch {
        return { ok: false, kind: 'bad_state' };
      }
    }

    // No state yet: check lock PID (daemon may be starting or waiting for auth).
    if (existsSync(lockFile)) {
      try {
        const raw = (await readFile(lockFile, 'utf-8')).trim();
        const pid = Number(raw);
        if (Number.isFinite(pid) && pid > 0) {
          try {
            process.kill(pid, 0);
            const logPath = await latestDaemonLog();
            const tail = logPath ? await readLastLines(logPath, 120) : null;
            if (tail && (tail.includes('No credentials found') || tail.includes('authentication flow') || tail.includes('Waiting for credentials'))) {
              return { ok: false, kind: 'auth_required', pid, logPath };
            }
            return { ok: false, kind: 'starting', pid, logPath };
          } catch {
            return { ok: false, kind: 'stale_lock', pid };
          }
        }
      } catch {
        // ignore
      }
    }

    return { ok: false, kind: 'stopped' };
  };

  // Wait briefly for the daemon to settle after a restart.
  let res = await checkOnce();
  for (let i = 0; i < 12 && !res.ok; i++) {
    if (res.kind === 'auth_required') {
      break;
    }
    await new Promise((r) => setTimeout(r, 650));
    // eslint-disable-next-line no-await-in-loop
    res = await checkOnce();
    if (res.ok) {
      break;
    }
  }

  if (res.ok && res.kind === 'running') {
    console.log(`[local] daemon: running (pid=${res.pid})`);
    return;
  }

  // Not running: print actionable diagnostics (without referencing SwiftBar).
  if (res.kind === 'starting') {
    console.log(`[local] daemon: starting (pid=${res.pid ?? 'unknown'})`);
    if (res.logPath) {
      console.log(`[local] daemon log: ${res.logPath}`);
    }
    return;
  }
  if (!existsSync(accessKey)) {
    console.log(`[local] daemon: not running (auth required; missing credentials at ${accessKey})`);
    console.log('[local] authenticate for this stack home with:');
    console.log(
      getDefaultAutostartPaths().stackName === 'main'
        ? 'happys auth login'
        : `happys stack auth ${getDefaultAutostartPaths().stackName} login`
    );
  } else if (res.kind === 'auth_required') {
    console.log(`[local] daemon: waiting for auth (pid=${res.pid})`);
    console.log('[local] authenticate for this stack home with:');
    console.log(
      getDefaultAutostartPaths().stackName === 'main'
        ? 'happys auth login'
        : `happys stack auth ${getDefaultAutostartPaths().stackName} login`
    );
  } else {
    console.log('[local] daemon: not running');
  }

  const logPath = res.logPath ? res.logPath : await latestDaemonLog();
  if (logPath) {
    const tail = await readLastLines(logPath, 80);
    console.log(`[local] last daemon log: ${logPath}`);
    if (tail) {
      console.log('--- last 80 daemon log lines ---');
      console.log(tail);
      console.log('--- end ---');
    }
  } else {
    console.log(`[local] daemon logs dir: ${logsDir}`);
  }
}

async function stopLaunchAgent({ persistent }) {
  const { plistPath } = getDefaultAutostartPaths();
  if (!existsSync(plistPath)) {
    throw new Error(`[local] LaunchAgent plist not found at ${plistPath}. Run: happys service:install (or happys bootstrap -- --autostart)`);
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

async function waitForLaunchAgentStopped({ timeoutMs = 8000 } = {}) {
  const { label } = getDefaultAutostartPaths();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await runCapture('launchctl', ['list']);
      const still = list.split('\n').some((l) => l.includes(`\t${label}`) || l.trim().endsWith(` ${label}`) || l.trim() === label);
      if (!still) {
        return true;
      }
    } catch {
      // ignore
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
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

  const argv = process.argv.slice(2);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] ?? 'help';
  const json = wantsJson(argv);
  if (wantsHelp(argv) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['install', 'uninstall', 'status', 'start', 'stop', 'restart', 'enable', 'disable', 'logs', 'tail'] },
      text: [
        '[service] usage:',
        '  happys service install|uninstall [--json]',
        '  happys service status [--json]',
        '  happys service start|stop|restart [--json]',
        '  happys service enable|disable [--json]',
        '  happys service logs [--json]',
        '  happys service tail',
        '',
        'legacy aliases:',
        '  happys service:install|uninstall|status|start|stop|restart|enable|disable',
        '  happys logs | happys logs:tail',
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
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'start' } });
      return;
    case 'stop':
      await stopLaunchAgent({ persistent: false });
      if (json) printResult({ json, data: { ok: true, action: 'stop' } });
      return;
    case 'restart':
      if (!(await restartLaunchAgentBestEffort())) {
        await stopLaunchAgent({ persistent: false });
        await waitForLaunchAgentStopped();
        await startLaunchAgent({ persistent: false });
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'restart' } });
      return;
    case 'enable':
      await startLaunchAgent({ persistent: true });
      await postStartDiagnostics();
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
