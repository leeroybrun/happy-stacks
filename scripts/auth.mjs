import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir, getStackName, resolveStackEnvPath } from './utils/paths.mjs';
import { resolvePublicServerUrl } from './tailscale.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { parseDotenv } from './utils/dotenv.mjs';
import { ensureDepsInstalled, pmExecBin } from './utils/pm.mjs';

function getInternalServerUrl() {
  const portRaw = (process.env.HAPPY_LOCAL_SERVER_PORT ?? process.env.HAPPY_STACKS_SERVER_PORT ?? '').trim();
  const port = portRaw ? Number(portRaw) : 3005;
  const n = Number.isFinite(port) ? port : 3005;
  return { port: n, url: `http://127.0.0.1:${n}` };
}

function expandTilde(p) {
  return p.replace(/^~(?=\/)/, homedir());
}

async function ensureDir(p) {
  await mkdir(p, { recursive: true });
}

async function readTextIfExists(path) {
  try {
    if (!existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    const t = raw.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

async function writeSecretFileIfMissing({ path, secret }) {
  if (existsSync(path)) return false;
  await ensureDir(dirname(path));
  await writeFile(path, secret, { encoding: 'utf-8', mode: 0o600 });
  return true;
}

async function copyFileIfMissing({ from, to, mode }) {
  if (existsSync(to)) return false;
  if (!existsSync(from)) return false;
  await ensureDir(dirname(to));
  await copyFile(from, to);
  if (mode) {
    await chmod(to, mode).catch(() => {});
  }
  return true;
}

function parseEnvToObject(raw) {
  const parsed = parseDotenv(raw);
  return Object.fromEntries(parsed.entries());
}

function getStackDir(stackName) {
  return resolveStackEnvPath(stackName).baseDir;
}

function getStackEnvPath(stackName) {
  return resolveStackEnvPath(stackName).envPath;
}

function stackExistsSync(stackName) {
  if (stackName === 'main') return true;
  const envPath = getStackEnvPath(stackName);
  return existsSync(envPath);
}

function getCliHomeDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env.HAPPY_STACKS_CLI_HOME_DIR ?? env.HAPPY_LOCAL_CLI_HOME_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'cli');
}

function getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'server-light');
}

async function resolveHandyMasterSecretFromStack({ stackName, requireStackExists }) {
  if (requireStackExists && !stackExistsSync(stackName)) {
    throw new Error(`[auth] cannot copy auth: source stack "${stackName}" does not exist`);
  }

  const sourceBaseDir = getStackDir(stackName);
  const sourceEnvPath = getStackEnvPath(stackName);
  const raw = await readTextIfExists(sourceEnvPath);
  const env = raw ? parseEnvToObject(raw) : {};

  const inline = (env.HANDY_MASTER_SECRET ?? '').trim();
  if (inline) {
    return { secret: inline, source: `${sourceEnvPath} (HANDY_MASTER_SECRET)` };
  }

  const secretFile = (env.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE ?? '').trim();
  if (secretFile) {
    const secret = await readTextIfExists(secretFile);
    if (secret) return { secret, source: secretFile };
  }

  const dataDir = getServerLightDataDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env });
  const secretPath = join(dataDir, 'handy-master-secret.txt');
  const secret = await readTextIfExists(secretPath);
  if (secret) return { secret, source: secretPath };

  // Last-resort legacy: if main has never been migrated to stack dirs.
  if (stackName === 'main') {
    const legacy = join(homedir(), '.happy', 'server-light', 'handy-master-secret.txt');
    const legacySecret = await readTextIfExists(legacy);
    if (legacySecret) return { secret: legacySecret, source: legacy };
  }

  return { secret: null, source: null };
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

function authCopyFromMainSuggestion(stackName) {
  if (stackName === 'main') return null;
  return `happys stack auth ${stackName} copy-from main`;
}

function resolveServerComponentForCurrentStack() {
  return (
    (process.env.HAPPY_STACKS_SERVER_COMPONENT ?? process.env.HAPPY_LOCAL_SERVER_COMPONENT ?? 'happy-server-light').trim() ||
    'happy-server-light'
  );
}

