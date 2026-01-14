import './utils/env.mjs';
import { spawn } from 'node:child_process';
import { chmod, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';

import { parseArgs } from './utils/args.mjs';
import { killProcessTree, run, runCapture } from './utils/proc.mjs';
import { getComponentDir, getComponentsDir, getHappyStacksHomeDir, getLegacyStorageRoot, getRootDir, getStacksStorageRoot, resolveStackEnvPath } from './utils/paths.mjs';
import { isTcpPortFree, pickNextFreeTcpPort } from './utils/ports.mjs';
import {
  createWorktree,
  createWorktreeFromBaseWorktree,
  inferRemoteNameForOwner,
  isComponentWorktreePath,
  resolveComponentSpecToDir,
  worktreeSpecFromDir,
} from './utils/worktrees.mjs';
import { isTty, prompt, promptWorktreeSource, withRl } from './utils/wizard.mjs';
import { parseDotenv } from './utils/dotenv.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { ensureEnvFilePruned, ensureEnvFileUpdated } from './utils/env_file.mjs';
import { listAllStackNames } from './utils/stacks.mjs';
import { stopStackWithEnv } from './utils/stack_stop.mjs';
import { writeDevAuthKey } from './utils/dev_auth_key.mjs';
import { startDevServer } from './utils/dev_server.mjs';
import { startDevExpoWebUi } from './utils/dev_expo_web.mjs';
import { requireDir } from './utils/pm.mjs';
import { waitForHttpOk } from './utils/server.mjs';
import { resolveLocalhostHost } from './utils/localhost_host.mjs';
import { openUrlInBrowser } from './utils/browser.mjs';
import { copyFileIfMissing, linkFileIfMissing, writeSecretFileIfMissing } from './utils/auth_files.mjs';
import { getLegacyHappyBaseDir, isLegacyAuthSourceName } from './utils/auth_sources.mjs';
import { resolveAuthSeedFromEnv } from './utils/stack_startup.mjs';
import { getHomeEnvLocalPath } from './utils/config.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/sandbox.mjs';
import { resolveHandyMasterSecretFromStack } from './utils/handy_master_secret.mjs';
import {
  deleteStackRuntimeStateFile,
  getStackRuntimeStatePath,
  isPidAlive,
  recordStackRuntimeStart,
  readStackRuntimeStateFile,
} from './utils/stack_runtime_state.mjs';
import { killPid } from './utils/expo.mjs';
import { killPidOwnedByStack } from './utils/ownership.mjs';

function getEnvValue(obj, key) {
  const v = (obj?.[key] ?? '').toString().trim();
  return v || '';
}

function getEnvValueAny(obj, keys) {
  for (const k of keys) {
    const v = getEnvValue(obj, k);
    if (v) return v;
  }
  return '';
}

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
  return await isTcpPortFree(port, { host: '127.0.0.1' });
}

async function pickNextFreePort(startPort, { reservedPorts = new Set() } = {}) {
  try {
    return await pickNextFreeTcpPort(startPort, { reservedPorts, host: '127.0.0.1' });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(msg.replace(/^\[local\]/, '[stack]'));
  }
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

// auth file copy/link helpers live in scripts/utils/auth_files.mjs

function getCliHomeDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env.HAPPY_STACKS_CLI_HOME_DIR ?? env.HAPPY_LOCAL_CLI_HOME_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'cli');
}

function getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'server-light');
}

async function copyAuthFromStackIntoNewStack({
  fromStackName,
  stackName,
  stackEnv,
  serverComponent,
  json,
  requireSourceStackExists,
  linkMode = false,
}) {
  const { secret, source } = await resolveHandyMasterSecretFromStack({
    stackName: fromStackName,
    requireStackExists: requireSourceStackExists,
    allowLegacyAuthSource: !isSandboxed() || sandboxAllowsGlobalSideEffects(),
    allowLegacyMainFallback: !isSandboxed() || sandboxAllowsGlobalSideEffects(),
  });

  const copied = { secret: false, accessKey: false, settings: false, sourceStack: fromStackName };

  if (secret) {
    if (serverComponent === 'happy-server-light') {
      const dataDir = stackEnv.HAPPY_SERVER_LIGHT_DATA_DIR;
      const target = join(dataDir, 'handy-master-secret.txt');
      const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
      copied.secret =
        linkMode && sourcePath && existsSync(sourcePath)
          ? await linkFileIfMissing({ from: sourcePath, to: target })
          : await writeSecretFileIfMissing({ path: target, secret });
    } else if (serverComponent === 'happy-server') {
      const target = stackEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE;
      if (target) {
        const sourcePath = source && !String(source).includes('(HANDY_MASTER_SECRET)') ? String(source) : '';
        copied.secret =
          linkMode && sourcePath && existsSync(sourcePath)
            ? await linkFileIfMissing({ from: sourcePath, to: target })
            : await writeSecretFileIfMissing({ path: target, secret });
      }
    }
  }

  const legacy = isLegacyAuthSourceName(fromStackName);
  if (legacy && isSandboxed() && !sandboxAllowsGlobalSideEffects()) {
    throw new Error(
      '[stack] auth copy-from: legacy auth source is disabled in sandbox mode.\n' +
        'Reason: it reads from ~/.happy (global user state).\n' +
        'If you really want this, set: HAPPY_STACKS_SANDBOX_ALLOW_GLOBAL=1'
    );
  }
  const sourceBaseDir = legacy ? getLegacyHappyBaseDir() : getStackDir(fromStackName);
  const sourceEnvRaw = legacy ? '' : await readExistingEnv(getStackEnvPath(fromStackName));
  const sourceEnv = parseEnvToObject(sourceEnvRaw);
  const sourceCli = legacy ? join(sourceBaseDir, 'cli') : getCliHomeDirFromEnvOrDefault({ stackBaseDir: sourceBaseDir, env: sourceEnv });
  const targetCli = stackEnv.HAPPY_STACKS_CLI_HOME_DIR;

  if (linkMode) {
    copied.accessKey = await linkFileIfMissing({ from: join(sourceCli, 'access.key'), to: join(targetCli, 'access.key') });
    copied.settings = await linkFileIfMissing({ from: join(sourceCli, 'settings.json'), to: join(targetCli, 'settings.json') });
  } else {
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
  }

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
  const raw = await readExistingEnv(envPath);
  const stackEnv = parseEnvToObject(raw);

  // Mirror HAPPY_STACKS_* and HAPPY_LOCAL_* prefixes so callers can use either.
  // (Matches scripts/utils/env.mjs behavior.)
  const applyPrefixMapping = (obj) => {
    const keys = new Set(Object.keys(obj));
    const suffixes = new Set();
    for (const k of keys) {
      if (k.startsWith('HAPPY_STACKS_')) suffixes.add(k.slice('HAPPY_STACKS_'.length));
      if (k.startsWith('HAPPY_LOCAL_')) suffixes.add(k.slice('HAPPY_LOCAL_'.length));
    }
    for (const suffix of suffixes) {
      const stacksKey = `HAPPY_STACKS_${suffix}`;
      const localKey = `HAPPY_LOCAL_${suffix}`;
      const stacksVal = (obj[stacksKey] ?? '').toString().trim();
      const localVal = (obj[localKey] ?? '').toString().trim();
      if (stacksVal) {
        obj[stacksKey] = stacksVal;
        obj[localKey] = stacksVal;
      } else if (localVal) {
        obj[localKey] = localVal;
        obj[stacksKey] = localVal;
      }
    }
  };

  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);

  const env = {
    ...cleaned,
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_ENV_FILE: envPath,
    HAPPY_LOCAL_STACK: stackName,
    HAPPY_LOCAL_ENV_FILE: envPath,
    // Expose runtime state path so scripts can find it if needed.
    HAPPY_STACKS_RUNTIME_STATE_PATH: runtimeStatePath,
    HAPPY_LOCAL_RUNTIME_STATE_PATH: runtimeStatePath,
    // Stack env is authoritative by default.
    ...stackEnv,
    // One-shot overrides (e.g. --happy=...) win over stack env file.
    ...extraEnv,
  };
  applyPrefixMapping(env);

  // Runtime-only port overlay (ephemeral stacks): only trust it when the owner pid is still alive.
  const ownerPid = Number(runtimeState?.ownerPid);
  if (isPidAlive(ownerPid)) {
    const ports = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
    const applyPort = (suffix, value) => {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return;
      env[`HAPPY_STACKS_${suffix}`] = String(n);
      env[`HAPPY_LOCAL_${suffix}`] = String(n);
    };
    applyPort('SERVER_PORT', ports.server);
    applyPort('HAPPY_SERVER_BACKEND_PORT', ports.backend);
    applyPort('PG_PORT', ports.pg);
    applyPort('REDIS_PORT', ports.redis);
    applyPort('MINIO_PORT', ports.minio);
    applyPort('MINIO_CONSOLE_PORT', ports.minioConsole);

    // Mark ephemeral mode for downstream helpers (e.g. infra should not persist ports).
    if (runtimeState?.ephemeral) {
      env.HAPPY_STACKS_EPHEMERAL_PORTS = '1';
      env.HAPPY_LOCAL_EPHEMERAL_PORTS = '1';
    }
  }

  return await fn({ env, envPath, stackEnv, runtimeStatePath, runtimeState });
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
    const want = (await rl.question('Port (empty = ephemeral): ')).trim();
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
  const wantPort = await prompt(rl, `Port (empty = keep ${currentPort || 'ephemeral'}; type 'ephemeral' to unpin): `, { defaultValue: '' });
  const wantTrimmed = wantPort.trim().toLowerCase();
  out.port = wantTrimmed === 'ephemeral' ? null : wantPort ? Number(wantPort) : (currentPort ? Number(currentPort) : null);

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

