import './utils/env.mjs';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import net from 'node:net';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import { parseArgs } from './utils/args.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { getComponentDir, getComponentsDir, getLegacyStorageRoot, getRootDir, getStacksStorageRoot, resolveStackEnvPath } from './utils/paths.mjs';
import { createWorktree, resolveComponentSpecToDir } from './utils/worktrees.mjs';
import { isTty, prompt, promptWorktreeSource, withRl } from './utils/wizard.mjs';
import { parseDotenv } from './utils/dotenv.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { ensureEnvFileUpdated } from './utils/env_file.mjs';
import { stopStackWithEnv } from './utils/stack_stop.mjs';

function stackNameFromArg(positionals, idx) {
  const name = positionals[idx]?.trim() ? positionals[idx].trim() : '';
  return name;
}

function getStackDir(stackName) {
  return resolveStackEnvPath(stackName).baseDir;
}

function getStackEnvPath(stackName) {
  return resolveStackEnvPath(stackName).envPath;
}

function getDefaultPortStart() {
  const raw = process.env.HAPPY_STACKS_STACK_PORT_START?.trim()
    ? process.env.HAPPY_STACKS_STACK_PORT_START.trim()
    : process.env.HAPPY_LOCAL_STACK_PORT_START?.trim()
      ? process.env.HAPPY_LOCAL_STACK_PORT_START.trim()
      : '';
  const n = raw ? Number(raw) : 3005;
  return Number.isFinite(n) ? n : 3005;
}

async function isPortFree(port) {
  return await new Promise((resolvePromise) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', () => resolvePromise(false));
    srv.listen({ port, host: '127.0.0.1' }, () => {
      srv.close(() => resolvePromise(true));
    });
  });
}

async function pickNextFreePort(startPort, { reservedPorts = new Set() } = {}) {
  let port = startPort;
  for (let i = 0; i < 200; i++) {
    // eslint-disable-next-line no-await-in-loop
    if (!reservedPorts.has(port) && (await isPortFree(port))) {
      return port;
    }
    port += 1;
  }
  throw new Error(`[stack] unable to find a free port starting at ${startPort}`);
}

async function readPortFromEnvFile(envPath) {
  const raw = await readExistingEnv(envPath);
  if (!raw.trim()) return null;
  const parsed = parseEnvToObject(raw);
  const portRaw = (parsed.HAPPY_STACKS_SERVER_PORT ?? parsed.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim();
  const n = portRaw ? Number(portRaw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function readPortsFromEnvFile(envPath) {
  const raw = await readExistingEnv(envPath);
  if (!raw.trim()) return [];
  const parsed = parseEnvToObject(raw);
  const keys = [
    'HAPPY_STACKS_SERVER_PORT',
    'HAPPY_LOCAL_SERVER_PORT',
    'HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT',
    'HAPPY_STACKS_PG_PORT',
    'HAPPY_STACKS_REDIS_PORT',
    'HAPPY_STACKS_MINIO_PORT',
    'HAPPY_STACKS_MINIO_CONSOLE_PORT',
  ];
  const ports = [];
  for (const k of keys) {
    const rawV = (parsed[k] ?? '').toString().trim();
    const n = rawV ? Number(rawV) : NaN;
    if (Number.isFinite(n) && n > 0) ports.push(n);
  }
  return ports;
}

async function collectReservedStackPorts({ excludeStackName = null } = {}) {
  const reserved = new Set();

  const roots = [
    // New layout: ~/.happy/stacks/<name>/env (or overridden via HAPPY_STACKS_STORAGE_DIR)
    getStacksStorageRoot(),
    // Legacy layout: ~/.happy/local/stacks/<name>/env
    join(getLegacyStorageRoot(), 'stacks'),
  ];

  for (const root of roots) {
    let entries = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const name = e.name;
      if (excludeStackName && name === excludeStackName) continue;
      const envPath = join(root, name, 'env');
      // eslint-disable-next-line no-await-in-loop
      const ports = await readPortsFromEnvFile(envPath);
      for (const p of ports) reserved.add(p);
    }
  }

  return reserved;
}

function base64Url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}

function randomToken(lenBytes = 24) {
  return base64Url(randomBytes(lenBytes));
}

function sanitizeDnsLabel(raw, { fallback = 'happy' } = {}) {
  const s = String(raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  return s || fallback;
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
    throw new Error(`[stack] cannot copy auth: source stack "${stackName}" does not exist`);
  }

  const sourceBaseDir = getStackDir(stackName);
  const sourceEnvPath = getStackEnvPath(stackName);
  const raw = await readExistingEnv(sourceEnvPath);
  const env = parseEnvToObject(raw);

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

async function copyAuthFromStackIntoNewStack({ fromStackName, stackName, stackEnv, serverComponent, json, requireSourceStackExists }) {
  const { secret, source } = await resolveHandyMasterSecretFromStack({
    stackName: fromStackName,
    requireStackExists: requireSourceStackExists,
  });

  const copied = { secret: false, accessKey: false, settings: false, sourceStack: fromStackName };

  if (secret) {
    if (serverComponent === 'happy-server-light') {
      const dataDir = stackEnv.HAPPY_SERVER_LIGHT_DATA_DIR;
      const target = join(dataDir, 'handy-master-secret.txt');
      copied.secret = await writeSecretFileIfMissing({ path: target, secret });
    } else if (serverComponent === 'happy-server') {
      const target = stackEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE;
      if (target) {
        copied.secret = await writeSecretFileIfMissing({ path: target, secret });
      }
    }
  }

  const sourceBaseDir = getStackDir(fromStackName);
  const sourceEnvRaw = await readExistingEnv(getStackEnvPath(fromStackName));
  const sourceEnv = parseEnvToObject(sourceEnvRaw);
  const sourceCli = getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });
  const targetCli = stackEnv.HAPPY_STACKS_CLI_HOME_DIR;

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

  if (!json) {
    const any = copied.secret || copied.accessKey || copied.settings;
    if (any) {
      console.log(`[stack] copied auth from "${fromStackName}" into "${stackName}" (no re-login needed)`);
      if (copied.secret) console.log(`  - master secret: copied (${source || 'unknown source'})`);
      if (copied.accessKey) console.log(`  - cli: copied access.key`);
      if (copied.settings) console.log(`  - cli: copied settings.json`);
    }
  }

  return copied;
}