async function runNodeCapture({ cwd, env, args, stdin }) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, args, {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (err) => rejectPromise(err));
    child.on('close', (code) => {
      if (code === 0) {
        resolvePromise({ stdout, stderr });
        return;
      }
      rejectPromise(new Error(`node exited with ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
    if (stdin != null) {
      child.stdin.write(String(stdin));
    }
    child.stdin.end();
  });
}

function resolveServerComponentFromEnv(env) {
  const v = (env.HAPPY_STACKS_SERVER_COMPONENT ?? env.HAPPY_LOCAL_SERVER_COMPONENT ?? 'happy-server-light').trim() || 'happy-server-light';
  return v === 'happy-server' ? 'happy-server' : 'happy-server-light';
}

function resolveDatabaseUrlFromEnvOrThrow(env, { label }) {
  const v = (env.DATABASE_URL ?? '').trim();
  if (!v) throw new Error(`[auth] missing DATABASE_URL for ${label}`);
  return v;
}

function resolveServerComponentDir({ rootDir, serverComponent }) {
  return getComponentDir(rootDir, serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light');
}

async function seedAccountsFromSourceDbToTargetDb({
  rootDir,
  fromStackName,
  fromServerComponent,
  fromDatabaseUrl,
  targetStackName,
  targetServerComponent,
  targetDatabaseUrl,
}) {
  const sourceCwd = resolveServerComponentDir({ rootDir, serverComponent: fromServerComponent });
  const targetCwd = resolveServerComponentDir({ rootDir, serverComponent: targetServerComponent });

  const listScript = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
import { PrismaClient } from '@prisma/client';
const db = new PrismaClient();
try {
  const accounts = await db.account.findMany({ select: { id: true, publicKey: true } });
  console.log(JSON.stringify(accounts));
} finally {
  await db.$disconnect();
}
`.trim();

  const insertScript = `
process.on('uncaughtException', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
import { PrismaClient } from '@prisma/client';
import fs from 'node:fs';
const raw = fs.readFileSync(0, 'utf8').trim();
const accounts = raw ? JSON.parse(raw) : [];
const db = new PrismaClient();
try {
  let insertedCount = 0;
  for (const a of accounts) {
    // eslint-disable-next-line no-await-in-loop
    try {
      await db.account.create({ data: { id: a.id, publicKey: a.publicKey } });
      insertedCount += 1;
    } catch (e) {
      // Prisma unique constraint violation
      if (e && typeof e === 'object' && 'code' in e && e.code === 'P2002') {
        continue;
      }
      throw e;
    }
  }
  console.log(JSON.stringify({ sourceCount: accounts.length, insertedCount }));
} finally {
  await db.$disconnect();
}
`.trim();

  const { stdout: srcOut } = await runNodeCapture({
    cwd: sourceCwd,
    env: { ...process.env, DATABASE_URL: fromDatabaseUrl },
    args: ['--input-type=module', '-e', listScript],
  });
  const accounts = srcOut.trim() ? JSON.parse(srcOut.trim()) : [];

  const { stdout: insOut } = await runNodeCapture({
    cwd: targetCwd,
    env: { ...process.env, DATABASE_URL: targetDatabaseUrl },
    args: ['--input-type=module', '-e', insertScript],
    stdin: JSON.stringify(accounts),
  });
  const res = insOut.trim() ? JSON.parse(insOut.trim()) : { sourceCount: accounts.length, insertedCount: 0 };

  return {
    ok: true,
    fromStackName,
    targetStackName,
    sourceCount: Number(res.sourceCount ?? accounts.length) || 0,
    insertedCount: Number(res.insertedCount ?? 0) || 0,
  };
}

async function cmdCopyFrom({ argv, json }) {
  const rootDir = getRootDir(import.meta.url);
  const stackName = getStackName();
  if (stackName === 'main') {
    throw new Error('[auth] copy-from is intended for stack-scoped usage (e.g. happys stack auth <name> copy-from main)');
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const fromStackName = (positionals[1] ?? '').trim();
  if (!fromStackName) {
    throw new Error('[auth] usage: happys stack auth <name> copy-from <sourceStack> [--json]');
  }

  const serverComponent = resolveServerComponentForCurrentStack();
  const serverDirForPrisma = resolveServerComponentDir({ rootDir, serverComponent });
  const targetBaseDir = getDefaultAutostartPaths().baseDir;
  const targetCli = resolveCliHomeDir();
  const targetServerLightDataDir =
    (process.env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim() || join(targetBaseDir, 'server-light');
  const targetSecretFile =
    (process.env.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE ?? '').trim() || join(targetBaseDir, 'happy-server', 'handy-master-secret.txt');

  const { secret, source } = await resolveHandyMasterSecretFromStack({ stackName: fromStackName, requireStackExists: true });

  const copied = {
    secret: false,
    accessKey: false,
    settings: false,
    db: false,
    dbAccounts: null,
    dbError: null,
    sourceStack: fromStackName,
    stackName,
  };

  if (secret) {
    if (serverComponent === 'happy-server-light') {
      copied.secret = await writeSecretFileIfMissing({ path: join(targetServerLightDataDir, 'handy-master-secret.txt'), secret });
    } else if (serverComponent === 'happy-server') {
      copied.secret = await writeSecretFileIfMissing({ path: targetSecretFile, secret });
    }
  }

  const sourceBaseDir = getStackDir(fromStackName);
  const sourceEnvRaw = await readTextIfExists(getStackEnvPath(fromStackName));
  const sourceEnv = sourceEnvRaw ? parseEnvToObject(sourceEnvRaw) : {};
  const sourceCli = getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });

  copied.accessKey = await copyFileIfMissing({
    from: join(sourceCli, 'access.key'),
    to: join(targetCli, 'access.key'),
    mode: 0o600,
  });
  copied.settings = await copyFileIfMissing({
    from: join(sourceCli, 'settings.json'),
    to: join(targetCli, 'settings.json'),
    mode: 0o600,
  });

  // Best-effort DB seeding: copy Account rows from source stack DB to target stack DB.
  // This avoids FK failures (e.g., Prisma P2003) when the target DB is fresh but the copied token
  // refers to an account ID that does not exist there yet.
  try {
    // Ensure prisma is runnable (best-effort). If deps aren't installed, we'll fall back to skipping DB seeding.
    await ensureDepsInstalled(serverDirForPrisma, serverComponent).catch(() => {});

    const fromServerComponent = resolveServerComponentFromEnv(sourceEnv);
    const fromDatabaseUrl = resolveDatabaseUrlFromEnvOrThrow(sourceEnv, { label: `source stack "${fromStackName}"` });
    const targetEnv = process.env;
    const targetServerComponent = resolveServerComponentFromEnv(targetEnv);
    const targetDatabaseUrl = resolveDatabaseUrlFromEnvOrThrow(targetEnv, { label: `target stack "${stackName}"` });

    const runSeed = async () => {
      const seeded = await seedAccountsFromSourceDbToTargetDb({
        rootDir,
        fromStackName,
        fromServerComponent,
        fromDatabaseUrl,
        targetStackName: stackName,
        targetServerComponent,
        targetDatabaseUrl,
      });
      copied.dbAccounts = { sourceCount: seeded.sourceCount, insertedCount: seeded.insertedCount };
      copied.db = true;
      copied.dbError = null;
    };

    try {
      await runSeed();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // If the target DB exists but hasn't had schema applied yet, Prisma will report missing tables.
      // Fix it best-effort by applying schema, then retry seeding once.
      const looksLikeMissingTable = msg.toLowerCase().includes('does not exist') || msg.toLowerCase().includes('no such table');
      if (looksLikeMissingTable) {
        if (serverComponent === 'happy-server-light') {
          await pmExecBin({ dir: serverDirForPrisma, bin: 'prisma', args: ['db', 'push'], env: process.env }).catch(() => {});
        } else if (serverComponent === 'happy-server') {
          await pmExecBin({ dir: serverDirForPrisma, bin: 'prisma', args: ['migrate', 'deploy'], env: process.env }).catch(() => {});
        }
        await runSeed();
      } else {
        throw e;
      }
    }
  } catch (err) {
    copied.db = false;
    copied.dbAccounts = null;
    copied.dbError = err instanceof Error ? err.message : String(err);
    if (!json) {
      console.warn(`[auth] db seed skipped: ${copied.dbError}`);
    }
  }

  if (json) {
    printResult({ json, data: { ok: true, copied } });
    return;
  }

  const any = copied.secret || copied.accessKey || copied.settings || copied.db;
  if (!any) {
    console.log(`[auth] nothing to copy (target already has auth files)`);
    return;
  }

  console.log(`[auth] copied auth from "${fromStackName}" into "${stackName}" (no re-login needed)`);
  if (copied.secret) console.log(`  - master secret: copied (${source || 'unknown source'})`);
  if (copied.dbAccounts) {
    console.log(`  - db: seeded Account rows (inserted=${copied.dbAccounts.insertedCount}/${copied.dbAccounts.sourceCount})`);
  }
  if (copied.accessKey) console.log(`  - cli: copied access.key`);
  if (copied.settings) console.log(`  - cli: copied settings.json`);
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
    const copyFromMain = authCopyFromMainSuggestion(stackName);
    if (copyFromMain) {
      console.log(`  ↪ or (recommended if main is already logged in): ${copyFromMain}`);
    }
  }
  console.log(daemonLine);
  console.log(serverLine);
  if (!health.ok) {
    const startHint = stackName === 'main' ? 'happys dev' : `happys stack dev ${stackName}`;
    console.log(`  ↪ this stack does not appear to be running. Start it with: ${startHint}`);
    return;
  }
  if (auth.ok && daemon.status !== 'running') {
    console.log(`  ↪ daemon is not running for this stack. If you expected it to be running, try: happys doctor`);
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
    console.log('[auth] this will open Happy in your browser.');
    console.log('[auth] steps:');
    console.log('  1) Sign in / create an account (if needed)');
    console.log('  2) Approve this terminal/machine connection');
    console.log('  3) Return here — the CLI will finish automatically');
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
      data: { commands: ['status', 'login', 'copy-from'], stackScoped: 'happys stack auth <name> status|login|copy-from' },
      text: [
        '[auth] usage:',
        '  happys auth status [--json]',
        '  happys auth login [--force] [--print] [--json]',
        '',
        'stack-scoped:',
        '  happys stack auth <name> status [--json]',
        '  happys stack auth <name> login [--force] [--print] [--json]',
        '  happys stack auth <name> copy-from <sourceStack> [--json]',
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
  if (cmd === 'copy-from') {
    await cmdCopyFrom({ argv, json });
    return;
  }

  throw new Error(`[auth] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[auth] failed:', err);
  process.exit(1);
});
