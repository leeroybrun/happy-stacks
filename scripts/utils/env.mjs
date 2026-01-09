import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDotenv } from './dotenv.mjs';

async function loadEnvFile(path, { override = false, overridePrefix = null } = {}) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      const allowOverride = override && (!overridePrefix || k.startsWith(overridePrefix));
      if (allowOverride || process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}

// Load happy-stacks env (optional). This is intentionally lightweight and does not require extra deps.
// This file lives under scripts/utils/, so repo root is two directories up.
const __utilsDir = dirname(fileURLToPath(import.meta.url));
const __scriptsDir = dirname(__utilsDir);
const __rootDir = dirname(__scriptsDir);

function applyStacksPrefixMapping() {
  // Canonicalize env var prefix:
  // - prefer HAPPY_STACKS_* when set
  // - continue supporting HAPPY_LOCAL_* (legacy) during migration
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
      // Stacks wins.
      process.env[stacksKey] = stacksVal;
      process.env[localKey] = stacksVal;
    } else if (localVal) {
      // Legacy -> stacks.
      process.env[localKey] = localVal;
      process.env[stacksKey] = localVal;
    }
  }
}

// 1) Load repo defaults (.env) first (lowest precedence)
await loadEnvFile(join(__rootDir, '.env'), { override: false });
// 2) Load repo-local overrides (env.local) (still below stack env)
await loadEnvFile(join(__rootDir, 'env.local'), { override: true, overridePrefix: 'HAPPY_LOCAL_' });
await loadEnvFile(join(__rootDir, 'env.local'), { override: true, overridePrefix: 'HAPPY_STACKS_' });
// 3) Load explicit env file overlay (stack env, or any caller-provided env file) last (highest precedence)
if (process.env.HAPPY_STACKS_ENV_FILE?.trim()) {
  await loadEnvFile(process.env.HAPPY_STACKS_ENV_FILE.trim(), { override: true, overridePrefix: 'HAPPY_STACKS_' });
}
if (process.env.HAPPY_LOCAL_ENV_FILE?.trim()) {
  await loadEnvFile(process.env.HAPPY_LOCAL_ENV_FILE.trim(), { override: true, overridePrefix: 'HAPPY_LOCAL_' });
}

// Make both prefixes available to the rest of the codebase.
applyStacksPrefixMapping();

// Corepack strictness can prevent running Yarn in subfolders when the repo root is pinned to pnpm.
// We intentionally keep component repos upstream-compatible (often Yarn), so relax strictness for child processes.
process.env.COREPACK_ENABLE_STRICT = process.env.COREPACK_ENABLE_STRICT ?? '0';
process.env.NPM_CONFIG_PACKAGE_MANAGER_STRICT = process.env.NPM_CONFIG_PACKAGE_MANAGER_STRICT ?? 'false';

// LaunchAgents often run with a very minimal PATH which won't include NVM's bin dir, so child
// processes like `yarn` / `pnpm` can look "missing" even though Node is running from NVM.
// Ensure the directory containing this Node binary is on PATH.
(() => {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const current = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const nodeBinDir = dirname(process.execPath);
  const want = [nodeBinDir, '/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin'];
  const next = [...want.filter((p) => p && !current.includes(p)), ...current];
  process.env.PATH = next.join(delimiter);
})();

