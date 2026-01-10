import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir, getStackName } from './utils/paths.mjs';
import { resolvePublicServerUrl } from './tailscale.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';

function getInternalServerUrl() {
  const portRaw = (process.env.HAPPY_LOCAL_SERVER_PORT ?? process.env.HAPPY_STACKS_SERVER_PORT ?? '').trim();
  const port = portRaw ? Number(portRaw) : 3005;
  const n = Number.isFinite(port) ? port : 3005;
  return { port: n, url: `http://127.0.0.1:${n}` };
}

function expandTilde(p) {
  return p.replace(/^~(?=\/)/, homedir());
}

function resolveCliHomeDir() {
  const fromEnv = (process.env.HAPPY_LOCAL_CLI_HOME_DIR ?? process.env.HAPPY_STACKS_CLI_HOME_DIR ?? '').trim();
  if (fromEnv) {
    return expandTilde(fromEnv);
  }
  return join(getDefaultAutostartPaths().baseDir, 'cli');
}

function fileHasContent(path) {
  try {
    if (!existsSync(path)) return false;
    return readFileSync(path, 'utf-8').trim().length > 0;
  } catch {
    return false;
  }
}

function checkDaemonState(cliHomeDir) {
  const statePath = join(cliHomeDir, 'daemon.state.json');
  const lockPath = join(cliHomeDir, 'daemon.state.json.lock');

  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };

  if (existsSync(statePath)) {
    try {
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      const pid = Number(state?.pid);
      if (Number.isFinite(pid) && pid > 0) {
        return alive(pid) ? { status: 'running', pid } : { status: 'stale_state', pid };
      }
      return { status: 'bad_state' };
    } catch {
      return { status: 'bad_state' };
    }
  }

  if (existsSync(lockPath)) {
    try {
      const pid = Number(readFileSync(lockPath, 'utf-8').trim());
      if (Number.isFinite(pid) && pid > 0) {
        return alive(pid) ? { status: 'starting', pid } : { status: 'stale_lock', pid };
      }
    } catch {
      // ignore
    }
  }

  return { status: 'stopped' };
}

async function fetchHealth(internalServerUrl) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${internalServerUrl}/health`, { method: 'GET', signal: ctl.signal });
    const body = (await res.text()).trim();
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: null, body: null };
  } finally {
    clearTimeout(t);
  }
}

function authLoginSuggestion(stackName) {
  return stackName === 'main' ? 'happys auth login' : `happys stack auth ${stackName} login`;
}

async function cmdStatus({ json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();

  const { port, url: internalServerUrl } = getInternalServerUrl();
  const defaultPublicUrl = `http://localhost:${port}`;
  const envPublicUrl = (process.env.HAPPY_LOCAL_SERVER_URL ?? process.env.HAPPY_STACKS_SERVER_URL ?? '').trim();
  const { publicServerUrl } = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: false,
  });

  const cliHomeDir = resolveCliHomeDir();
  const accessKeyPath = join(cliHomeDir, 'access.key');
  const settingsPath = join(cliHomeDir, 'settings.json');

  const auth = {
    ok: fileHasContent(accessKeyPath),
    accessKeyPath,
    hasAccessKey: fileHasContent(accessKeyPath),
    settingsPath,
    hasSettings: fileHasContent(settingsPath),
  };

  const daemon = checkDaemonState(cliHomeDir);
  const health = await fetchHealth(internalServerUrl);

  const out = {
    stackName,
    internalServerUrl,
    publicServerUrl,
    cliHomeDir,
    auth,
    daemon,
    serverHealth: health,
    cliBin: join(getComponentDir(rootDir, 'happy-cli'), 'bin', 'happy.mjs'),
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  const authLine = auth.ok ? '✅ auth: ok' : '❌ auth: required';
  const daemonLine =
    daemon.status === 'running'
      ? `✅ daemon: running (pid=${daemon.pid})`
      : daemon.status === 'starting'
        ? `⏳ daemon: starting (pid=${daemon.pid})`
        : daemon.status === 'stale_state'
          ? `⚠️ daemon: stale state file (pid=${daemon.pid} not running)`
          : daemon.status === 'stale_lock'
            ? `⚠️ daemon: stale lock file (pid=${daemon.pid} not running)`
            : daemon.status === 'bad_state'
              ? '⚠️ daemon: unreadable state'
              : '❌ daemon: not running';

  const serverLine = health.ok ? `✅ server: healthy (${health.status})` : `⚠️ server: unreachable (${internalServerUrl})`;

  console.log(`[auth] stack: ${stackName}`);
  console.log(`[auth] urls: internal=${internalServerUrl} public=${publicServerUrl}`);
  console.log(`[auth] cli:  ${cliHomeDir}`);
  console.log('');
  console.log(authLine);
  if (!auth.ok) {
    console.log(`  ↪ run: ${authLoginSuggestion(stackName)}`);
  }
  console.log(daemonLine);
  console.log(serverLine);
  if (auth.ok && daemon.status !== 'running') {
    console.log(`  ↪ auth is OK; this looks like a daemon/runtime issue. Try: happys doctor`);
  }
}