async function cmdNew({ rootDir, argv, emit = true }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const json = wantsJson(argv, { flags });
  const copyAuth = !(flags.has('--no-copy-auth') || flags.has('--fresh-auth'));
  const copyAuthFrom =
    (kv.get('--copy-auth-from') ?? '').trim() ||
    (process.env.HAPPY_STACKS_AUTH_SEED_FROM ?? process.env.HAPPY_LOCAL_AUTH_SEED_FROM ?? '').trim() ||
    'main';
  const linkAuth =
    flags.has('--link-auth') ||
    flags.has('--link') ||
    flags.has('--symlink-auth') ||
    (kv.get('--link-auth') ?? '').trim() === '1' ||
    (kv.get('--auth-mode') ?? '').trim() === 'link' ||
    (kv.get('--copy-auth-mode') ?? '').trim() === 'link' ||
    (process.env.HAPPY_STACKS_AUTH_LINK ?? process.env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPY_STACKS_AUTH_MODE ?? process.env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim() === 'link';
  const forcePort = flags.has('--force-port');

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
        '[--copy-auth-from=<stack|legacy>] [--link-auth] [--no-copy-auth] [--interactive] [--force-port]'
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

  // Port strategy:
  // - If --port is provided, we treat it as a pinned port and persist it in the stack env.
  // - Otherwise, ports are ephemeral and chosen at stack start time (stored only in stack.runtime.json).
  let port = config.port;
  if (!Number.isFinite(port) || port <= 0) {
    port = null;
  }
  if (port != null) {
    // If user picked a port explicitly, fail-closed on collisions by default.
    const reservedPorts = await collectReservedStackPorts();
    if (!forcePort && reservedPorts.has(port)) {
      throw new Error(
        `[stack] port ${port} is already reserved by another stack env.\n` +
          `Fix:\n` +
          `- omit --port to use an ephemeral port at start time (recommended)\n` +
          `- or pick a different --port\n` +
          `- or re-run with --force-port (not recommended)\n`
      );
    }
    if (!(await isTcpPortFree(port))) {
      throw new Error(
        `[stack] port ${port} is not free on 127.0.0.1.\n` +
          `Fix:\n` +
          `- omit --port to use an ephemeral port at start time (recommended)\n` +
          `- or stop the process currently using ${port}\n`
      );
    }
  }

  // Always pin component dirs explicitly (so stack env is stable even if repo env changes).
  const defaultComponentDirs = resolveDefaultComponentDirs({ rootDir });

  // Prepare component dirs (may create worktrees).
  const stackEnv = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim() ? config.createRemote.trim() : 'upstream',
    ...defaultComponentDirs,
  };
  if (port != null) {
    stackEnv.HAPPY_STACKS_SERVER_PORT = String(port);
  }

  // Server-light storage isolation: ensure non-main stacks have their own sqlite + local files dir by default.
  // (This prevents a dev stack from mutating main stack's DB when schema changes.)
  if (serverComponent === 'happy-server-light') {
    const dataDir = join(baseDir, 'server-light');
    stackEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    stackEnv.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    stackEnv.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  if (serverComponent === 'happy-server') {
    // Persist stable infra credentials in the stack env (ports are ephemeral unless explicitly pinned).
    const pgUser = 'handy';
    const pgPassword = randomToken(24);
    const pgDb = 'handy';
    const s3Bucket = sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
    const s3AccessKey = randomToken(12);
    const s3SecretKey = randomToken(24);

    stackEnv.HAPPY_STACKS_MANAGED_INFRA = stackEnv.HAPPY_STACKS_MANAGED_INFRA ?? '1';
    stackEnv.HAPPY_STACKS_PG_USER = pgUser;
    stackEnv.HAPPY_STACKS_PG_PASSWORD = pgPassword;
    stackEnv.HAPPY_STACKS_PG_DATABASE = pgDb;
    stackEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE = join(baseDir, 'happy-server', 'handy-master-secret.txt');
    stackEnv.S3_ACCESS_KEY = s3AccessKey;
    stackEnv.S3_SECRET_KEY = s3SecretKey;
    stackEnv.S3_BUCKET = s3Bucket;

    // If user explicitly pinned the server port, also pin the rest of the ports + derived URLs for reproducibility.
    if (port != null) {
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

      const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
      const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

      stackEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT = String(backendPort);
      stackEnv.HAPPY_STACKS_PG_PORT = String(pgPort);
      stackEnv.HAPPY_STACKS_REDIS_PORT = String(redisPort);
      stackEnv.HAPPY_STACKS_MINIO_PORT = String(minioPort);
      stackEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT = String(minioConsolePort);

      // Vars consumed by happy-server:
      stackEnv.DATABASE_URL = databaseUrl;
      stackEnv.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      stackEnv.S3_HOST = '127.0.0.1';
      stackEnv.S3_PORT = String(minioPort);
      stackEnv.S3_USE_SSL = 'false';
      stackEnv.S3_PUBLIC_URL = s3PublicUrl;
    }
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
    // Default: inherit seed stack auth so creating a new stack doesn't require re-login.
    // Source: --copy-auth-from (highest), else HAPPY_STACKS_AUTH_SEED_FROM (default: main).
    // Users can opt out with --no-copy-auth to force a fresh auth / machine identity.
    await copyAuthFromStackIntoNewStack({
      fromStackName: copyAuthFrom,
      stackName,
      stackEnv,
      serverComponent,
      json,
      requireSourceStackExists: kv.has('--copy-auth-from'),
      linkMode: linkAuth,
    }).catch((err) => {
      if (!json && emit) {
        console.warn(`[stack] auth copy skipped: ${err instanceof Error ? err.message : String(err)}`);
        console.warn(`[stack] tip: you can always run: happys stack auth ${stackName} login`);
      }
    });
  }

  const envPath = await writeStackEnv({ stackName, env: stackEnv });
  const res = { ok: true, stackName, envPath, port: port ?? null, serverComponent, portsMode: port == null ? 'ephemeral' : 'pinned' };
  if (emit) {
    printResult({
      json,
      data: res,
      text: [
        `[stack] created ${stackName}`,
        `[stack] env: ${envPath}`,
        `[stack] port: ${port == null ? 'ephemeral (picked at start)' : String(port)}`,
        `[stack] server: ${serverComponent}`,
      ].join('\n'),
    });
  }
  return res;
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
  if (!Number.isFinite(port) || port <= 0) {
    port = null;
  }

  const serverComponent = (config.serverComponent || existingEnv.HAPPY_STACKS_SERVER_COMPONENT || existingEnv.HAPPY_LOCAL_SERVER_COMPONENT || 'happy-server-light').trim();

  const next = {
    HAPPY_STACKS_STACK: stackName,
    HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
    HAPPY_STACKS_UI_BUILD_DIR: uiBuildDir,
    HAPPY_STACKS_CLI_HOME_DIR: cliHomeDir,
    HAPPY_STACKS_STACK_REMOTE: config.createRemote?.trim()
      ? config.createRemote.trim()
      : (existingEnv.HAPPY_STACKS_STACK_REMOTE || existingEnv.HAPPY_LOCAL_STACK_REMOTE || 'upstream'),
    // Always pin defaults; overrides below can replace.
    ...resolveDefaultComponentDirs({ rootDir }),
  };
  if (port != null) {
    next.HAPPY_STACKS_SERVER_PORT = String(port);
  }

  if (serverComponent === 'happy-server-light') {
    const dataDir = join(baseDir, 'server-light');
    next.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
    next.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
    next.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
  }
  if (serverComponent === 'happy-server') {
    // Persist stable infra credentials. Ports are ephemeral unless explicitly pinned.
    const pgUser = (existingEnv.HAPPY_STACKS_PG_USER ?? 'handy').trim() || 'handy';
    const pgPassword = (existingEnv.HAPPY_STACKS_PG_PASSWORD ?? '').trim() || randomToken(24);
    const pgDb = (existingEnv.HAPPY_STACKS_PG_DATABASE ?? 'handy').trim() || 'handy';
    const s3Bucket =
      (existingEnv.S3_BUCKET ?? sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' })).trim() ||
      sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
    const s3AccessKey = (existingEnv.S3_ACCESS_KEY ?? '').trim() || randomToken(12);
    const s3SecretKey = (existingEnv.S3_SECRET_KEY ?? '').trim() || randomToken(24);

    next.HAPPY_STACKS_MANAGED_INFRA = (existingEnv.HAPPY_STACKS_MANAGED_INFRA ?? '1').trim() || '1';
    next.HAPPY_STACKS_PG_USER = pgUser;
    next.HAPPY_STACKS_PG_PASSWORD = pgPassword;
    next.HAPPY_STACKS_PG_DATABASE = pgDb;
    next.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE =
      (existingEnv.HAPPY_STACKS_HANDY_MASTER_SECRET_FILE ?? '').trim() || join(baseDir, 'happy-server', 'handy-master-secret.txt');
    next.S3_ACCESS_KEY = s3AccessKey;
    next.S3_SECRET_KEY = s3SecretKey;
    next.S3_BUCKET = s3Bucket;

    if (port != null) {
      // If user pinned the server port, keep ports + derived URLs stable as well.
      const reservedPorts = await collectReservedStackPorts({ excludeStackName: stackName });
      reservedPorts.add(port);
      const backendPort = existingEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT.trim())
        : await pickNextFreePort(port + 10, { reservedPorts });
      reservedPorts.add(backendPort);
      const pgPort = existingEnv.HAPPY_STACKS_PG_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_PG_PORT.trim())
        : await pickNextFreePort(port + 1000, { reservedPorts });
      reservedPorts.add(pgPort);
      const redisPort = existingEnv.HAPPY_STACKS_REDIS_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_REDIS_PORT.trim())
        : await pickNextFreePort(pgPort + 1, { reservedPorts });
      reservedPorts.add(redisPort);
      const minioPort = existingEnv.HAPPY_STACKS_MINIO_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_MINIO_PORT.trim())
        : await pickNextFreePort(redisPort + 1, { reservedPorts });
      reservedPorts.add(minioPort);
      const minioConsolePort = existingEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT?.trim()
        ? Number(existingEnv.HAPPY_STACKS_MINIO_CONSOLE_PORT.trim())
        : await pickNextFreePort(minioPort + 1, { reservedPorts });

      const databaseUrl = `postgresql://${encodeURIComponent(pgUser)}:${encodeURIComponent(pgPassword)}@127.0.0.1:${pgPort}/${encodeURIComponent(pgDb)}`;
      const s3PublicUrl = `http://127.0.0.1:${minioPort}/${s3Bucket}`;

      next.HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT = String(backendPort);
      next.HAPPY_STACKS_PG_PORT = String(pgPort);
      next.HAPPY_STACKS_REDIS_PORT = String(redisPort);
      next.HAPPY_STACKS_MINIO_PORT = String(minioPort);
      next.HAPPY_STACKS_MINIO_CONSOLE_PORT = String(minioConsolePort);

      next.DATABASE_URL = databaseUrl;
      next.REDIS_URL = `redis://127.0.0.1:${redisPort}`;
      next.S3_HOST = '127.0.0.1';
      next.S3_PORT = String(minioPort);
      next.S3_USE_SSL = 'false';
      next.S3_PUBLIC_URL = s3PublicUrl;
    }
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
    fn: async ({ env, envPath, stackEnv, runtimeStatePath, runtimeState }) => {
      const isStartLike = scriptPath === 'dev.mjs' || scriptPath === 'run.mjs';
      if (!isStartLike) {
        await run(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], { cwd: rootDir, env });
        return;
      }

      const wantsRestart = args.includes('--restart');
      const wantsJson = args.includes('--json');
      const pinnedServerPort = Boolean((stackEnv.HAPPY_STACKS_SERVER_PORT ?? '').trim() || (stackEnv.HAPPY_LOCAL_SERVER_PORT ?? '').trim());
      const serverComponent =
        (stackEnv.HAPPY_STACKS_SERVER_COMPONENT ?? stackEnv.HAPPY_LOCAL_SERVER_COMPONENT ?? '').toString().trim() || 'happy-server-light';
      const managedInfra =
        serverComponent === 'happy-server'
          ? ((stackEnv.HAPPY_STACKS_MANAGED_INFRA ?? stackEnv.HAPPY_LOCAL_MANAGED_INFRA ?? '1').toString().trim() !== '0')
          : false;

      // If this is an ephemeral-port stack and it's already running, avoid spawning a second copy.
      const existingOwnerPid = Number(runtimeState?.ownerPid);
      const existingPort = Number(runtimeState?.ports?.server);
      const existingUiPort = Number(runtimeState?.expo?.webPort);
      const existingPorts =
        runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : null;
      const wasRunning = isPidAlive(existingOwnerPid);
      // True restart = there was an active runner for this stack. If the stack is not running,
      // `--restart` should behave like a normal start (allocate new ephemeral ports if needed).
      const isTrueRestart = wantsRestart && wasRunning;
      if (wasRunning) {
        if (!wantsRestart) {
          const serverPart = Number.isFinite(existingPort) && existingPort > 0 ? ` server=${existingPort}` : '';
          const uiPart =
            scriptPath === 'dev.mjs' && Number.isFinite(existingUiPort) && existingUiPort > 0 ? ` ui=${existingUiPort}` : '';
          console.log(`[stack] ${stackName}: already running (pid=${existingOwnerPid}${serverPart}${uiPart})`);

          const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          const noBrowser =
            args.includes('--no-browser') ||
            (env.HAPPY_STACKS_NO_BROWSER ?? env.HAPPY_LOCAL_NO_BROWSER ?? '').toString().trim() === '1';
          const openBrowser = isInteractive && !wantsJson && !noBrowser;

          const host = resolveLocalhostHost({ stackMode: true, stackName });
          const uiUrl =
            scriptPath === 'dev.mjs'
              ? Number.isFinite(existingUiPort) && existingUiPort > 0
                ? `http://${host}:${existingUiPort}`
                : null
              : Number.isFinite(existingPort) && existingPort > 0
                ? `http://${host}:${existingPort}`
                : null;

          if (uiUrl) {
            console.log(`[stack] ${stackName}: ui: ${uiUrl}`);
            if (openBrowser) {
              await openUrlInBrowser(uiUrl);
            }
          } else if (scriptPath === 'dev.mjs') {
            console.log(`[stack] ${stackName}: ui: unknown (missing expo.webPort in stack.runtime.json)`);
          }
          return;
        }
        // Restart: stop the existing runner first.
        await killPidOwnedByStack(existingOwnerPid, { stackName, envPath, cliHomeDir: (env.HAPPY_STACKS_CLI_HOME_DIR ?? env.HAPPY_LOCAL_CLI_HOME_DIR ?? '').toString(), label: 'runner', json: false });
        // Clear runtime state so we don't keep stale process PIDs; we'll re-create it for the new run below.
        await deleteStackRuntimeStateFile(runtimeStatePath);
      }

      // Ephemeral ports: allocate at start time, store only in runtime state (not in stack env).
      if (!pinnedServerPort) {
        const reserved = await collectReservedStackPorts({ excludeStackName: stackName });

        // Also avoid ports held by other *running* ephemeral stacks.
        const names = await listAllStackNames();
        for (const n of names) {
          if (n === stackName) continue;
          const p = getStackRuntimeStatePath(n);
          // eslint-disable-next-line no-await-in-loop
          const st = await readStackRuntimeStateFile(p);
          const pid = Number(st?.ownerPid);
          if (!isPidAlive(pid)) continue;
          const ports = st?.ports && typeof st.ports === 'object' ? st.ports : {};
          for (const v of Object.values(ports)) {
            const num = Number(v);
            if (Number.isFinite(num) && num > 0) reserved.add(num);
          }
        }

        const startPort = getDefaultPortStart();
        const ports = {};

        const parsePortOrNull = (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n > 0 ? n : null;
        };
        const candidatePorts =
          isTrueRestart && existingPorts
            ? {
                server: parsePortOrNull(existingPorts.server),
                backend: parsePortOrNull(existingPorts.backend),
                pg: parsePortOrNull(existingPorts.pg),
                redis: parsePortOrNull(existingPorts.redis),
                minio: parsePortOrNull(existingPorts.minio),
                minioConsole: parsePortOrNull(existingPorts.minioConsole),
              }
            : null;

        const canReuse =
          candidatePorts &&
          candidatePorts.server &&
          (serverComponent !== 'happy-server' || candidatePorts.backend) &&
          (!managedInfra ||
            (candidatePorts.pg && candidatePorts.redis && candidatePorts.minio && candidatePorts.minioConsole));

        if (canReuse) {
          ports.server = candidatePorts.server;
          if (serverComponent === 'happy-server') {
            ports.backend = candidatePorts.backend;
            if (managedInfra) {
              ports.pg = candidatePorts.pg;
              ports.redis = candidatePorts.redis;
              ports.minio = candidatePorts.minio;
              ports.minioConsole = candidatePorts.minioConsole;
            }
          }

          // Fail-closed if any of the reused ports are unexpectedly occupied (prevents cross-stack collisions).
          const toCheck = Object.values(ports)
            .map((n) => Number(n))
            .filter((n) => Number.isFinite(n) && n > 0);
          for (const p of toCheck) {
            // eslint-disable-next-line no-await-in-loop
            if (!(await isTcpPortFree(p))) {
              throw new Error(
                `[stack] ${stackName}: cannot reuse port ${p} on restart (port is not free).\n` +
                  `[stack] Fix: stop the process using it, or re-run without --restart to allocate new ports.`
              );
            }
          }
        } else {
          ports.server = await pickNextFreeTcpPort(startPort, { reservedPorts: reserved });
          reserved.add(ports.server);

          if (serverComponent === 'happy-server') {
            ports.backend = await pickNextFreeTcpPort(ports.server + 10, { reservedPorts: reserved });
            reserved.add(ports.backend);
            if (managedInfra) {
              ports.pg = await pickNextFreeTcpPort(ports.server + 1000, { reservedPorts: reserved });
              reserved.add(ports.pg);
              ports.redis = await pickNextFreeTcpPort(ports.pg + 1, { reservedPorts: reserved });
              reserved.add(ports.redis);
              ports.minio = await pickNextFreeTcpPort(ports.redis + 1, { reservedPorts: reserved });
              reserved.add(ports.minio);
              ports.minioConsole = await pickNextFreeTcpPort(ports.minio + 1, { reservedPorts: reserved });
              reserved.add(ports.minioConsole);
            }
          }
        }

        // Sanity: if somehow the server port is now occupied, fail closed (avoids killPortListeners nuking random processes).
        if (!(await isTcpPortFree(Number(ports.server)))) {
          throw new Error(`[stack] ${stackName}: picked server port ${ports.server} but it is not free`);
        }

        const childEnv = {
          ...env,
          HAPPY_STACKS_EPHEMERAL_PORTS: '1',
          HAPPY_LOCAL_EPHEMERAL_PORTS: '1',
          HAPPY_STACKS_SERVER_PORT: String(ports.server),
          HAPPY_LOCAL_SERVER_PORT: String(ports.server),
          ...(serverComponent === 'happy-server' && ports.backend
            ? {
                HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT: String(ports.backend),
                HAPPY_LOCAL_HAPPY_SERVER_BACKEND_PORT: String(ports.backend),
              }
            : {}),
          ...(managedInfra && ports.pg
            ? {
                HAPPY_STACKS_PG_PORT: String(ports.pg),
                HAPPY_LOCAL_PG_PORT: String(ports.pg),
                HAPPY_STACKS_REDIS_PORT: String(ports.redis),
                HAPPY_LOCAL_REDIS_PORT: String(ports.redis),
                HAPPY_STACKS_MINIO_PORT: String(ports.minio),
                HAPPY_LOCAL_MINIO_PORT: String(ports.minio),
                HAPPY_STACKS_MINIO_CONSOLE_PORT: String(ports.minioConsole),
                HAPPY_LOCAL_MINIO_CONSOLE_PORT: String(ports.minioConsole),
              }
            : {}),
        };

        // Spawn the runner (long-lived) and record its pid + ports for other stack-scoped commands.
        const child = spawn(process.execPath, [join(rootDir, 'scripts', scriptPath), ...args], {
          cwd: rootDir,
          env: childEnv,
          stdio: 'inherit',
          shell: false,
        });

        // Record the chosen ports immediately (before the runner finishes booting), so other stack commands
        // can resolve the correct endpoints and `--restart` can reliably reuse the same ports.
        await recordStackRuntimeStart(runtimeStatePath, {
          stackName,
          script: scriptPath,
          ephemeral: true,
          ownerPid: child.pid,
          ports,
        }).catch(() => {});

        try {
          await new Promise((resolvePromise, rejectPromise) => {
            child.on('error', rejectPromise);
            child.on('exit', (code, sig) => {
              if (code === 0) return resolvePromise();
              return rejectPromise(new Error(`stack ${scriptPath} exited (code=${code ?? 'null'}, sig=${sig ?? 'null'})`));
            });
          });
        } finally {
          const cur = await readStackRuntimeStateFile(runtimeStatePath);
          if (Number(cur?.ownerPid) === Number(child.pid)) {
            await deleteStackRuntimeStateFile(runtimeStatePath);
          }
        }
        return;
      }

      // Pinned port stack: run normally under the pinned env.
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

  if (Object.keys(overrides).length > 0) {
    // Mark these as transient so scripts/utils/env.mjs won't clobber them when it loads the stack env file.
    overrides.HAPPY_STACKS_TRANSIENT_COMPONENT_OVERRIDES = '1';
    overrides.HAPPY_LOCAL_TRANSIENT_COMPONENT_OVERRIDES = '1';
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
  try {
    const names = (await listAllStackNames()).filter((n) => n !== 'main');
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

async function cmdAudit({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const fix = flags.has('--fix');
  const fixMain = flags.has('--fix-main');
  const fixPorts = flags.has('--fix-ports');
  const fixWorkspace = flags.has('--fix-workspace');
  const fixPaths = flags.has('--fix-paths');
  const unpinPorts = flags.has('--unpin-ports');
  const unpinPortsExceptRaw = (kv.get('--unpin-ports-except') ?? '').trim();
  const unpinPortsExcept = new Set(
    unpinPortsExceptRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const wantsEnvRepair = Boolean(fix || fixWorkspace || fixPaths);

  const stacks = await listAllStackNames();

  const report = [];
  const ports = new Map(); // port -> [stackName]
  const otherWorkspaceRoot = join(getHappyStacksHomeDir(), 'workspace');

  for (const stackName of stacks) {
    const resolved = resolveStackEnvPath(stackName);
    const envPath = resolved.envPath;
    const baseDir = resolved.baseDir;

    let raw = await readExistingEnv(envPath);
    let env = parseEnvToObject(raw);

    // If the env file is missing/empty, optionally reconstruct a safe baseline env.
    if (!raw.trim() && wantsEnvRepair && (stackName !== 'main' || fixMain)) {
      const serverComponent =
        getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') ||
        getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') ||
        'happy-server-light';
      const expectedUi = join(baseDir, 'ui');
      const expectedCli = join(baseDir, 'cli');
      // Port strategy: main is pinned by convention; non-main stacks default to ephemeral ports.
      const reservedPorts = stackName === 'main' ? await collectReservedStackPorts({ excludeStackName: stackName }) : new Set();
      const port = stackName === 'main' ? await pickNextFreePort(getDefaultPortStart(), { reservedPorts }) : null;

      const nextEnv = {
        HAPPY_STACKS_STACK: stackName,
        HAPPY_STACKS_SERVER_COMPONENT: serverComponent,
        HAPPY_STACKS_UI_BUILD_DIR: expectedUi,
        HAPPY_STACKS_CLI_HOME_DIR: expectedCli,
        HAPPY_STACKS_STACK_REMOTE: 'upstream',
        ...resolveDefaultComponentDirs({ rootDir }),
      };
      if (port != null) {
        nextEnv.HAPPY_STACKS_SERVER_PORT = String(port);
      }

      if (serverComponent === 'happy-server-light') {
        const dataDir = join(baseDir, 'server-light');
        nextEnv.HAPPY_SERVER_LIGHT_DATA_DIR = dataDir;
        nextEnv.HAPPY_SERVER_LIGHT_FILES_DIR = join(dataDir, 'files');
        nextEnv.DATABASE_URL = `file:${join(dataDir, 'happy-server-light.sqlite')}`;
      }

      await writeStackEnv({ stackName, env: nextEnv });
      raw = await readExistingEnv(envPath);
      env = parseEnvToObject(raw);
    }

    // Optional: unpin ports for non-main stacks (ephemeral port model).
    if (unpinPorts && stackName !== 'main' && !unpinPortsExcept.has(stackName) && raw.trim()) {
      const serverComponentTmp =
        getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';
      const remove = [
        // Always remove pinned public server port.
        'HAPPY_STACKS_SERVER_PORT',
        'HAPPY_LOCAL_SERVER_PORT',
        // Happy-server gateway/backend ports.
        'HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT',
        'HAPPY_LOCAL_HAPPY_SERVER_BACKEND_PORT',
        // Managed infra ports.
        'HAPPY_STACKS_PG_PORT',
        'HAPPY_LOCAL_PG_PORT',
        'HAPPY_STACKS_REDIS_PORT',
        'HAPPY_LOCAL_REDIS_PORT',
        'HAPPY_STACKS_MINIO_PORT',
        'HAPPY_LOCAL_MINIO_PORT',
        'HAPPY_STACKS_MINIO_CONSOLE_PORT',
        'HAPPY_LOCAL_MINIO_CONSOLE_PORT',
      ];
      if (serverComponentTmp === 'happy-server') {
        // These are derived from the ports above; safe to re-compute at start time.
        remove.push('DATABASE_URL', 'REDIS_URL', 'S3_PORT', 'S3_PUBLIC_URL');
      }
      await ensureEnvFilePruned({ envPath, removeKeys: remove });
      raw = await readExistingEnv(envPath);
      env = parseEnvToObject(raw);
    }

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
    } else if (uiBuildDir !== expectedUi) {
      issues.push({ code: 'ui_build_dir_mismatch', message: `UI build dir points to ${uiBuildDir} (expected ${expectedUi})` });
    }

    const stacksCli = getEnvValue(env, 'HAPPY_STACKS_CLI_HOME_DIR');
    const localCli = getEnvValue(env, 'HAPPY_LOCAL_CLI_HOME_DIR');
    const cliHomeDir = stacksCli || localCli;
    const expectedCli = join(baseDir, 'cli');
    if (!cliHomeDir) {
      issues.push({ code: 'missing_cli_home_dir', message: `missing CLI home dir (expected ${expectedCli})` });
    } else if (cliHomeDir !== expectedCli) {
      issues.push({ code: 'cli_home_dir_mismatch', message: `CLI home dir points to ${cliHomeDir} (expected ${expectedCli})` });
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

    // Workspace/component dir hygiene checks (best-effort).
    const componentDirKeys = [
      { component: 'happy', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY' },
      { component: 'happy-cli', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI' },
      { component: 'happy-server-light', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT' },
      { component: 'happy-server', key: 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER' },
    ];
    for (const { component, key } of componentDirKeys) {
      const legacyKey = key.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
      const v = getEnvValue(env, key) || getEnvValue(env, legacyKey);
      if (!v) continue;
      if (!isAbsolute(v)) {
        issues.push({ code: 'relative_component_dir', message: `${key} is relative (${v}); prefer absolute paths under this workspace` });
        continue;
      }
      const norm = v.replaceAll('\\', '/');
      if (norm.startsWith(otherWorkspaceRoot.replaceAll('\\', '/') + '/')) {
        issues.push({ code: 'foreign_workspace_component_dir', message: `${key} points to another workspace: ${v}` });
        continue;
      }
      const rootNorm = resolve(rootDir).replaceAll('\\', '/') + '/';
      if (norm.includes('/components/') && !norm.startsWith(rootNorm)) {
        issues.push({ code: 'external_component_dir', message: `${key} points outside current workspace: ${v}` });
      }
      // Optional: fail-closed existence check.
      if (!existsSync(v)) {
        issues.push({ code: 'missing_component_path', message: `${key} path does not exist: ${v}` });
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
      if (dataDir && dataDir !== expectedDataDir) issues.push({ code: 'server_light_data_dir_mismatch', message: `HAPPY_SERVER_LIGHT_DATA_DIR=${dataDir} (expected ${expectedDataDir})` });
      if (filesDir && filesDir !== expectedFilesDir) issues.push({ code: 'server_light_files_dir_mismatch', message: `HAPPY_SERVER_LIGHT_FILES_DIR=${filesDir} (expected ${expectedFilesDir})` });
      if (dbUrl && dbUrl !== expectedDbUrl) issues.push({ code: 'database_url_mismatch', message: `DATABASE_URL=${dbUrl} (expected ${expectedDbUrl})` });

    }

    // Best-effort env repair (opt-in; non-main stacks only by default).
    if ((fix || fixWorkspace || fixPaths) && (stackName !== 'main' || fixMain) && raw.trim()) {
      const updates = [];

      // Always ensure stack directories are explicitly pinned when missing.
      if (!stacksUi && !localUi) updates.push({ key: 'HAPPY_STACKS_UI_BUILD_DIR', value: expectedUi });
      if (!stacksCli && !localCli) updates.push({ key: 'HAPPY_STACKS_CLI_HOME_DIR', value: expectedCli });
      if (fixPaths) {
        if (uiBuildDir && uiBuildDir !== expectedUi) updates.push({ key: 'HAPPY_STACKS_UI_BUILD_DIR', value: expectedUi });
        if (cliHomeDir && cliHomeDir !== expectedCli) updates.push({ key: 'HAPPY_STACKS_CLI_HOME_DIR', value: expectedCli });
      }

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
        if (!dataDir || (fixPaths && dataDir !== expectedDataDir)) updates.push({ key: 'HAPPY_SERVER_LIGHT_DATA_DIR', value: expectedDataDir });
        if (!filesDir || (fixPaths && filesDir !== expectedFilesDir)) updates.push({ key: 'HAPPY_SERVER_LIGHT_FILES_DIR', value: expectedFilesDir });
        if (!dbUrl || (fixPaths && dbUrl !== expectedDbUrl)) updates.push({ key: 'DATABASE_URL', value: expectedDbUrl });
      }

      if (fixWorkspace) {
        const otherNorm = otherWorkspaceRoot.replaceAll('\\', '/') + '/';
        for (const { component, key } of componentDirKeys) {
          const legacyKey = key.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
          const current = getEnvValue(env, key) || getEnvValue(env, legacyKey);
          if (!current) continue;

          let next = current;
          if (!isAbsolute(next) && next.startsWith('components/')) {
            next = resolve(rootDir, next);
          }
          const norm = next.replaceAll('\\', '/');
          if (norm.startsWith(otherNorm)) {
            // Map any path under ~/.happy-stacks/workspace/... back into this repo root.
            const rel = norm.slice(otherNorm.length);
            const candidate = resolve(rootDir, rel);
            if (existsSync(candidate)) {
              next = candidate;
            } else if (rel.includes('/components/.worktrees/')) {
              // Attempt to recreate the referenced worktree inside this workspace.
              const marker = '/components/.worktrees/';
              const idx = rel.indexOf(marker);
              const rest = rel.slice(idx + marker.length); // <component>/<owner>/<slug...>
              const parts = rest.split('/').filter(Boolean);
              if (parts.length >= 3) {
                const comp = parts[0];
                const owner = parts[1];
                const slug = parts.slice(2).join('/');
                const remoteName = owner === 'slopus' ? 'upstream' : 'origin';
                try {
                  // eslint-disable-next-line no-await-in-loop
                  next = await createWorktree({ rootDir, component: comp, slug, remoteName });
                } catch {
                  // Fall back to candidate path (even if missing) and let other checks surface it.
                  next = candidate;
                }
              } else {
                next = candidate;
              }
            } else {
              next = candidate;
            }
          }

          if (next !== current) {
            updates.push({ key, value: next });
          }
        }
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
  const collisions = [];
  for (const [port, names] of ports.entries()) {
    if (names.length <= 1) continue;
    collisions.push({ port, names: Array.from(names) });
  }

  // Optional: fix collisions by reassigning ports (non-main stacks only by default).
  if (fixPorts) {
    const allowMain = Boolean(fixMain);
    const planned = await collectReservedStackPorts();
    const byName = new Map(report.map((r) => [r.stackName, r]));

    const parsePg = (url) => {
      try {
        const u = new URL(url);
        const db = u.pathname?.replace(/^\//, '') || '';
        return {
          user: decodeURIComponent(u.username || ''),
          password: decodeURIComponent(u.password || ''),
          db,
          host: u.hostname || '127.0.0.1',
        };
      } catch {
        return null;
      }
    };

    for (const c of collisions) {
      const names = c.names.slice().sort();
      // Keep the first stack stable; reassign others to reduce churn.
      const keep = names[0];
      for (const stackName of names.slice(1)) {
        if (stackName === 'main' && !allowMain) {
          continue;
        }
        const entry = byName.get(stackName);
        if (!entry) continue;
        if (!entry.envPath) continue;
        const raw = await readExistingEnv(entry.envPath);
        if (!raw.trim()) continue;
        const env = parseEnvToObject(raw);

        const serverComponent =
          getEnvValue(env, 'HAPPY_STACKS_SERVER_COMPONENT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_COMPONENT') || 'happy-server-light';
        const portRaw = getEnvValue(env, 'HAPPY_STACKS_SERVER_PORT') || getEnvValue(env, 'HAPPY_LOCAL_SERVER_PORT');
        const currentPort = portRaw ? Number(portRaw) : NaN;
        if (Number.isFinite(currentPort) && currentPort > 0) {
          // Fail-safe: don't rewrite ports for a stack that appears to be actively running.
          // Otherwise we can strand a running server/daemon on a now-stale port.
          // eslint-disable-next-line no-await-in-loop
          const free = await isPortFree(currentPort);
          if (!free) {
            entry.issues.push({
              code: 'port_fix_skipped_running',
              message: `skipped port reassignment because port ${currentPort} is currently in use (stop the stack and re-run --fix-ports)`,
            });
            continue;
          }
        }
        const startFrom = Number.isFinite(currentPort) && currentPort > 0 ? currentPort + 1 : getDefaultPortStart();

        const updates = [];
        const newServerPort = await pickNextFreePort(startFrom, { reservedPorts: planned });
        planned.add(newServerPort);
        updates.push({ key: 'HAPPY_STACKS_SERVER_PORT', value: String(newServerPort) });

        if (serverComponent === 'happy-server') {
          planned.add(newServerPort);
          const backendPort = await pickNextFreePort(newServerPort + 10, { reservedPorts: planned });
          planned.add(backendPort);
          const pgPort = await pickNextFreePort(newServerPort + 1000, { reservedPorts: planned });
          planned.add(pgPort);
          const redisPort = await pickNextFreePort(pgPort + 1, { reservedPorts: planned });
          planned.add(redisPort);
          const minioPort = await pickNextFreePort(redisPort + 1, { reservedPorts: planned });
          planned.add(minioPort);
          const minioConsolePort = await pickNextFreePort(minioPort + 1, { reservedPorts: planned });
          planned.add(minioConsolePort);

          updates.push({ key: 'HAPPY_STACKS_HAPPY_SERVER_BACKEND_PORT', value: String(backendPort) });
          updates.push({ key: 'HAPPY_STACKS_PG_PORT', value: String(pgPort) });
          updates.push({ key: 'HAPPY_STACKS_REDIS_PORT', value: String(redisPort) });
          updates.push({ key: 'HAPPY_STACKS_MINIO_PORT', value: String(minioPort) });
          updates.push({ key: 'HAPPY_STACKS_MINIO_CONSOLE_PORT', value: String(minioConsolePort) });

          // Update URLs while preserving existing credentials.
          const pgUser = getEnvValue(env, 'HAPPY_STACKS_PG_USER') || 'handy';
          const pgPassword = getEnvValue(env, 'HAPPY_STACKS_PG_PASSWORD') || '';
          const pgDb = getEnvValue(env, 'HAPPY_STACKS_PG_DATABASE') || 'handy';
          let user = pgUser;
          let pass = pgPassword;
          let db = pgDb;
          const parsed = parsePg(getEnvValue(env, 'DATABASE_URL'));
          if (parsed) {
            if (parsed.user) user = parsed.user;
            if (parsed.password) pass = parsed.password;
            if (parsed.db) db = parsed.db;
          }
          const databaseUrl = `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@127.0.0.1:${pgPort}/${encodeURIComponent(db)}`;
          updates.push({ key: 'DATABASE_URL', value: databaseUrl });
          updates.push({ key: 'REDIS_URL', value: `redis://127.0.0.1:${redisPort}` });
          updates.push({ key: 'S3_PORT', value: String(minioPort) });
          const bucket = getEnvValue(env, 'S3_BUCKET') || sanitizeDnsLabel(`happy-${stackName}`, { fallback: 'happy' });
          updates.push({ key: 'S3_PUBLIC_URL', value: `http://127.0.0.1:${minioPort}/${bucket}` });
        }

        await ensureEnvFileUpdated({ envPath: entry.envPath, updates });

        // Update in-memory report for follow-up collision recomputation.
        entry.serverPort = newServerPort;
        entry.issues.push({ code: 'port_reassigned', message: `server port reassigned -> ${newServerPort} (was ${currentPort || 'unknown'})` });
      }
      // Ensure the "kept" one remains reserved in planned as well.
      const keptEntry = byName.get(keep);
      if (keptEntry?.serverPort) planned.add(keptEntry.serverPort);
    }
  }

  // Recompute port collisions after optional fixes.
  for (const r of report) {
    r.issues = (r.issues ?? []).filter((i) => i.code !== 'port_collision');
  }
  const portsNow = new Map();
  for (const r of report) {
    if (!Number.isFinite(r.serverPort) || r.serverPort == null) continue;
    const existing = portsNow.get(r.serverPort) ?? [];
    existing.push(r.stackName);
    portsNow.set(r.serverPort, existing);
  }
  for (const [port, names] of portsNow.entries()) {
    if (names.length <= 1) continue;
    for (const r of report) {
      if (r.serverPort === port) {
        r.issues.push({ code: 'port_collision', message: `server port ${port} is also used by: ${names.filter((n) => n !== r.stackName).join(', ')}` });
      }
    }
  }

  const out = {
    ok: true,
    fixed: Boolean(fix || fixPorts || fixWorkspace || fixPaths || unpinPorts),
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

async function cmdCreateDevAuthSeed({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const name = (positionals[1] ?? '').trim() || 'dev-auth';
  const serverComponent = (kv.get('--server') ?? '').trim() || 'happy-server-light';
  const interactive = !flags.has('--non-interactive') && (flags.has('--interactive') || isTty());

  if (json) {
    // Keep JSON mode non-interactive and stable by using the existing stack command output.
    // (We intentionally don't run the guided login flow in JSON mode.)
    const createArgs = ['new', name, '--no-copy-auth', '--server', serverComponent, '--json'];
    const created = await runCapture(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), ...createArgs], { cwd: rootDir, env: process.env }).catch((e) => {
      throw new Error(
        `[stack] create-dev-auth-seed: failed to create auth seed stack "${name}": ${e instanceof Error ? e.message : String(e)}`
      );
    });

    printResult({
      json,
      data: {
        ok: true,
        seedStack: name,
        serverComponent,
        created: created.trim() ? JSON.parse(created.trim()) : { ok: true },
        next: {
          login: `happys stack auth ${name} login`,
          setEnv: `# add to ${getHomeEnvLocalPath()}:\nHAPPY_STACKS_AUTH_SEED_FROM=${name}\nHAPPY_STACKS_AUTO_AUTH_SEED=1`,
          reseedAll: `happys auth copy-from ${name} --all --except=main,${name}`,
        },
      },
    });
    return;
  }

  // Create the seed stack as fresh auth (no copy) so it doesn't share main identity.
  // IMPORTANT: do this in-process (no recursive spawn) so the env file is definitely written
  // before we run any guided steps (withStackEnv/login).
  if (!stackExistsSync(name)) {
    await cmdNew({
      rootDir,
      argv: [name, '--no-copy-auth', '--server', serverComponent],
    });
  } else {
    console.log(`[stack] auth seed stack already exists: ${name}`);
  }

  if (!stackExistsSync(name)) {
    throw new Error(`[stack] create-dev-auth-seed: expected stack "${name}" to exist after creation, but it does not`);
  }

  // Interactive convenience: guide login first, then configure env.local + store dev key.
  if (interactive) {
    await withRl(async (rl) => {
      let savedDevKey = false;
      const wantLoginRaw = (await prompt(
        rl,
        `Run guided login now? (starts the seed server temporarily for this stack) (Y/n): `,
        { defaultValue: 'y' }
      ))
        .trim()
        .toLowerCase();
      const wantLogin = wantLoginRaw === 'y' || wantLoginRaw === 'yes' || wantLoginRaw === '';

      if (wantLogin) {
        console.log('');
        console.log(`[stack] starting ${serverComponent} temporarily so we can log in...`);

        const serverPort = await pickNextFreeTcpPort(3005, { host: '127.0.0.1' });
        const internalServerUrl = `http://127.0.0.1:${serverPort}`;
        const publicServerUrl = `http://localhost:${serverPort}`;

        const autostart = { stackName: name, baseDir: getStackDir(name) };
        const children = [];

        await withStackEnv({
          stackName: name,
          extraEnv: {
            // Make sure stack auth login uses the same port we just picked, and avoid inheriting
            // any global/public URL (e.g. main stack’s Tailscale URL) for this guided flow.
            HAPPY_STACKS_SERVER_PORT: String(serverPort),
            HAPPY_LOCAL_SERVER_PORT: String(serverPort),
            HAPPY_STACKS_SERVER_URL: '',
            HAPPY_LOCAL_SERVER_URL: '',
          },
          fn: async ({ env }) => {
            const serverDir =
              serverComponent === 'happy-server'
                ? env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER
                : env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT;
            const resolvedServerDir = serverDir || getComponentDir(rootDir, serverComponent);
            const resolvedCliDir = env.HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI || getComponentDir(rootDir, 'happy-cli');
            const resolvedUiDir = env.HAPPY_STACKS_COMPONENT_DIR_HAPPY || getComponentDir(rootDir, 'happy');

            await requireDir(serverComponent, resolvedServerDir);
            await requireDir('happy-cli', resolvedCliDir);
            await requireDir('happy', resolvedUiDir);

            let serverProc = null;
            let uiProc = null;
            try {
              const started = await startDevServer({
                serverComponentName: serverComponent,
                serverDir: resolvedServerDir,
                autostart,
                baseEnv: env,
                serverPort,
                internalServerUrl,
                publicServerUrl,
                envPath: env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '',
                stackMode: true,
                runtimeStatePath: null,
                serverAlreadyRunning: false,
                restart: true,
                children,
                spawnOptions: { stdio: 'ignore' },
              });
              serverProc = started.serverProc;

              // Start Expo web UI so /terminal/connect exists for happy-cli web auth.
              const uiRes = await startDevExpoWebUi({
                startUi: true,
                uiDir: resolvedUiDir,
                autostart,
                baseEnv: env,
                // In the browser, prefer localhost for API calls.
                apiServerUrl: publicServerUrl,
                restart: false,
                stackMode: true,
                runtimeStatePath: null,
                stackName: name,
                envPath: env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '',
                children,
                spawnOptions: { stdio: 'ignore' },
              });
              if (uiRes?.skipped === false && uiRes.proc) {
                uiProc = uiRes.proc;
              }

              console.log('');
              const uiHost = `happy-${sanitizeDnsLabel(name)}.localhost`;
              const uiPort = uiRes?.port;
              const uiRoot = Number.isFinite(uiPort) && uiPort > 0 ? `http://${uiHost}:${uiPort}` : null;
              const uiRootLocalhost = Number.isFinite(uiPort) && uiPort > 0 ? `http://localhost:${uiPort}` : null;
              const uiSettings = uiRoot ? `${uiRoot}/settings/account` : null;

              console.log('[stack] step 1/3: create a dev-auth account in the UI (this generates the dev key)');
              if (uiRoot) {
                console.log(`[stack] waiting for UI to be ready...`);
                // Prefer localhost for readiness checks (faster/more reliable), even though we
                // instruct the user to use the stack-scoped *.localhost origin for storage isolation.
                await waitForHttpOk(uiRootLocalhost || uiRoot, { timeoutMs: 30_000 });
                console.log(`- open: ${uiRoot}`);
                console.log(`- click: "Create Account"`);
                console.log(`- then open: ${uiSettings}`);
                console.log(`- tap: "Secret Key" to reveal + copy it`);
              } else {
                console.log(`- UI is running but the port was not detected; rerun with DEBUG logs if needed`);
              }
              await prompt(rl, `Press Enter once you've created the account in the UI... `);

              console.log('');
              console.log('[stack] step 2/3: save the dev key locally (for agents / Playwright)');
              const keyInput = (await prompt(
                rl,
                `Paste the Secret Key now (from Settings → Account → Secret Key). Leave empty to skip: `
              )).trim();
              if (keyInput) {
                const res = await writeDevAuthKey({ env: process.env, input: keyInput });
                savedDevKey = true;
                console.log(`[stack] dev key saved: ${res.path}`);
              } else {
                console.log(`[stack] dev key not saved; you can do it later with: happys auth dev-key --set="<key>"`);
              }

              console.log('');
              console.log('[stack] step 3/3: authenticate the CLI against this stack (web auth)');
              console.log(`[stack] launching: happys stack auth ${name} login`);
              await run(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), 'login', '--no-force'], {
                cwd: rootDir,
                env,
              });
            } finally {
              if (uiProc) {
                console.log('');
                console.log(`[stack] stopping temporary UI (pid=${uiProc.pid})...`);
                killProcessTree(uiProc, 'SIGINT');
                await Promise.race([
                  new Promise((resolve) => uiProc.on('exit', resolve)),
                  new Promise((resolve) => setTimeout(resolve, 15_000)),
                ]);
              }
              if (serverProc) {
                console.log('');
                console.log(`[stack] stopping temporary server (pid=${serverProc.pid})...`);
                killProcessTree(serverProc, 'SIGINT');
                await Promise.race([
                  new Promise((resolve) => serverProc.on('exit', resolve)),
                  new Promise((resolve) => setTimeout(resolve, 15_000)),
                ]);
              }
            }
          },
        });

        console.log('');
        console.log('[stack] login step complete.');
      } else {
        console.log(`[stack] skipping guided login. You can do it later with: happys stack auth ${name} login`);
      }

      const wantEnvRaw = (await prompt(
        rl,
        `Set this as the default auth seed (writes ${getHomeEnvLocalPath()})? (Y/n): `,
        { defaultValue: 'y' }
      ))
        .trim()
        .toLowerCase();
      const wantEnv = wantEnvRaw === 'y' || wantEnvRaw === 'yes' || wantEnvRaw === '';
      if (wantEnv) {
        const envLocalPath = getHomeEnvLocalPath();
        await ensureEnvFileUpdated({
          envPath: envLocalPath,
          updates: [
            { key: 'HAPPY_STACKS_AUTH_SEED_FROM', value: name },
            { key: 'HAPPY_STACKS_AUTO_AUTH_SEED', value: '1' },
          ],
        });
        console.log(`[stack] updated: ${envLocalPath}`);
      } else {
        console.log(`[stack] tip: set in ${getHomeEnvLocalPath()}: HAPPY_STACKS_AUTH_SEED_FROM=${name} and HAPPY_STACKS_AUTO_AUTH_SEED=1`);
      }

      if (!savedDevKey) {
        const wantKey = (await prompt(rl, `Save the dev auth key for Playwright/UI logins now? (y/N): `)).trim().toLowerCase();
        if (wantKey === 'y' || wantKey === 'yes') {
          console.log(`[stack] paste the secret key (base64url OR backup-format like XXXXX-XXXXX-...):`);
          const input = (await prompt(rl, `dev key: `)).trim();
          if (input) {
            try {
              const res = await writeDevAuthKey({ env: process.env, input });
              console.log(`[stack] dev key saved: ${res.path}`);
            } catch (e) {
              console.warn(`[stack] dev key not saved: ${e instanceof Error ? e.message : String(e)}`);
            }
          } else {
            console.log('[stack] dev key not provided; skipping');
          }
        } else {
          console.log(`[stack] tip: you can set it later with: happys auth dev-key --set="<key>"`);
        }
      }
    });
  } else {
    console.log(`- set as default seed (recommended) in ${getHomeEnvLocalPath()}:`);
    console.log(`  HAPPY_STACKS_AUTH_SEED_FROM=${name}`);
    console.log(`  HAPPY_STACKS_AUTO_AUTH_SEED=1`);
    console.log(`- (optional) seed existing stacks: happys auth copy-from ${name} --all --except=main,${name}`);
    console.log(`- (optional) store dev key for UI automation: happys auth dev-key --set="<key>"`);
  }
}

function parseServerComponentFromEnv(env) {
  const v =
    (env.HAPPY_STACKS_SERVER_COMPONENT ?? env.HAPPY_LOCAL_SERVER_COMPONENT ?? '').toString().trim() ||
    'happy-server-light';
  return v === 'happy-server' ? 'happy-server' : 'happy-server-light';
}

async function readStackEnvObject(stackName) {
  const envPath = getStackEnvPath(stackName);
  const raw = await readExistingEnv(envPath);
  const env = raw ? parseEnvToObject(raw) : {};
  return { envPath, env };
}

function envKeyForComponentDir({ serverComponent, component }) {
  if (component === 'happy') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY';
  if (component === 'happy-cli') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI';
  if (component === 'happy-server') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER';
  if (component === 'happy-server-light') return 'HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT';
  // Fallback; caller should not use.
  return `HAPPY_STACKS_COMPONENT_DIR_${component.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function sanitizeSlugPart(s) {
  return String(s ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

async function cmdDuplicate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const fromStack = (positionals[1] ?? '').trim();
  const toStack = (positionals[2] ?? '').trim();
  if (!fromStack || !toStack) {
    throw new Error('[stack] usage: happys stack duplicate <from> <to> [--duplicate-worktrees] [--deps=...] [--json]');
  }
  if (toStack === 'main') {
    throw new Error('[stack] refusing to duplicate into stack name "main"');
  }
  if (!stackExistsSync(fromStack)) {
    throw new Error(`[stack] duplicate: source stack does not exist: ${fromStack}`);
  }
  if (stackExistsSync(toStack)) {
    throw new Error(`[stack] duplicate: destination stack already exists: ${toStack}`);
  }

  const duplicateWorktrees =
    flags.has('--duplicate-worktrees') ||
    flags.has('--with-worktrees') ||
    (kv.get('--duplicate-worktrees') ?? '').trim() === '1';
  const depsMode = (kv.get('--deps') ?? '').trim(); // forwarded to wt new when duplicating worktrees

  const { env: fromEnv } = await readStackEnvObject(fromStack);
  const serverComponent = parseServerComponentFromEnv(fromEnv);

  // Create the destination stack env with the correct baseDir and defaults (do not copy auth/data).
  await cmdNew({
    rootDir,
    argv: [toStack, '--no-copy-auth', '--server', serverComponent],
  });

  // Build component dir updates (copy overrides; optionally duplicate worktrees).
  // Copy all component directory overrides, not just the currently-selected server flavor.
  // This keeps the duplicated stack fully self-contained even if you later switch server flavor.
  const components = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

  const updates = [];
  for (const component of components) {
    const key = envKeyForComponentDir({ serverComponent, component });
    const legacyKey = key.replace('HAPPY_STACKS_', 'HAPPY_LOCAL_');
    const rawDir = (fromEnv[key] ?? fromEnv[legacyKey] ?? '').toString().trim();
    if (!rawDir) continue;

    let nextDir = rawDir;
    if (duplicateWorktrees && isComponentWorktreePath({ rootDir, component, dir: rawDir })) {
      const spec = worktreeSpecFromDir({ rootDir, component, dir: rawDir });
      if (spec) {
        const [owner, ...restParts] = spec.split('/').filter(Boolean);
        const rest = restParts.join('/');
        const slug = `dup/${sanitizeSlugPart(toStack)}/${rest}`;

        const repoDir = join(getComponentsDir(rootDir), component);
        const remoteName = await inferRemoteNameForOwner({ repoDir, owner });
        // Base on the existing worktree's HEAD/branch so we get the same commit.
        nextDir = await createWorktreeFromBaseWorktree({
          rootDir,
          component,
          slug,
          baseWorktreeSpec: spec,
          remoteName,
          depsMode,
        });
      }
    }

    updates.push({ key, value: nextDir });
  }

  // Apply component dir overrides to the destination stack env file.
  const toEnvPath = getStackEnvPath(toStack);
  if (updates.length) {
    await ensureEnvFileUpdated({ envPath: toEnvPath, updates });
  }

  const out = {
    ok: true,
    from: fromStack,
    to: toStack,
    serverComponent,
    duplicatedWorktrees: duplicateWorktrees,
    updatedKeys: updates.map((u) => u.key),
    envPath: toEnvPath,
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log(`[stack] duplicated: ${fromStack} -> ${toStack}`);
  console.log(`[stack] env: ${toEnvPath}`);
  if (duplicateWorktrees) {
    console.log(`[stack] worktrees: duplicated (deps=${depsMode || 'none'})`);
  } else {
    console.log('[stack] worktrees: not duplicated (reusing existing component dirs)');
  }
}

async function cmdInfo({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const stackName = (positionals[1] ?? '').trim();
  if (!stackName) {
    throw new Error('[stack] usage: happys stack info <name> [--json]');
  }
  if (!stackExistsSync(stackName)) {
    throw new Error(`[stack] info: stack does not exist: ${stackName}`);
  }

  const out = await cmdInfoInternal({ rootDir, stackName });
  if (json) {
    printResult({ json, data: out });
    return;
  }

  console.log(`[stack] info: ${stackName}`);
  console.log(`- env: ${out.envPath}`);
  console.log(`- runtime: ${out.runtimeStatePath}`);
  console.log(`- server: ${out.serverComponent}`);
  console.log(`- running: ${out.runtime.running ? 'yes' : 'no'}${out.runtime.ownerPid ? ` (pid=${out.runtime.ownerPid})` : ''}`);
  if (out.ports.server) console.log(`- port: server=${out.ports.server}${out.ports.backend ? ` backend=${out.ports.backend}` : ''}`);
  if (out.ports.ui) console.log(`- port: ui=${out.ports.ui}`);
  if (out.urls.uiUrl) console.log(`- ui: ${out.urls.uiUrl}`);
  if (out.urls.internalServerUrl) console.log(`- internal: ${out.urls.internalServerUrl}`);
  if (out.pinned.serverPort) console.log(`- pinned: serverPort=${out.pinned.serverPort}`);
  console.log('- components:');
  for (const c of out.components) {
    console.log(`  - ${c.component}: ${c.dir}${c.worktreeSpec ? ` (${c.worktreeSpec})` : ''}`);
  }
}

async function cmdPrStack({ rootDir, argv }) {
  // Supports passing args to the eventual `stack dev/start` via `-- ...`.
  const sep = argv.indexOf('--');
  const argv0 = sep >= 0 ? argv.slice(0, sep) : argv;
  const passthrough = sep >= 0 ? argv.slice(sep + 1) : [];

  const { flags, kv } = parseArgs(argv0);
  const json = wantsJson(argv0, { flags });

  if (wantsHelp(argv0, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'happys stack pr <name> --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--happy-server=<pr-url|number>|--happy-server-light=<pr-url|number>] [--server=happy-server|happy-server-light] [--remote=upstream] [--deps=none|link|install|link-or-install] [--seed-auth] [--copy-auth-from=<stack>] [--with-infra] [--auth-force] [--dev|--start] [--json] [-- <stack dev/start args...>]',
      },
      text: [
        '[stack] usage:',
        '  happys stack pr <name> --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--dev|--start]',
        '    [--seed-auth] [--copy-auth-from=<stack|legacy>] [--link-auth] [--with-infra] [--auth-force]',
        '    [--remote=upstream] [--deps=none|link|install|link-or-install] [--update] [--force]',
        '    [--json] [-- <stack dev/start args...>]',
        '',
        'examples:',
        '  # Create stack + check out PRs + start dev UI',
        '  happys stack pr pr123 \\',
        '    --happy=https://github.com/slopus/happy/pull/123 \\',
        '    --happy-cli=https://github.com/slopus/happy-cli/pull/456 \\',
        '    --seed-auth --copy-auth-from=dev-auth \\',
        '    --dev',
        '',
        '  # Use numeric PR refs (remote defaults to upstream)',
        '  happys stack pr pr123 --happy=123 --happy-cli=456 --seed-auth --copy-auth-from=dev-auth --dev',
        '',
        '  # Reuse an existing non-stacks Happy install for auth seeding',
        '  happys stack pr pr123 --happy=123 --seed-auth --copy-auth-from=legacy --link-auth --dev',
        '',
        'notes:',
        '  - This composes existing commands: `happys stack new`, `happys stack wt ...`, and `happys stack auth ...`',
        '  - For auth seeding, pass `--seed-auth` and optionally `--copy-auth-from=dev-auth` (or legacy/main)',
        '  - `--link-auth` symlinks auth files instead of copying (keeps credentials in sync, but reduces isolation)',
      ].join('\n'),
    });
    return;
  }

  const positionals = argv0.filter((a) => !a.startsWith('--'));
  const stackName = (positionals[1] ?? '').trim();
  if (!stackName) {
    throw new Error('[stack] pr: missing stack name. Usage: happys stack pr <name> --happy=<pr>');
  }
  if (stackName === 'main') {
    throw new Error('[stack] pr: stack name "main" is reserved; pick a unique name for this PR stack');
  }
  const reuseExisting = flags.has('--reuse') || flags.has('--update-existing') || (kv.get('--reuse') ?? '').trim() === '1';
  const stackExists = stackExistsSync(stackName);
  if (stackExists && !reuseExisting) {
    throw new Error(
      `[stack] pr: stack already exists: ${stackName}\n` +
        `[stack] tip: re-run with --reuse to update the existing PR worktrees and keep the stack wiring intact`
    );
  }

  const remoteName = (kv.get('--remote') ?? '').trim() || 'upstream';
  const depsMode = (kv.get('--deps') ?? '').trim();

  const prHappy = (kv.get('--happy') ?? '').trim();
  const prCli = (kv.get('--happy-cli') ?? '').trim();
  const prServerLight = (kv.get('--happy-server-light') ?? '').trim();
  const prServer = (kv.get('--happy-server') ?? '').trim();

  if (!prHappy && !prCli && !prServerLight && !prServer) {
    throw new Error(
      '[stack] pr: missing PR inputs. Provide at least one of: --happy, --happy-cli, --happy-server-light, --happy-server'
    );
  }
  if (prServerLight && prServer) {
    throw new Error('[stack] pr: cannot specify both --happy-server and --happy-server-light');
  }

  const serverFromArg = (kv.get('--server') ?? '').trim();
  const inferredServer = prServer ? 'happy-server' : prServerLight ? 'happy-server-light' : '';
  const serverComponent = (serverFromArg || inferredServer || 'happy-server-light').trim();
  if (serverComponent !== 'happy-server' && serverComponent !== 'happy-server-light') {
    throw new Error(`[stack] pr: invalid --server: ${serverFromArg || serverComponent}`);
  }

  const wantsDev = flags.has('--dev') || flags.has('--start-dev');
  const wantsStart = flags.has('--start') || flags.has('--prod');
  if (wantsDev && wantsStart) {
    throw new Error('[stack] pr: choose either --dev or --start (not both)');
  }

  const seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  const authFromFlag = (kv.get('--copy-auth-from') ?? '').trim();
  const withInfra = flags.has('--with-infra') || flags.has('--ensure-infra') || flags.has('--infra');
  const authForce = flags.has('--auth-force') || flags.has('--force-auth');
  const authLinkFlag = flags.has('--link-auth') || flags.has('--link') || flags.has('--symlink-auth') ? true : null;
  const authLinkEnv =
    (process.env.HAPPY_STACKS_AUTH_LINK ?? process.env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPY_STACKS_AUTH_MODE ?? process.env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim() === 'link';

  const isInteractive = Boolean(process.stdin.isTTY && process.stdout.isTTY) && !json;

  const mainAccessKeyPath = join(resolveStackEnvPath('main').baseDir, 'cli', 'access.key');
  const legacyAccessKeyPath = join(getLegacyHappyBaseDir(), 'cli', 'access.key');
  const devAuthAccessKeyPath = join(resolveStackEnvPath('dev-auth').baseDir, 'cli', 'access.key');

  const hasMainAccessKey = existsSync(mainAccessKeyPath);
  const allowGlobal = sandboxAllowsGlobalSideEffects();
  const hasLegacyAccessKey = (!isSandboxed() || allowGlobal) && existsSync(legacyAccessKeyPath);
  const hasDevAuthAccessKey = existsSync(devAuthAccessKeyPath) && existsSync(resolveStackEnvPath('dev-auth').envPath);

  const inferredSeedFromEnv = resolveAuthSeedFromEnv(process.env);
  const inferredSeedFromAvailability = hasDevAuthAccessKey ? 'dev-auth' : hasMainAccessKey ? 'main' : hasLegacyAccessKey ? 'legacy' : 'main';
  const defaultAuthFrom = authFromFlag || inferredSeedFromEnv || inferredSeedFromAvailability;

  // Default behavior for stack pr:
  // - if user explicitly flags --seed-auth/--no-seed-auth, obey
  // - otherwise in interactive mode: prompt when we have *some* plausible source, default yes
  // - in non-interactive mode: follow HAPPY_STACKS_AUTO_AUTH_SEED (if set), else default false
  const envAutoSeed =
    (process.env.HAPPY_STACKS_AUTO_AUTH_SEED ?? process.env.HAPPY_LOCAL_AUTO_AUTH_SEED ?? '').toString().trim();
  const autoSeedEnabled = envAutoSeed ? envAutoSeed !== '0' : false;

  let seedAuth = seedAuthFlag != null ? seedAuthFlag : autoSeedEnabled;
  let authFrom = defaultAuthFrom;
  let authLink = authLinkFlag != null ? authLinkFlag : authLinkEnv;

  if (seedAuthFlag == null && isInteractive) {
    const anySource = hasDevAuthAccessKey || hasMainAccessKey || hasLegacyAccessKey;
    if (anySource) {
      seedAuth = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: 'Seed authentication into this PR stack so it works without a re-login?',
          options: [
            { label: 'yes (recommended)', value: true },
            { label: 'no (I will login manually for this stack)', value: false },
          ],
          defaultIndex: 0,
        });
      });
    } else {
      seedAuth = false;
    }
  }

  if (seedAuth && !authFromFlag && isInteractive) {
    const options = [];
    if (hasDevAuthAccessKey) {
      options.push({ label: 'dev-auth (recommended) — use your dedicated dev auth seed stack', value: 'dev-auth' });
    }
    if (hasMainAccessKey) {
      options.push({ label: 'main — use Happy Stacks main credentials', value: 'main' });
    }
    if (hasLegacyAccessKey) {
      options.push({ label: 'legacy — use ~/.happy credentials (best-effort)', value: 'legacy' });
    }
    options.push({ label: 'skip seeding (manual login)', value: 'skip' });

    const defaultIdx = Math.max(
      0,
      options.findIndex((o) => o.value === (hasDevAuthAccessKey ? 'dev-auth' : hasMainAccessKey ? 'main' : hasLegacyAccessKey ? 'legacy' : 'skip'))
    );
    const picked = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'Which auth source should this PR stack use?',
        options,
        defaultIndex: defaultIdx,
      });
    });
    if (picked === 'skip') {
      seedAuth = false;
    } else {
      authFrom = String(picked);
    }
  }

  if (seedAuth && authLinkFlag == null && isInteractive) {
    authLink = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'When seeding, reuse credentials via symlink or copy?',
        options: [
          { label: 'symlink (recommended) — stays up to date', value: true },
          { label: 'copy — more isolated per stack', value: false },
        ],
        defaultIndex: authLink ? 0 : 1,
      });
    });
  }

  const progress = (line) => {
    // In JSON mode, never pollute stdout (reserved for final JSON).
    // eslint-disable-next-line no-console
    (json ? console.error : console.log)(line);
  };

  // 1) Create (or reuse) the stack.
  let created = null;
  if (!stackExists) {
    progress(`[stack] pr: creating stack "${stackName}" (server=${serverComponent})...`);
    created = await cmdNew({
      rootDir,
      argv: [stackName, '--no-copy-auth', `--server=${serverComponent}`, ...(json ? ['--json'] : [])],
      // Prevent cmdNew from printing in JSON mode (we’ll print the final combined object below).
      emit: !json,
    });
  } else {
    progress(`[stack] pr: reusing existing stack "${stackName}"...`);
    // Ensure requested server flavor is compatible with the existing stack.
    const existing = await cmdInfoInternal({ rootDir, stackName });
    if (existing.serverComponent !== serverComponent) {
      throw new Error(
        `[stack] pr: existing stack "${stackName}" uses server=${existing.serverComponent}, but command requested server=${serverComponent}.\n` +
          `Fix: create a new stack name, or switch the stack's server flavor first (happys stack srv ${stackName} -- use ...).`
      );
    }
    created = { ok: true, stackName, reused: true, serverComponent: existing.serverComponent };
  }

  // 2) Checkout PR worktrees and pin them to the stack env file.
  const prSpecs = [
    { component: 'happy', pr: prHappy },
    { component: 'happy-cli', pr: prCli },
    ...(serverComponent === 'happy-server' ? [{ component: 'happy-server', pr: prServer }] : []),
    ...(serverComponent === 'happy-server-light' ? [{ component: 'happy-server-light', pr: prServerLight }] : []),
  ].filter((x) => x.pr);

  const worktrees = [];
  for (const { component, pr } of prSpecs) {
    progress(`[stack] pr: ${stackName}: fetching PR for ${component} (${pr})...`);
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        const doUpdate = reuseExisting || flags.has('--update');
        const args = [
          'pr',
          component,
          pr,
          `--remote=${remoteName}`,
          '--use',
          ...(depsMode ? [`--deps=${depsMode}`] : []),
          ...(doUpdate ? ['--update'] : []),
          ...(flags.has('--force') ? ['--force'] : []),
          '--json',
        ];
        const stdout = await runCapture(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), ...args], { cwd: rootDir, env });
        return stdout.trim() ? JSON.parse(stdout.trim()) : null;
      },
    });
    if (json) {
      worktrees.push(out);
    } else if (out) {
      const short = (sha) => (sha ? String(sha).slice(0, 8) : '');
      const changed = Boolean(out.updated && out.oldHead && out.newHead && out.oldHead !== out.newHead);
      if (changed) {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: updated ${short(out.oldHead)} -> ${short(out.newHead)}`);
      } else if (out.updated) {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: already up to date (${short(out.newHead)})`);
      } else {
        // eslint-disable-next-line no-console
        console.log(`[stack] pr: ${stackName}: ${component}: checked out (${short(out.newHead)})`);
      }
    }
  }

  // 3) Optional: seed auth (copies cli creds + master secret + DB Account rows).
  let auth = null;
  if (seedAuth) {
    progress(`[stack] pr: ${stackName}: seeding auth from "${authFrom}"...`);
    const args = [
      'copy-from',
      authFrom,
      ...(authForce ? ['--force'] : []),
      ...(withInfra ? ['--with-infra'] : []),
      ...(authLink ? ['--link'] : []),
    ];
    if (json) {
      auth = await withStackEnv({
        stackName,
        fn: async ({ env }) => {
          const stdout = await runCapture(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), ...args, '--json'], { cwd: rootDir, env });
          return stdout.trim() ? JSON.parse(stdout.trim()) : null;
        },
      });
    } else {
      await cmdAuth({ rootDir, stackName, args });
      auth = { ok: true, from: authFrom };
    }
  }

  // 4) Optional: start dev / start.
  if (wantsDev) {
    progress(`[stack] pr: ${stackName}: starting dev...`);
    const args = passthrough.length ? ['--', ...passthrough] : [];
    await cmdRunScript({ rootDir, stackName, scriptPath: 'dev.mjs', args });
  } else if (wantsStart) {
    progress(`[stack] pr: ${stackName}: starting...`);
    const args = passthrough.length ? ['--', ...passthrough] : [];
    await cmdRunScript({ rootDir, stackName, scriptPath: 'run.mjs', args });
  }

  const info = await cmdInfoInternal({ rootDir, stackName });

  const out = {
    ok: true,
    stackName,
    created,
    worktrees: worktrees.length ? worktrees : null,
    auth,
    info,
  };

  if (json) {
    printResult({ json, data: out });
    return;
  }
  // Non-JSON mode already streamed output.
}

