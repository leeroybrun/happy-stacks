#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function expandHome(p) {
  if (!p) return p;
  return p.replace(/^~(?=\/)/, homedir());
}

function getRootDir() {
  // packages/happy-cli-local/bin/happy.mjs -> happy-stacks/
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

function parseDotenv(contents) {
  const out = new Map();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const idx = line.indexOf('=');
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) continue;
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (value.startsWith('~/')) {
      value = join(homedir(), value.slice(2));
    }
    out.set(key, value);
  }
  return out;
}

function loadEnvFile(path) {
  try {
    if (!existsSync(path)) return;
    const parsed = parseDotenv(readFileSync(path, 'utf-8'));
    for (const [k, v] of parsed.entries()) {
      if (process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore
  }
}

function loadEnvFileOverride(path, { prefix = null } = {}) {
  try {
    if (!existsSync(path)) return;
    const parsed = parseDotenv(readFileSync(path, 'utf-8'));
    for (const [k, v] of parsed.entries()) {
      if (!prefix || k.startsWith(prefix)) {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore
  }
}

function applyStacksPrefixMapping() {
  const keys = new Set(Object.keys(process.env));
  const suffixes = new Set();
  for (const k of keys) {
    if (k.startsWith('HAPPY_STACKS_')) suffixes.add(k.slice('HAPPY_STACKS_'.length));
    if (k.startsWith('HAPPY_LOCAL_')) suffixes.add(k.slice('HAPPY_LOCAL_'.length));
  }
  for (const suffix of suffixes) {
    const stacksKey = `HAPPY_STACKS_${suffix}`;
    const localKey = `HAPPY_LOCAL_${suffix}`;
    const stacksVal = (process.env[stacksKey] ?? '').trim();
    const localVal = (process.env[localKey] ?? '').trim();
    if (stacksVal) {
      process.env[stacksKey] = stacksVal;
      process.env[localKey] = stacksVal;
    } else if (localVal) {
      process.env[localKey] = localVal;
      process.env[stacksKey] = localVal;
    }
  }
}

function main() {
  const rootDir = getRootDir();

  // Stack selection:
  // - `HAPPY_STACKS_STACK=<name>` / legacy `HAPPY_LOCAL_STACK=<name>` env var, OR
  // - `--stack <name>` / `--stack=<name>` CLI arg to this wrapper (not forwarded to happy-cli).
  const argv = [...process.argv];
  let stackName = process.env.HAPPY_STACKS_STACK?.trim()
    ? process.env.HAPPY_STACKS_STACK.trim()
    : process.env.HAPPY_LOCAL_STACK?.trim()
      ? process.env.HAPPY_LOCAL_STACK.trim()
      : '';
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stack' && argv[i + 1]) {
      stackName = argv[i + 1];
      argv.splice(i, 2);
      i -= 1;
      continue;
    }
    if (a.startsWith('--stack=')) {
      stackName = a.slice('--stack='.length);
      argv.splice(i, 1);
      i -= 1;
      continue;
    }
  }

  const stacksEnvFileFromName = (() => {
    if (!stackName || stackName === 'main') return '';
    const primary = join(homedir(), '.happy', 'stacks', stackName, 'env');
    const legacy = join(homedir(), '.happy', 'local', 'stacks', stackName, 'env');
    if (existsSync(primary) || !existsSync(legacy)) return primary;
    return legacy;
  })();

  // Load happy-stacks env so `happy` works from any directory.
  // Precedence matches happy-stacks scripts: .env -> env.local -> stack env (override).
  loadEnvFile(join(rootDir, '.env'));
  loadEnvFileOverride(join(rootDir, 'env.local'), { prefix: 'HAPPY_LOCAL_' });
  loadEnvFileOverride(join(rootDir, 'env.local'), { prefix: 'HAPPY_STACKS_' });

  const explicitEnvFile = process.env.HAPPY_STACKS_ENV_FILE?.trim()
    ? process.env.HAPPY_STACKS_ENV_FILE.trim()
    : process.env.HAPPY_LOCAL_ENV_FILE?.trim()
      ? process.env.HAPPY_LOCAL_ENV_FILE.trim()
      : '';

  const stackEnvFile = stacksEnvFileFromName || explicitEnvFile;
  if (stackEnvFile) {
    if (stackName) {
      process.env.HAPPY_STACKS_STACK = stackName;
      process.env.HAPPY_LOCAL_STACK = stackName;
    }
    process.env.HAPPY_STACKS_ENV_FILE = stackEnvFile;
    process.env.HAPPY_LOCAL_ENV_FILE = stackEnvFile;
    loadEnvFileOverride(stackEnvFile, { prefix: 'HAPPY_STACKS_' });
    loadEnvFileOverride(stackEnvFile, { prefix: 'HAPPY_LOCAL_' });
  }

  applyStacksPrefixMapping();

  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT
    ? parseInt(process.env.HAPPY_LOCAL_SERVER_PORT, 10)
    : 3005;

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const publicServerUrl = process.env.HAPPY_LOCAL_SERVER_URL?.trim()
    ? process.env.HAPPY_LOCAL_SERVER_URL.trim()
    : `http://localhost:${serverPort}`;

  const cliHomeDir = process.env.HAPPY_HOME_DIR?.trim()
    ? expandHome(process.env.HAPPY_HOME_DIR.trim())
    : (process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
        ? expandHome(process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim())
        : (existsSync(join(homedir(), '.happy', 'stacks', 'main', 'cli')) || !existsSync(join(homedir(), '.happy', 'local', 'cli'))
            ? join(homedir(), '.happy', 'stacks', 'main', 'cli')
            : join(homedir(), '.happy', 'local', 'cli')));

  const entrypoint = join(rootDir, 'components', 'happy-cli', 'dist', 'index.mjs');
  if (!existsSync(entrypoint)) {
    console.error(`[happy-cli-local] missing happy-cli build at: ${entrypoint}`);
    console.error(`[happy-cli-local] run: pnpm bootstrap (from ${rootDir})`);
    process.exit(1);
  }

  const env = { ...process.env };
  env.HAPPY_HOME_DIR = env.HAPPY_HOME_DIR || cliHomeDir;
  env.HAPPY_SERVER_URL = env.HAPPY_SERVER_URL || internalServerUrl;
  env.HAPPY_WEBAPP_URL = env.HAPPY_WEBAPP_URL || publicServerUrl;

  // Run happy-cli with the same Node flags happy-cli expects.
  execFileSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, ...argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
}

try {
  main();
} catch (e) {
  process.exit(e?.status || 1);
}