function stringifyEnv(env) {
  const lines = [];
  for (const [k, v] of Object.entries(env)) {
    if (v == null) continue;
    const s = String(v);
    if (!s.trim()) continue;
    // Keep it simple: no quoting/escaping beyond this.
    lines.push(`${k}=${s}`);
  }
  return lines.join('\n') + '\n';
}

async function readExistingEnv(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return raw;
  } catch {
    return '';
  }
}

function parseEnvToObject(raw) {
  const parsed = parseDotenv(raw);
  return Object.fromEntries(parsed.entries());
}

function stackExistsSync(stackName) {
  if (stackName === 'main') return true;
  const envPath = getStackEnvPath(stackName);
  return existsSync(envPath);
}

function resolveDefaultComponentDirs({ rootDir }) {
  const componentNames = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];
  const out = {};
  for (const name of componentNames) {
    const embedded = join(rootDir, 'components', name);
    const workspace = join(getComponentsDir(rootDir), name);
    const dir = existsSync(embedded) ? embedded : workspace;
    out[`HAPPY_STACKS_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] = dir;
  }
  return out;
}

async function writeStackEnv({ stackName, env }) {
  const stackDir = getStackDir(stackName);
  await ensureDir(stackDir);
  const envPath = getStackEnvPath(stackName);
  const next = stringifyEnv(env);
  const existing = await readExistingEnv(envPath);
  if (existing !== next) {
    await writeFile(envPath, next, 'utf-8');
  }
  return envPath;
}

async function withStackEnv({ stackName, fn, extraEnv = {} }) {
  const envPath = getStackEnvPath(stackName);
  if (!stackExistsSync(stackName)) {
    throw new Error(
      `[stack] stack "${stackName}" does not exist yet.\n` +
      `[stack] Create it first:\n` +
      `  happys stack new ${stackName}\n` +
      `  # or:\n` +
      `  happys stack new ${stackName} --interactive\n`
    );
  }
  // IMPORTANT: stack env file should be authoritative. If the user has HAPPY_STACKS_* / HAPPY_LOCAL_*
  // exported in their shell, it would otherwise "win" because utils/env.mjs only sets
  // env vars if they are missing/empty.
  const cleaned = { ...process.env };
  for (const k of Object.keys(cleaned)) {
    if (k === 'HAPPY_LOCAL_ENV_FILE' || k === 'HAPPY_STACKS_ENV_FILE') continue;
    if (k === 'HAPPY_LOCAL_STACK' || k === 'HAPPY_STACKS_STACK') continue;
    if (k.startsWith('HAPPY_LOCAL_') || k.startsWith('HAPPY_STACKS_')) {
      delete cleaned[k];
    }
  }
  return await fn({
    env: {
      ...cleaned,
      HAPPY_STACKS_STACK: stackName,
      HAPPY_STACKS_ENV_FILE: envPath,
      HAPPY_LOCAL_STACK: stackName,
      HAPPY_LOCAL_ENV_FILE: envPath,
      ...extraEnv,
    },
    envPath,
  });
}

