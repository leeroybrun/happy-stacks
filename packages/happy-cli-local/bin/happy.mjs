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
  // packages/happy-cli-local/bin/happy.mjs -> happy-local/
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

function main() {
  const rootDir = getRootDir();

  // Load happy-local env (optional) so `happy` works from any directory.
  loadEnvFile(process.env.HAPPY_LOCAL_ENV_FILE?.trim() ? process.env.HAPPY_LOCAL_ENV_FILE.trim() : join(rootDir, '.env'));
  loadEnvFile(join(rootDir, 'env.local'));

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
        : join(homedir(), '.happy', 'local', 'cli'));

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
  execFileSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
}

try {
  main();
} catch (e) {
  process.exit(e?.status || 1);
}