async function cmdLogin({ argv, json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();

  const { port, url: internalServerUrl } = getInternalServerUrl();
  const defaultPublicUrl = `http://localhost:${port}`;
  const envPublicUrl = (process.env.HAPPY_LOCAL_SERVER_URL ?? process.env.HAPPY_STACKS_SERVER_URL ?? '').trim();
  const { publicServerUrl } = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: false,
  });

  const cliHomeDir = resolveCliHomeDir();
  const cliBin = join(getComponentDir(rootDir, 'happy-cli'), 'bin', 'happy.mjs');

  const force = !argv.includes('--no-force');
  const wantPrint = argv.includes('--print');

  const nodeArgs = [cliBin, 'auth', 'login'];
  if (force || argv.includes('--force')) {
    nodeArgs.push('--force');
  }

  const env = {
    ...process.env,
    HAPPY_HOME_DIR: cliHomeDir,
    HAPPY_SERVER_URL: internalServerUrl,
    HAPPY_WEBAPP_URL: publicServerUrl,
  };

  if (wantPrint) {
    const cmd = `HAPPY_HOME_DIR="${cliHomeDir}" HAPPY_SERVER_URL="${internalServerUrl}" HAPPY_WEBAPP_URL="${publicServerUrl}" node "${cliBin}" auth login${nodeArgs.includes('--force') ? ' --force' : ''}`;
    if (json) {
      printResult({ json, data: { ok: true, stackName, cmd } });
    } else {
      console.log(cmd);
    }
    return;
  }

  if (!json) {
    console.log(`[auth] stack: ${stackName}`);
    console.log(`[auth] launching login...`);
  }

  const child = spawn(process.execPath, nodeArgs, {
    cwd: rootDir,
    env,
    stdio: 'inherit',
  });

  await new Promise((resolve) => child.on('exit', resolve));
  if (json) {
    printResult({ json, data: { ok: child.exitCode === 0, exitCode: child.exitCode } });
  } else if (child.exitCode && child.exitCode !== 0) {
    process.exit(child.exitCode);
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const cmd = argv.find((a) => !a.startsWith('--')) || 'status';
  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'login'], stackScoped: 'happys stack auth <name> status|login' },
      text: [
        '[auth] usage:',
        '  happys auth status [--json]',
        '  happys auth login [--force] [--print] [--json]',
        '',
        'stack-scoped:',
        '  happys stack auth <name> status [--json]',
        '  happys stack auth <name> login [--force] [--print] [--json]',
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'status') {
    await cmdStatus({ json });
    return;
  }
  if (cmd === 'login') {
    await cmdLogin({ argv, json });
    return;
  }

  throw new Error(`[auth] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[auth] failed:', err);
  process.exit(1);
});