async function interactiveNew({ rootDir, rl, defaults }) {
  const out = { ...defaults };

  if (!out.stackName) {
    out.stackName = (await rl.question('Stack name: ')).trim();
  }
  if (!out.stackName) {
    throw new Error('[stack] stack name is required');
  }
  if (out.stackName === 'main') {
    throw new Error('[stack] stack name \"main\" is reserved (use the default stack without creating it)');
  }

  // Server component selection
  if (!out.serverComponent) {
    const server = (await rl.question('Server component [happy-server-light|happy-server] (default: happy-server-light): ')).trim();
    out.serverComponent = server || 'happy-server-light';
  }

  // Port
  if (!out.port) {
    const want = (await rl.question('Port (empty = auto-pick): ')).trim();
    out.port = want ? Number(want) : null;
  }

  // Remote for creating new worktrees (used by all "create new worktree" choices)
  if (!out.createRemote) {
    out.createRemote = await prompt(rl, 'Git remote for creating new worktrees (default: upstream): ', { defaultValue: 'upstream' });
  }

  // Component selections
  for (const c of ['happy', 'happy-cli']) {
    if (out.components[c] != null) continue;
    out.components[c] = await promptWorktreeSource({
      rl,
      rootDir,
      component: c,
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  // Server worktree selection (optional; only for the chosen server component)
  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  if (out.components[serverComponent] == null) {
    out.components[serverComponent] = await promptWorktreeSource({
      rl,
      rootDir,
      component: serverComponent,
      stackName: out.stackName,
      createRemote: out.createRemote,
    });
  }

  return out;
}

async function interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults }) {
  const out = { ...defaults, stackName };

  // Server component selection
  const currentServer = existingEnv.HAPPY_STACKS_SERVER_COMPONENT ?? existingEnv.HAPPY_LOCAL_SERVER_COMPONENT ?? '';
  const server = await prompt(
    rl,
    `Server component [happy-server-light|happy-server] (default: ${currentServer || 'happy-server-light'}): `,
    { defaultValue: currentServer || 'happy-server-light' }
  );
  out.serverComponent = server || 'happy-server-light';

  // Port
  const currentPort = existingEnv.HAPPY_STACKS_SERVER_PORT ?? existingEnv.HAPPY_LOCAL_SERVER_PORT ?? '';
  const wantPort = await prompt(rl, `Port (empty = keep ${currentPort || 'auto'}): `, { defaultValue: '' });
  out.port = wantPort ? Number(wantPort) : (currentPort ? Number(currentPort) : null);

  // Remote for creating new worktrees
  const currentRemote = existingEnv.HAPPY_STACKS_STACK_REMOTE ?? existingEnv.HAPPY_LOCAL_STACK_REMOTE ?? '';
  out.createRemote = await prompt(rl, `Git remote for creating new worktrees (default: ${currentRemote || 'upstream'}): `, {
    defaultValue: currentRemote || 'upstream',
  });

  // Worktree selections
  for (const c of ['happy', 'happy-cli']) {
    out.components[c] = await promptWorktreeSource({
      rl,
      rootDir,
      component: c,
      stackName,
      createRemote: out.createRemote,
    });
  }

  const serverComponent = out.serverComponent === 'happy-server' ? 'happy-server' : 'happy-server-light';
  out.components[serverComponent] = await promptWorktreeSource({
    rl,
    rootDir,
    component: serverComponent,
    stackName,
    createRemote: out.createRemote,
  });

  return out;
}

async function cmdNew({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const json = wantsJson(argv, { flags });
  const copyAuth = !(flags.has('--no-copy-auth') || flags.has('--fresh-auth'));
  const copyAuthFrom = (kv.get('--copy-auth-from') ?? '').trim() || 'main';

  // argv here is already "args after 'new'", so the first positional is the stack name.
  let stackName = stackNameFromArg(positionals, 0);
  const interactive = flags.has('--interactive') || (!stackName && isTty());

  const defaults = {
    stackName,
    port: kv.get('--port')?.trim() ? Number(kv.get('--port')) : null,
    serverComponent: (kv.get('--server') ?? '').trim() || '',
    createRemote: (kv.get('--remote') ?? '').trim() || '',
    components: {
      happy: kv.get('--happy')?.trim() || null,
      'happy-cli': kv.get('--happy-cli')?.trim() || null,
      'happy-server-light': kv.get('--happy-server-light')?.trim() || null,
      'happy-server': kv.get('--happy-server')?.trim() || null,
    },
  };

  let config = defaults;
  if (interactive) {
    config = await withRl((rl) => interactiveNew({ rootDir, rl, defaults }));
  }

  stackName = config.stackName?.trim() ? config.stackName.trim() : '';
  if (!stackName) {
    throw new Error(
      '[stack] usage: happys stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] ' +
        '[--happy=default|<owner/...>|<path>] [--happy-cli=...] [--happy-server=...] [--happy-server-light=...] ' +
        '[--copy-auth-from=main] [--no-copy-auth] [--interactive]'
    );
  }
  if (stackName === 'main') {
    throw new Error('[stack] stack name \"main\" is reserved (use the default stack without creating it)');
  }

  const serverComponent = (config.serverComponent || 'happy-server-light').trim();
  if (serverComponent !== 'happy-server-light' && serverComponent !== 'happy-server') {
    throw new Error(`[stack] invalid server component: ${serverComponent}`);
  }

  const baseDir = getStackDir(stackName);
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  let port = config.port;
  if (!port || !Number.isFinite(port)) {
    const reservedPorts = await collectReservedStackPorts();
    port = await pickNextFreePort(getDefaultPortStart(), { reservedPorts });
  }

  // Always pin component dirs explicitly (so stack env is stable even if repo env changes).
  const defaultComponentDirs = resolveDefaultComponentDirs({ rootDir });

  // Prepare component dirs (may create worktrees).
  const stackEnv = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_PORT: String(port),
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim() ? config.createRemote.trim() : 'upstream',
    ...defaultComponentDirs,
  };

  // Server-light storage isolation: ensure non-main stacks have their own sqlite + local files dir by default.
  // (This prevents a dev stack from mutating main stack's DB when schema changes.)
  if (serverComponent === 'happy-server-light') {
    const dataDir = join(baseDir, 'server-light');
    stackEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    stackEnv.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    stackEnv.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  if (serverComponent === 'happy-server') {
    const reservedPorts = await collectReservedStackPorts();
    reservedPorts.add(port);
    const backendPort = await pickNextFreePort(port + 10, { reservedPorts });
    reservedPorts.add(backendPort);
    const pgPort = await pickNextFreePort(port + 1000, { reservedPorts });
    reservedPorts.add(pgPort);
    const redisPort = await pickNextFreePort(pgPort + 1, { reservedPorts });
    reservedPorts.add(redisPort);
    const minioPort = await pickNextFreePort(redisPort + 1, { reservedPorts });
    reservedPorts.add(minioPort);
    const minioConsolePort = await pickNextFreePort(minioPort + 1, { reservedPorts });

    const pgUser = 'handy';
    const pgPassword = randomToken(24);
    const pgDb = 'handy';
    const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;

    const s3Bucket = sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
    const s3AccessKey = randomToken(12);
    const s3SecretKey = randomToken(24);
    const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

    // Persist infra config in the stack env so restarts are stable/reproducible.
    stackEnv.HAPPY_STACKS_MANAGED_INFRA = stackEnv.HAPPY_STACKS_MANAGED_INFRA ?? '1';
    stackEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT = String(backendPort);
    stackEnv.HAPPY_STACKS_PG_PORT = String(pgPort);
    stackEnv.HAPPY_STACKS_REDIS_PORT = String(redisPort);
    stackEnv.HAPPY_STACKS_MINIO_PORT = String(minioPort);
    stackEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT = String(minioConsolePort);
    stackEnv.HAPPY_STACKS_PG_USER = pgUser;
    stackEnv.HAPPY_STACKS_PG_PASSWORD = pgPassword;
    stackEnv.HAPPY_STACKS_PG_DATABASE = pgDb;
    stackEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE = join(baseDir, 'happy-server', 'handy-master-secret.txt');

    // Vars consumed by happy-server:
    stackEnv.DATABASE_URL = databaseUrl;
    stackEnv.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    stackEnv.S3_HOST = '127.0.0.1';
    stackEnv.S3_PORT = String(minioPort);
    stackEnv.S3_USE_SSL = 'false';
    stackEnv.S3_ACCESS_KEY = s3AccessKey;
    stackEnv.S3_SECRET_KEY = s3SecretKey;
    stackEnv.S3_BUCKET = s3Bucket;
    stackEnv.S3_PUBLIC_URL = s3PublicUrl;
  }

  // happy
  const happySpec = config.components.happy;
  if (happySpec && typeof happySpec === 'object' && happySpec.create) {
    const dir = await createWorktree({ rootDir, component: 'happy', slug: happySpec.slug, remoteName: happySpec.remote || 'upstream' });
    stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = dir;
  } else {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happy', spec: happySpec });
    if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY = resolve(rootDir, dir);
  }

  // happy-cli
  const cliSpec = config.components['happy-cli'];
  if (cliSpec && typeof cliSpec === 'object' && cliSpec.create) {
    const dir = await createWorktree({ rootDir, component: 'happy-cli', slug: cliSpec.slug, remoteName: cliSpec.remote || 'upstream' });
    stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = dir;
  } else {
    const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-cli', spec: cliSpec });
    if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI = resolve(rootDir, dir);
  }

  // Server component directory override (optional)
  if (serverComponent === 'happy-server-light') {
    const spec = config.components['happy-server-light'];
    if (spec && typeof spec === 'object' && spec.create) {
      const dir = await createWorktree({
        rootDir,
        component: 'happy-server-light',
        slug: spec.slug,
        remoteName: spec.remote || 'upstream',
      });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-server-light', spec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT = resolve(rootDir, dir);
    }
  } else if (serverComponent === 'happy-server') {
    const spec = config.components['happy-server'];
    if (spec && typeof spec === 'object' && spec.create) {
      const dir = await createWorktree({ rootDir, component: 'happy-server', slug: spec.slug, remoteName: spec.remote || 'upstream' });
      stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = dir;
    } else {
      const dir = resolveComponentSpecToDir({ rootDir, component: 'happy-server', spec });
      if (dir) stackEnv.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER = resolve(rootDir, dir);
    }
  }

  if (copyAuth) {
    // Default: inherit main stack auth so creating a new stack doesn't require re-login.
    // Users can opt out with --no-copy-auth to force a fresh auth / machine identity.
    await copyAuthFromStackIntoNewStack({
      fromStackName: copyAuthFrom,
      stackName,
      stackEnv,
      serverComponent,
      json,
      requireSourceStackExists: kv.has('--copy-auth-from'),
    }).catch((err) => {
      if (!json) {
        console.warn(`[stack] auth copy skipped: ${err instanceof Error ? err.message : String(err)}`);
        console.warn(`[stack] tip: you can always run: happys stack auth ${stackName} login`);
      }
    });
  }

  const envPath = await writeStackEnv({ stackName, env: stackEnv });
  printResult({
    json,
    data: { stackName, envPath, port, serverComponent },
    text: [`[stack] created ${stackName}`, `[stack] env: ${envPath}`, `[stack] port: ${port}`, `[stack] server: ${serverComponent}`].join('\n'),
  });
}

async function cmdEdit({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    throw new Error('[stack] usage: happys stack edit <name> [--interactive]');
  }

  const envPath = getStackEnvPath(stackName);
  const raw = await readExistingEnv(envPath);
  const existingEnv = parseEnvToObject(raw);

  const interactive = flags.has('--interactive') || (!flags.has('--no-interactive') && isTty());
  if (!interactive) {
    throw new Error('[stack] edit currently requires --interactive (non-interactive editing not implemented yet).');
  }

  const defaults = {
    stackName,
    port: null,
    serverComponent: '',
    createRemote: '',
    components: {
      happy: null,
      'happy-cli': null,
      'happy-server-light': null,
      'happy-server': null,
    },
  };

  const config = await withRl((rl) => interactiveEdit({ rootDir, rl, stackName, existingEnv, defaults }));

  // Build next env, starting from existing env but enforcing stack-scoped invariants.
  const baseDir = getStackDir(stackName);
  const uiBuildDir = join(baseDir, 'ui');
  const cliHomeDir = join(baseDir, 'cli');

  let port = config.port;
  if (!port || !Number.isFinite(port)) {
    const reservedPorts = await collectReservedStackPorts({ excludeStackName: stackName });
    port = await pickNextFreePort(getDefaultPortStart(), { reservedPorts });
  }

  const serverComponent = (config.serverComponent || existingEnv.HAPPY_STACKS_SERVER_COMPONENT || existingEnv.HAPPY_LOCAL_SERVER_COMPONENT || 'happy-server-light').trim();

  const next = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_PORT: String(port),
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim()
      ? config.createRemote.trim()
      : (existingEnv.HAPPY_STACKS_STACK_REMOTE || existingEnv.HAPPY_LOCAL_STACK_REMOTE || 'upstream'),
    // Always pin defaults; overrides below can replace.
    ...resolveDefaultComponentDirs({ rootDir }),
  };

  if (serverComponent === 'happy-server-light') {
    const dataDir = join(baseDir, 'server-light');
    next.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    next.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    next.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  if (serverComponent === 'happy-server') {
    const reservedPorts = await collectReservedStackPorts({ excludeStackName: stackName });
    reservedPorts.add(port);
    const backendPort = existingEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT?.trim()
      ? Number(existingEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT.trim())
      : await pickNextFreePort(port + 10, { reservedPorts });
    reservedPorts.add(backendPort);
    const pgPort = existingEnv.HAPPY_STACKS_PG_PORT?.trim() ? Number(existingEnv.HAPPY_STACKS_PG_PORT.trim()) : await pickNextFreePort(port + 1000, { reservedPorts });
    reservedPorts.add(pgPort);
    const redisPort = existingEnv.HAPPY_STACKS_REDIS_PORT?.trim() ? Number(existingEnv.HAPPY_STACKS_REDIS_PORT.trim()) : await pickNextFreePort(pgPort + 1, { reservedPorts });
    reservedPorts.add(redisPort);
    const minioPort = existingEnv.HAPPY_STACKS_MINIO_PORT?.trim() ? Number(existingEnv.HAPPY_STACKS_MINIO_PORT.trim()) : await pickNextFreePort(redisPort + 1, { reservedPorts });
    reservedPorts.add(minioPort);
    const minioConsolePort = existingEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT?.trim()
      ? Number(existingEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT.trim())
      : await pickNextFreePort(minioPort + 1, { reservedPorts });

    const pgUser = (existingEnv.HAPPY_STACKS_PG_USER ?? 'handy').trim() || 'handy';
    const pgPassword = (existingEnv.HAPPY_STACKS_PG_PASSWORD ?? '').trim() || randomToken(24);
    const pgDb = (existingEnv.HAPPY_STACKS_PG_DATABASE ?? 'handy').trim() || 'handy';
    const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;

    const s3Bucket = (existingEnv.S3_BUCKET ?? sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' })).trim() || sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
    const s3AccessKey = (existingEnv.S3_ACCESS_KEY ?? '').trim() || randomToken(12);
    const s3SecretKey = (existingEnv.S3_SECRET_KEY ?? '').trim() || randomToken(24);
    const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

    next.HAPPY_STACKS_MANAGED_INFRA = (existingEnv.HAPPY_STACKS_MANAGED_INFRA ?? '1').trim() || '1';
    next.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT = String(backendPort);
    next.HAPPY_STACKS_PG_PORT = String(pgPort);
    next.HAPPY_STACKS_REDIS_PORT = String(redisPort);
    next.HAPPY_STACKS_MINIO_PORT = String(minioPort);
    next.HAPPY_STACKS_MINIO_CONSOLE_PORT = String(minioConsolePort);
    next.HAPPY_STACKS_PG_USER = pgUser;
    next.HAPPY_STACKS_PG_PASSWORD = pgPassword;
    next.HAPPY_STACKS_PG_DATABASE = pgDb;
    next.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE = join(baseDir, 'happy-server', 'handy-master-secret.txt');

    next.DATABASE_URL = databaseUrl;
    next.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
    next.S3_HOST = '127.0.0.1';
    next.S3_PORT = String(minioPort);
    next.S3_USE_SSL = 'false';
    next.S3_ACCESS_KEY = s3AccessKey;
    next.S3_SECRET_KEY = s3SecretKey;
    next.S3_BUCKET = s3Bucket;
    next.S3_PUBLIC_URL = s3PublicUrl;
  }

  // Apply selections (create worktrees if needed)
  const applyComponent = async (component, key, spec) => {
    if (spec && typeof spec === 'object' && spec.create) {
      next[key] = await createWorktree({ rootDir, component, slug: spec.slug, remoteName: spec.remote || next.HAPPY_STACKS_STACK_REMOTE });
      return;
    }
    const dir = resolveComponentSpecToDir({ rootDir, component, spec });
    if (dir) {
      next[key] = resolve(rootDir, dir);
    }
  };

  await applyComponent('happy', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY', config.components.happy);
  await applyComponent('happy-cli', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', config.components['happy-cli']);
  if (serverComponent === 'happy-server') {
    await applyComponent('happy-server', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', config.components['happy-server']);
  } else {
    await applyComponent('happy-server-light', 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT', config.components['happy-server-light']);
  }

  const wrote = await writeStackEnv({ stackName, env: next });
  printResult({ json, data: { stackName, envPath: wrote, port, serverComponent }, text: `[stack] updated ${stackName}\n[stack] env: ${wrote}` });
}

async function cmdRunScript({ rootDir, stackName, scriptPath, args, extraEnv = {} }) {
  await withStackEnv({
    stackName,
    extraEnv,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
    },
  });
}

function resolveTransientComponentOverrides({ rootDir, kv }) {
  const overrides = {};
  const specs = [
    { flag: '--happy', component: 'happy', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY' },
    { flag: '--happy-cli', component: 'happy-cli', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI' },
    { flag: '--happy-server-light', component: 'happy-server-light', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT' },
    { flag: '--happy-server', component: 'happy-server', envKey: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER' },
  ];

  for (const { flag, component, envKey } of specs) {
    const spec = (kv.get(flag) ?? '').trim();
    if (!spec) {
      continue;
    }
    const dir = resolveComponentSpecToDir({ rootDir, component, spec });
    if (dir) {
      overrides[envKey] = dir;
    }
  }

  return overrides;
}

async function cmdService({ rootDir, stackName, svcCmd }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), svcCmd], { cwd: rootDir, env });
    },
  });
}

async function cmdTailscale({ rootDir, stackName, subcmd, args }) {
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'tailscale.mjs'), subcmd, ...args], { cwd: rootDir, env });
    },
  });
}