async function cmdInfoInternal({ rootDir, stackName }) {
  // Minimal extraction from cmdInfo to avoid re-parsing argv/printing. Used by cmdPrStack.
  const baseDir = getStackDir(stackName);
  const envPath = getStackEnvPath(stackName);
  const envRaw = await readExistingEnv(envPath);
  const stackEnv = envRaw ? parseEnvToObject(envRaw) : {};
  const runtimeStatePath = getStackRuntimeStatePath(stackName);
  const runtimeState = await readStackRuntimeStateFile(runtimeStatePath);

  const serverComponent =
    getEnvValueAny(stackEnv, ['HAPPY_STACKS_SERVER_COMPONENT', 'HAPPY_LOCAL_SERVER_COMPONENT']) || 'happy-server-light';

  const pinnedServerPortRaw = getEnvValueAny(stackEnv, ['HAPPY_STACKS_SERVER_PORT', 'HAPPY_LOCAL_SERVER_PORT']);
  const pinnedServerPort = pinnedServerPortRaw ? Number(pinnedServerPortRaw) : null;

  const ownerPid = Number(runtimeState?.ownerPid);
  const running = isPidAlive(ownerPid);
  const runtimePorts = runtimeState?.ports && typeof runtimeState.ports === 'object' ? runtimeState.ports : {};
  const serverPort =
    Number.isFinite(pinnedServerPort) && pinnedServerPort > 0
      ? pinnedServerPort
      : Number(runtimePorts?.server) > 0
        ? Number(runtimePorts.server)
        : null;
  const backendPort = Number(runtimePorts?.backend) > 0 ? Number(runtimePorts.backend) : null;
  const uiPort =
    runtimeState?.expo && typeof runtimeState.expo === 'object' && Number(runtimeState.expo.webPort) > 0
      ? Number(runtimeState.expo.webPort)
      : null;

  const host = resolveLocalhostHost({ stackMode: true, stackName });
  const internalServerUrl = serverPort ? `http://127.0.0.1:${serverPort}` : null;
  const uiUrl = uiPort ? `http://${host}:${uiPort}` : null;

  const componentSpecs = [
    { component: 'happy', keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY'] },
    { component: 'happy-cli', keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI'] },
    {
      component: 'happy-server-light',
      keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT'],
    },
    { component: 'happy-server', keys: ['HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER', 'HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER'] },
  ];

  const components = componentSpecs.map((c) => {
    const dir = getEnvValueAny(stackEnv, c.keys) || getComponentDir(rootDir, c.component);
    const spec = worktreeSpecFromDir({ rootDir, component: c.component, dir }) || null;
    return { component: c.component, dir, worktreeSpec: spec };
  });

  return {
    ok: true,
    stackName,
    baseDir,
    envPath,
    runtimeStatePath,
    serverComponent,
    pinned: {
      serverPort: Number.isFinite(pinnedServerPort) && pinnedServerPort > 0 ? pinnedServerPort : null,
    },
    runtime: {
      script: typeof runtimeState?.script === 'string' ? runtimeState.script : null,
      ownerPid: Number.isFinite(ownerPid) && ownerPid > 1 ? ownerPid : null,
      running,
      ports: runtimePorts,
      expo: runtimeState?.expo ?? null,
      processes: runtimeState?.processes ?? null,
      startedAt: runtimeState?.startedAt ?? null,
      updatedAt: runtimeState?.updatedAt ?? null,
    },
    urls: {
      host,
      internalServerUrl,
      uiUrl,
    },
    ports: {
      server: serverPort,
      backend: backendPort,
      ui: uiPort,
    },
    components,
  };
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

  const wantsHelpFlag = wantsHelp(argv, { flags });
  // Allow subcommand-specific help (so `happys stack pr --help` shows PR stack flags).
  if (wantsHelpFlag && cmd === 'pr') {
    await cmdPrStack({ rootDir, argv });
    return;
  }
  if (wantsHelpFlag || cmd === 'help') {
    printResult({
      json,
      data: {
        commands: [
          'new',
          'edit',
          'list',
          'migrate',
          'audit',
        'duplicate',
          'info',
          'pr',
          'create-dev-auth-seed',
          'auth',
          'dev',
          'start',
          'build',
          'typecheck',
          'lint',
          'test',
          'doctor',
          'mobile',
          'resume',
          'stop',
          'srv',
          'wt',
          'tailscale:*',
          'service:*',
        ],
      },
      text: [
        '[stack] usage:',
        '  happys stack new <name> [--port=NNN] [--server=happy-server|happy-server-light] [--happy=default|<owner/...>|<path>] [--happy-cli=...] [--interactive] [--copy-auth-from=<stack>] [--no-copy-auth] [--force-port] [--json]',
        '  happys stack edit <name> --interactive [--json]',
        '  happys stack list [--json]',
        '  happys stack migrate [--json]   # copy legacy env files from ~/.happy/local/stacks/* -> ~/.happy/stacks/*',
        '  happys stack audit [--fix] [--fix-main] [--fix-ports] [--fix-workspace] [--fix-paths] [--unpin-ports] [--unpin-ports-except=stack1,stack2] [--json]',
        '  happys stack duplicate <from> <to> [--duplicate-worktrees] [--deps=none|link|install|link-or-install] [--json]',
        '  happys stack info <name> [--json]',
        '  happys stack pr <name> --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--dev|--start] [--json] [-- ...]',
        '  happys stack create-dev-auth-seed [name] [--server=happy-server|happy-server-light] [--non-interactive] [--json]',
        '  happys stack auth <name> status|login|copy-from [--json]',
        '  happys stack dev <name> [-- ...]',
        '  happys stack start <name> [-- ...]',
        '  happys stack build <name> [-- ...]',
        '  happys stack typecheck <name> [component...] [--json]',
        '  happys stack lint <name> [component...] [--json]',
        '  happys stack test <name> [component...] [--json]',
        '  happys stack doctor <name> [-- ...]',
        '  happys stack mobile <name> [-- ...]',
        '  happys stack resume <name> <sessionId...> [--json]',
        '  happys stack stop <name> [--aggressive] [--sweep-owned] [--no-docker] [--json]',
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
  if (cmd === 'duplicate') {
    await cmdDuplicate({ rootDir, argv });
    return;
  }
  if (cmd === 'info') {
    await cmdInfo({ rootDir, argv });
    return;
  }
  if (cmd === 'pr') {
    await cmdPrStack({ rootDir, argv });
    return;
  }
  if (cmd === 'create-dev-auth-seed') {
    await cmdCreateDevAuthSeed({ rootDir, argv });
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
  if (cmd === 'lint') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'lint.mjs', args: passthrough, extraEnv: overrides });
    return;
  }
  if (cmd === 'test') {
    const { kv } = parseArgs(passthrough);
    const overrides = resolveTransientComponentOverrides({ rootDir, kv });
    await cmdRunScript({ rootDir, stackName, scriptPath: 'test.mjs', args: passthrough, extraEnv: overrides });
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
  if (cmd === 'resume') {
    const sessionIds = passthrough.filter((a) => a && a !== '--' && !a.startsWith('--'));
    if (sessionIds.length === 0) {
      printResult({
        json,
        data: { ok: false, error: 'missing_session_ids' },
        text: [
          '[stack] usage:',
          '  happys stack resume <name> <sessionId...>',
        ].join('\n'),
      });
      process.exit(1);
    }
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        const cliDir = getComponentDir(rootDir, 'happy-cli');
        const happyBin = join(cliDir, 'bin', 'happy.mjs');
        // Run stack-scoped happy-cli and ask the stack daemon to resume these sessions.
        return await run(process.execPath, [happyBin, 'daemon', 'resume', ...sessionIds], { cwd: rootDir, env });
      },
    });
    if (json) printResult({ json, data: { ok: true, resumed: sessionIds, out } });
    return;
  }

  if (cmd === 'stop') {
    const { flags: stopFlags } = parseArgs(passthrough);
    const noDocker = stopFlags.has('--no-docker');
    const aggressive = stopFlags.has('--aggressive');
    const sweepOwned = stopFlags.has('--sweep-owned');
    const baseDir = getStackDir(stackName);
    const out = await withStackEnv({
      stackName,
      fn: async ({ env }) => {
        return await stopStackWithEnv({ rootDir, stackName, baseDir, env, json, noDocker, aggressive, sweepOwned });
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
