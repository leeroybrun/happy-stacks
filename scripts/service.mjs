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
 * Manage the autostart service installed by `happys bootstrap -- --autostart`.
 *
 * - macOS: launchd LaunchAgents
 * - Linux: systemd user services
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
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('[local] service install is only supported on macOS (launchd) and Linux (systemd user).');
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
  if (process.platform === 'darwin') {
    await ensureMacAutostartEnabled({ rootDir, label, env });
    console.log('[local] service installed (macOS launchd)');
    return;
  }
  await ensureSystemdUserServiceEnabled({ rootDir, label, env });
  console.log('[local] service installed (Linux systemd --user)');
}

export async function uninstallService() {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return;

  if (process.platform === 'linux') {
    await ensureSystemdUserServiceDisabled({ remove: true });
    console.log('[local] service uninstalled (systemd user unit removed)');
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

function systemdUnitName() {
  const { label } = getDefaultAutostartPaths();
  return `${label}.service`;
}

function systemdUnitPath() {
  return join(homedir(), '.config', 'systemd', 'user', systemdUnitName());
}

function systemdEnvLines(env) {
  return Object.entries(env)
    .map(([k, v]) => `Environment=${k}=${String(v)}`)
    .join('\n');
}

async function ensureSystemdUserServiceEnabled({ rootDir, label, env }) {
  const unitPath = systemdUnitPath();
  await mkdir(dirname(unitPath), { recursive: true });
  const happysShim = join(homedir(), '.happy-stacks', 'bin', 'happys');
  const entry = existsSync(happysShim) ? happysShim : join(rootDir, 'bin', 'happys.mjs');
  const exec = existsSync(happysShim) ? entry : `${process.execPath} ${entry}`;

  const unit = `[Unit]
Description=Happy Stacks (${label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=%h
${systemdEnvLines(env)}
ExecStart=${exec} start
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
`;

  await writeFile(unitPath, unit, 'utf-8');
  await runCapture('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  await run('systemctl', ['--user', 'enable', '--now', systemdUnitName()]);
}

async function ensureSystemdUserServiceDisabled({ remove } = {}) {
  await runCapture('systemctl', ['--user', 'disable', '--now', systemdUnitName()]).catch(() => {});
  await runCapture('systemctl', ['--user', 'stop', systemdUnitName()]).catch(() => {});
  if (remove) {
    await rm(systemdUnitPath(), { force: true }).catch(() => {});
    await runCapture('systemctl', ['--user', 'daemon-reload']).catch(() => {});
  }
}

async function systemdStatus() {
  await run('systemctl', ['--user', 'status', systemdUnitName(), '--no-pager']);
}

async function systemdStart({ persistent }) {
  if (persistent) {
    await run('systemctl', ['--user', 'enable', '--now', systemdUnitName()]);
  } else {
    await run('systemctl', ['--user', 'start', systemdUnitName()]);
  }
}

async function systemdStop({ persistent }) {
  if (persistent) {
    await run('systemctl', ['--user', 'disable', '--now', systemdUnitName()]);
  } else {
    await run('systemctl', ['--user', 'stop', systemdUnitName()]);
  }
}

async function systemdRestart() {
  await run('systemctl', ['--user', 'restart', systemdUnitName()]);
}

async function systemdLogs({ lines = 120 } = {}) {
  await run('journalctl', ['--user', '-u', systemdUnitName(), '-n', String(lines), '--no-pager']);
}

async function systemdTail() {
  await run('journalctl', ['--user', '-u', systemdUnitName(), '-f']);
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
    // Service isn't installed for this stack (common for ad-hoc stacks). Treat as a no-op.
    return;
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
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new Error('[local] service commands are only supported on macOS (launchd) and Linux (systemd user).');
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
        const internalUrl = getInternalUrl();
        let health = null;
        try {
          const res = await fetch(`${internalUrl}/health`, { method: 'GET' });
          const body = await res.text();
          health = { ok: res.ok, status: res.status, body: body.trim() };
        } catch {
          health = { ok: false, status: null, body: null };
        }

        if (process.platform === 'darwin') {
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
          printResult({ json, data: { label, plistPath, stdoutPath, stderrPath, internalUrl, launchctlLine, health } });
        } else {
          const unitName = systemdUnitName();
          const unitPath = systemdUnitPath();
          let systemctlStatus = null;
          try {
            systemctlStatus = await runCapture('systemctl', ['--user', 'status', unitName, '--no-pager']);
          } catch (e) {
            systemctlStatus = e && typeof e === 'object' && 'out' in e ? e.out : null;
          }
          printResult({ json, data: { unitName, unitPath, internalUrl, systemctlStatus, health } });
        }
      } else {
        if (process.platform === 'darwin') {
          await showStatus();
        } else {
          await systemdStatus();
        }
      }
      return;
    case 'start':
      if (process.platform === 'darwin') {
        await startLaunchAgent({ persistent: false });
      } else {
        await systemdStart({ persistent: false });
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'start' } });
      return;
    case 'stop':
      if (process.platform === 'darwin') {
        await stopLaunchAgent({ persistent: false });
      } else {
        await systemdStop({ persistent: false });
      }
      if (json) printResult({ json, data: { ok: true, action: 'stop' } });
      return;
    case 'restart':
      if (process.platform === 'darwin') {
        if (!(await restartLaunchAgentBestEffort())) {
          await stopLaunchAgent({ persistent: false });
          await waitForLaunchAgentStopped();
          await startLaunchAgent({ persistent: false });
        }
      } else {
        await systemdRestart();
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'restart' } });
      return;
    case 'enable':
      if (process.platform === 'darwin') {
        await startLaunchAgent({ persistent: true });
      } else {
        await systemdStart({ persistent: true });
      }
      await postStartDiagnostics();
      if (json) printResult({ json, data: { ok: true, action: 'enable' } });
      return;
    case 'disable':
      if (process.platform === 'darwin') {
        await stopLaunchAgent({ persistent: true });
      } else {
        await systemdStop({ persistent: true });
      }
      if (json) printResult({ json, data: { ok: true, action: 'disable' } });
      return;
    case 'logs':
      if (process.platform === 'darwin') {
        await showLogs();
      } else {
        const lines = Number(process.env.HAPPY_STACKS_LOG_LINES ?? process.env.HAPPY_LOCAL_LOG_LINES ?? 120) || 120;
        await systemdLogs({ lines });
      }
      return;
    case 'tail':
      if (process.platform === 'darwin') {
        await tailLogs();
      } else {
        await systemdTail();
      }
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