async function cmdSrv({ rootDir, stackName, args }) {
  // Forward to scripts/server_flavor.mjs under the stack env.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'server_flavor.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdWt({ rootDir, stackName, args }) {
  // Forward to scripts/worktrees.mjs under the stack env.
  // This makes `happys stack wt <name> -- ...` behave exactly like `happys wt ...`,
  // but read/write the stack env file (HAPPY_STACKS_ENV_FILE / legacy: HAPPY_LOCAL_ENV_FILE) instead of repo env.local.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdAuth({ rootDir, stackName, args }) {
  // Forward to scripts/auth.mjs under the stack env.
  // This makes `happys stack auth <name> ...` resolve CLI home/urls for that stack.
  const forwarded = args[0] === '--' ? args.slice(1) : args;
  await withStackEnv({
    stackName,
    fn: async ({ env }) => {
      await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...forwarded], { cwd: rootDir, env });
    },
  });
}

async function cmdMigrate({ argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const legacyDir = join(getLegacyStorageRoot(), 'stacks');
  const newRoot = getStacksStorageRoot();

  const migrated = [];
  const skipped = [];
  const missing = [];

  let entries = [];
  try {
    entries = await readdir(legacyDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  if (!entries.length) {
    printResult({
      json,
      data: { ok: true, migrated, skipped, missing, legacyDir, newRoot },
      text: `[stack] no legacy stacks found at ${legacyDir}`,
    });
    return;
  }

  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const legacyEnv = join(legacyDir, name, 'env');
    const targetEnv = join(newRoot, name, 'env');

    const raw = await readExistingEnv(legacyEnv);
    if (!raw.trim()) {
      missing.push({ name, legacyEnv });
      continue;
    }

    const existingTarget = await readExistingEnv(targetEnv);
    if (existingTarget.trim()) {
      skipped.push({ name, targetEnv });
      continue;
    }

    await ensureDir(join(newRoot, name));
    await writeFile(targetEnv, raw, 'utf-8');
    migrated.push({ name, targetEnv });
  }

  printResult({
    json,
    data: { ok: true, migrated, skipped, missing, legacyDir, newRoot },
    text: [
      `[stack] migrate complete`,
      `[stack] legacy: ${legacyDir}`,
      `[stack] new: ${newRoot}`,
      migrated.length ? `[stack] migrated: ${migrated.length}` : `[stack] migrated: none`,
      skipped.length ? `[stack] skipped (already exists): ${skipped.length}` : null,
      missing.length ? `[stack] skipped (missing env): ${missing.length}` : null,
      '',
      `Next steps:`,
      `- Re-run stacks normally (they'll prefer ${newRoot})`,
      `- If you use autostart: re-install to get the new label/paths: happys service install`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

async function cmdListStacks() {
  const stacksDir = getStacksStorageRoot();
  const legacyStacksDir = join(getLegacyStorageRoot(), 'stacks');
  try {
    const namesSet = new Set();
    const entries = await readdir(stacksDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'main') continue;
      namesSet.add(e.name);
    }
    try {
      const legacyEntries = await readdir(legacyStacksDir, { withFileTypes: true });
      for (const e of legacyEntries) {
        if (!e.isDirectory()) continue;
        namesSet.add(e.name);
      }
    } catch {
      // ignore
    }
    const names = Array.from(namesSet).sort();
    if (!names.length) {
      console.log('[stack] no stacks found');
      return;
    }
    console.log('[stack] stacks:');
    for (const n of names) {
      console.log(`- ${n}`);
    }
  } catch {
    console.log('[stack] no stacks found');
  }
}

async function listAllStackNames() {
  const stacksDir = getStacksStorageRoot();
  const legacyStacksDir = join(getLegacyStorageRoot(), 'stacks');
  const namesSet = new Set(['main']);
  try {
    const entries = await readdir(stacksDir, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      namesSet.add(e.name);
    }
  } catch {
    // ignore
  }
  try {
    const legacyEntries = await readdir(legacyStacksDir, { withFileTypes: true });
    for (const e of legacyEntries) {
      if (!e.isDirectory()) continue;
      namesSet.add(e.name);
    }
  } catch {
    // ignore
  }
  return Array.from(namesSet).sort();
}

function getEnvValue(obj, key) {
  return (obj?.[key] ?? '').toString().trim();
}

async function cmdAudit({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const fix = flags.has('--fix');
  const fixMain = flags.has('--fix-main');

  const stacks = await listAllStackNames();

  const report = [];
  const ports = new Map(); // port -> [stackName]

  for (const stackName of stacks) {
    const resolved = resolveStackEnvPath(stackName);
    const envPath = resolved.envPath;
    const baseDir = resolved.baseDir;

    const raw = await readExistingEnv(envPath);
    const env = parseEnvToObject(raw);

    const serverComponent = getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';
    const portRaw = getEnvValue(env, 'HAPPY_STACKS_SERVER_PORT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_PORT');
    const port = portRaw ? Number(portRaw) : null;
    if (Number.isFinite(port) && port > 0) {
      const existing = ports.get(port) ?? [];
      existing.push(stackName);
      ports.set(port, existing);
    }

    const issues = [];

    if (!raw.trim()) {
      issues.push({ code: 'missing_env', message: `env file missing/empty (${envPath})` });
    }

    const stacksUi = getEnvValue(env, 'HAPPY_STACKS_UI_BUILD_DIR');
    const localUi = getEnvValue(env, 'HAPPY_LOCAL_UI_BUILD_DIR');
    const uiBuildDir = stacksUi || localUi;
    const expectedUi = join(baseDir, 'ui');
    if (!uiBuildDir) {
      issues.push({ code: 'missing_ui_build_dir', message: `missing UI build dir (expected ${expectedUi})` });
    }

    const stacksCli = getEnvValue(env, 'HAPPY_STACKS_CLI_HOME_DIR');
    const localCli = getEnvValue(env, 'HAPPY_LOCAL_CLI_HOME_DIR');
    const cliHomeDir = stacksCli || localCli;
    const expectedCli = join(baseDir, 'cli');
    if (!cliHomeDir) {
      issues.push({ code: 'missing_cli_home_dir', message: `missing CLI home dir (expected ${expectedCli})` });
    }

    // Component dirs: require at least server component dir + happy-cli (otherwise stacks can accidentally fall back to some other workspace).
    const requiredComponents = [
      'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI',
      serverComponent === 'happy-server' ? 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER' : 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT',
    ];
    const missingComponentKeys = [];
    for (const k of requiredComponents) {
      const legacyKey = k.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
      if (!getEnvValue(env, k) && !getEnvValue(env, legacyKey)) {
        missingComponentKeys.push(k);
        issues.push({ code: 'missing_component_dir', message: `missing ${k} (or ${legacyKey})` });
      }
    }

    // Server-light DB/files isolation.
    const isServerLight = serverComponent === 'happy-server-light';
    if (isServerLight) {
      const dataDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_DATA_DIR');
      const filesDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_FILES_DIR');
      const dbUrl = getEnvValue(env, 'DATABASE_URL');
      const expectedDataDir = join(baseDir, 'server-light');
      const expectedFilesDir = join(expectedDataDir, 'files');
      const expectedDbUrl = `file:${join(expectedDataDir, 'happy-server-light.sqlite')}`;

      if (!dataDir) issues.push({ code: 'missing_server_light_data_dir', message: `missing HAPPY_SERVER_LIGHT_DATA_DIR (expected ${expectedDataDir})` });
      if (!filesDir) issues.push({ code: 'missing_server_light_files_dir', message: `missing HAPPY_SERVER_LIGHT_FILES_DIR (expected ${expectedFilesDir})` });
      if (!dbUrl) issues.push({ code: 'missing_database_url', message: `missing DATABASE_URL (expected ${expectedDbUrl})` });

    }

    // Best-effort env repair (missing keys only).
    if (fix && (stackName !== 'main' || fixMain) && raw.trim()) {
      const updates = [];

      // Always ensure stack directories are explicitly pinned when missing.
      if (!stacksUi && !localUi) updates.push({ key: 'HAPPY_STACKS_UI_BUILD_DIR', value: expectedUi });
      if (!stacksCli && !localCli) updates.push({ key: 'HAPPY_STACKS_CLI_HOME_DIR', value: expectedCli });

      // Pin component dirs if missing (best-effort).
      if (missingComponentKeys.length) {
        const defaults = resolveDefaultComponentDirs({ rootDir });
        for (const k of missingComponentKeys) {
          if (defaults[k]) {
            updates.push({ key: k, value: defaults[k] });
          }
        }
      }

      // Server-light storage isolation.
      if (isServerLight) {
        const dataDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_DATA_DIR');
        const filesDir = getEnvValue(env, 'HAPPY_SERVER_LIGHT_FILES_DIR');
        const dbUrl = getEnvValue(env, 'DATABASE_URL');
        const expectedDataDir = join(baseDir, 'server-light');
        const expectedFilesDir = join(expectedDataDir, 'files');
        const expectedDbUrl = `file:${join(expectedDataDir, 'happy-server-light.sqlite')}`;
        if (!dataDir) updates.push({ key: 'HAPPY_SERVER_LIGHT_DATA_DIR', value: expectedDataDir });
        if (!filesDir) updates.push({ key: 'HAPPY_SERVER_LIGHT_FILES_DIR', value: expectedFilesDir });
        if (!dbUrl) updates.push({ key: 'DATABASE_URL', value: expectedDbUrl });
      }

      if (updates.length) {
        await ensureEnvFileUpdated({ envPath, updates });
      }
    }

    report.push({
      stackName,
      envPath,
      baseDir,
      serverComponent,
      serverPort: Number.isFinite(port) ? port : null,
      uiBuildDir: uiBuildDir || null,
      cliHomeDir: cliHomeDir || null,
      issues,
    });
  }

  // Port collisions (post-pass)
  for (const [port, names] of ports.entries()) {
    if (names.length <= 1) continue;
    for (const r of report) {
      if (r.serverPort === port) {
        r.issues.push({ code: 'port_collision', message: `server port ${port} is also used by: ${names.filter((n) => n !== r.stackName).join(', ')}` });
      }
    }
  }

  const out = {
    ok: true,
    fixed: fix,
    stacks: report,
    summary: {
      total: report.length,
      withIssues: report.filter((r) => (r.issues ?? []).length > 0).length,
    },
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log('[stack] audit');
  for (const r of report) {
    const issueCount = (r.issues ?? []).length;
    const status = issueCount ? `issues=${issueCount}` : 'ok';
    console.log(`- ${r.stackName} (${status})`);
    if (issueCount) {
      for (const i of r.issues) console.log(`  - ${i.code}: ${i.message}`);
    }
  }
  if (fix) {
    console.log('');
    console.log('[stack] audit: applied best-effort fixes (missing keys only).');
  } else {
    console.log('');
    console.log('[stack] tip: run with --fix to add missing safe defaults (non-main stacks only).');
    console.log('[stack] tip: include --fix-main if you also want to modify main stack env defaults.');
  }
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  // pnpm (legacy) passes an extra leading `--` when forwarding args into scripts. Normalize it away so
  // positional slicing behaves consistently.
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === '--' ? rawArgv.slice(1) : rawArgv;

  const { flags } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] || 'help';
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: {
        commands: [
          'new',
          'edit',
          'list',
          'migrate',
          'audit',
          'auth',
          'dev',
          'start',
          'build',
          'typecheck',
          'doctor',
          'mobile',
          'stop',
          'srv',
          'wt',
          'tailscale:*',
          'service:*',
        ],
      },
      text: [
        '[stack] usage:',
        '  happys stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] [--happy=default|<owner/...>|<path>] [--happy-cli=...] [--interactive] [--copy-auth-from=main] [--no-copy-auth] [--json]',
        '  happys stack edit <name> --interactive [--json]',
        '  happys stack list [--json]',
        '  happys stack migrate [--json]   # copy legacy env files from ~/.happy/local/stacks/* -> ~/.happy/stacks/*',
        '  happys stack audit [--fix] [--fix-main] [--json]',
        '  happys stack auth <name> status|login [--json]',
        '  happys stack dev <name> [-- ...]',
        '  happys stack start <name> [-- ...]',
        '  happys stack build <name> [-- ...]',
        '  happys stack typecheck <name> [component...] [--json]',
        '  happys stack doctor <name> [-- ...]',
        '  happys stack mobile <name> [-- ...]',
        '  happys stack stop <name> [--aggressive] [--no-docker] [--json]',
        '  happys stack srv <name> -- status|use ...',
        '  happys stack wt <name> -- <wt args...>',
        '  happys stack tailscale:status|enable|disable|url <name> [-- ...]',
        '  happys stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
        '  happys stack service:* <name>   # legacy alias',
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'new') {
    await cmdNew({ rootDir, argv: argv.slice(1) });
    return;
  }
  if (cmd === 'edit') {
    await cmdEdit({ rootDir, argv });
    return;
  }
  if (cmd === 'list') {
    let names = [];
    try {
      const stacksDir = getStacksStorageRoot();
      const legacyStacksDir = join(getLegacyStorageRoot(), 'stacks');
      const namesSet = new Set();
      const entries = await readdir(stacksDir, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (e.name === 'main') continue;
        namesSet.add(e.name);
      }
      try {
        const legacyEntries = await readdir(legacyStacksDir, { withFileTypes: true });
        for (const e of legacyEntries) {
          if (!e.isDirectory()) continue;
          namesSet.add(e.name);
        }
      } catch {
        // ignore
      }
      names = Array.from(namesSet).sort();
    } catch {
      names = [];
    }
    if (json) {
      printResult({ json, data: { stacks: names } });
    } else {
      await cmdListStacks();
    }
    return;
  }

  if (cmd === 'migrate') {
    await cmdMigrate({ argv });
    return;
  }
  if (cmd === 'audit') {
    await cmdAudit({ rootDir, argv });
    return;
  }

  // Commands that need a stack name.
  const stackName = stackNameFromArg(positionals, 1);
  if (!stackName) {
    const helpLines =
      cmd === 'service'
        ? [
            '[stack] usage:',
            '  happys stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
            '',
            'example:',
            '  happys stack service exp1 status',
          ]
        : cmd === 'wt'
          ? [
              '[stack] usage:',
              '  happys stack wt <name> -- <wt args...>',
              '',
              'example:',
              '  happys stack wt exp1 -- use happy slopus/pr/123-fix-thing',
            ]
          : cmd === 'srv'
            ? [
                '[stack] usage:',
                '  happys stack srv <name> -- status|use ...',
                '',
                'example:',
                '  happys stack srv exp1 -- status',
              ]
            : cmd.startsWith('tailscale:')
              ? [
                  '[stack] usage:',
                  '  happys stack tailscale:status|enable|disable|url <name> [-- ...]',
                  '',
                  'example:',
                  '  happys stack tailscale:status exp1',
                ]
              : [
                  '[stack] missing stack name.',
                  'Run: happys stack --help',
                ];

    printResult({ json, data: { ok: false, error: 'missing_stack_name', cmd }, text: helpLines.join('\n') });
    process.exit(1);
  }

  // Remaining args after "<cmd> <name>"
  const passthrough = argv.slice(2);

  if (cmd === 'dev') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'dev.mjs', args: passthrough });
    return;
  }
  if (cmd === 'start') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'run.mjs', args: passthrough });
    return;
  }
  if (cmd === 'build') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'build.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'typecheck') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'typecheck.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'doctor') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'doctor.mjs', args: passthrough });
    return;
  }
  if (cmd === 'mobile') {
    await cmdRunScript({ rootDir, stackName, scriptPath: 'mobile.mjs', args: passthrough });
    return;
  }

  if (cmd === 'stop') {
    const { flags: stopFlags } = parseArgs(passthrough);
    const noDocker = stopFlags.has('--no-docker');
    const aggressive = stopFlags.has('--aggressive');
    const baseDir = getStackDir(stackName);
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        return await stopStackWithEnv({ rootDir, stackName, baseDir, env, json, noDocker, aggressive });
      },
    });
    if (json) printResult({ json, data: { ok: true, stopped: out } });
    return;
  }

  if (cmd === 'srv') {
    await cmdSrv({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'wt') {
    await cmdWt({ rootDir, stackName, args: passthrough });
    return;
  }
  if (cmd === 'auth') {
    await cmdAuth({ rootDir, stackName, args: passthrough });
    return;
  }

  if (cmd === 'service') {
    const svcCmd = passthrough[0];
    if (!svcCmd) {
      printResult({
        json,
        data: { ok: false, error: 'missing_service_subcommand', stackName },
        text: [
          '[stack] usage:',
          '  happys stack service <name> <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
          '',
          'example:',
          `  happys stack service ${stackName} status`,
        ].join('\n'),
      });
      process.exit(1);
    }
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }

  if (cmd.startsWith('service:')) {
    const svcCmd = cmd.slice('service:'.length);
    await cmdService({ rootDir, stackName, svcCmd });
    return;
  }
  if (cmd.startsWith('tailscale:')) {
    const subcmd = cmd.slice('tailscale:'.length);
    await cmdTailscale({ rootDir, stackName, subcmd, args: passthrough });
    return;
  }

  if (flags.has('--interactive') && cmd === 'help') {
    // no-op
  }

  console.log(`[stack] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[stack] failed:', err);
  process.exit(1);
});
