import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

import { expandHome } from './canonical_home.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from '../env/sandbox.mjs';

const PRIMARY_APP_SLUG = 'happy-stacks';
const LEGACY_APP_SLUG = 'happy-local';
const PRIMARY_LABEL_BASE = 'com.happy.stacks';
const LEGACY_LABEL_BASE = 'com.happy.local';
const PRIMARY_STORAGE_ROOT = join(homedir(), '.happy', 'stacks');
const LEGACY_STORAGE_ROOT = join(homedir(), '.happy', 'local');
const PRIMARY_HOME_DIR = join(homedir(), '.happy-stacks');

export function getRootDir(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function getHappyStacksHomeDir(env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_HOME_DIR ?? env.HAPPY_LOCAL_HOME_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return PRIMARY_HOME_DIR;
}

export function getWorkspaceDir(cliRootDir = null, env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_WORKSPACE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  const homeDir = getHappyStacksHomeDir();
  const defaultWorkspace = join(homeDir, 'workspace');
  // Prefer the default home workspace if present.
  if (existsSync(defaultWorkspace)) {
    return defaultWorkspace;
  }
  // Back-compat: for cloned-repo usage before init, keep components inside the repo.
  return cliRootDir ? cliRootDir : defaultWorkspace;
}

export function getComponentsDir(rootDir, env = process.env) {
  const workspaceDir = getWorkspaceDir(rootDir, env);
  return join(workspaceDir, 'components');
}

export function componentDirEnvKey(name) {
  return `HAPPY_STACKS_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function normalizePathForEnv(rootDir, raw, env = process.env) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return '';
  }
  const expanded = expandHome(trimmed);
  // If the path is relative, treat it as relative to the workspace root (default: repo root).
  const workspaceDir = getWorkspaceDir(rootDir, env);
  return expanded.startsWith('/') ? expanded : resolve(workspaceDir, expanded);
}

export function getComponentDir(rootDir, name, env = process.env) {
  const stacksKey = componentDirEnvKey(name);
  const legacyKey = stacksKey.replace(/^HAPPY_STACKS_/, 'HAPPY_LOCAL_');
  const fromEnv = normalizePathForEnv(rootDir, env[stacksKey] ?? env[legacyKey], env);
  if (fromEnv) {
    return fromEnv;
  }
  return join(getComponentsDir(rootDir, env), name);
}

export function getStackName(env = process.env) {
  const raw = env.HAPPY_STACKS_STACK?.trim()
    ? env.HAPPY_STACKS_STACK.trim()
    : env.HAPPY_LOCAL_STACK?.trim()
      ? env.HAPPY_LOCAL_STACK.trim()
      : '';
  return raw || 'main';
}

export function getStackLabel(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  return name === 'main' ? PRIMARY_LABEL_BASE : `${PRIMARY_LABEL_BASE}.${name}`;
}

export function getLegacyStackLabel(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  return name === 'main' ? LEGACY_LABEL_BASE : `${LEGACY_LABEL_BASE}.${name}`;
}

export function getStacksStorageRoot(env = process.env) {
  const fromEnv = (env.HAPPY_STACKS_STORAGE_DIR ?? env.HAPPY_LOCAL_STORAGE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  return PRIMARY_STORAGE_ROOT;
}

export function getLegacyStorageRoot() {
  return LEGACY_STORAGE_ROOT;
}

export function resolveStackBaseDir(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  const preferredRoot = getStacksStorageRoot(env);
  const newBase = join(preferredRoot, name);
  const legacyBase = name === 'main' ? LEGACY_STORAGE_ROOT : join(LEGACY_STORAGE_ROOT, 'stacks', name);
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();

  // Prefer the new layout by default.
  //
  // For non-main stacks, keep legacy layout if the legacy env exists and the new env does not.
  // This avoids breaking existing stacks until `happys stack migrate` is run.
  if (allowLegacy && name !== 'main') {
    const newEnv = join(preferredRoot, name, 'env');
    const legacyEnv = join(LEGACY_STORAGE_ROOT, 'stacks', name, 'env');
    if (!existsSync(newEnv) && existsSync(legacyEnv)) {
      return { baseDir: legacyBase, isLegacy: true };
    }
  }

  return { baseDir: newBase, isLegacy: false };
}

export function resolveStackEnvPath(stackName = null, env = process.env) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  const { baseDir: activeBase, isLegacy } = resolveStackBaseDir(name, env);
  // New layout: ~/.happy/stacks/<name>/env
  const newEnv = join(getStacksStorageRoot(env), name, 'env');
  // Legacy layout: ~/.happy/local/stacks/<name>/env
  const legacyEnv = join(LEGACY_STORAGE_ROOT, 'stacks', name, 'env');
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();

  if (existsSync(newEnv)) {
    return { envPath: newEnv, isLegacy: false, baseDir: join(getStacksStorageRoot(env), name) };
  }
  if (allowLegacy && existsSync(legacyEnv)) {
    return { envPath: legacyEnv, isLegacy: true, baseDir: join(LEGACY_STORAGE_ROOT, 'stacks', name) };
  }
  return { envPath: newEnv, isLegacy, baseDir: activeBase };
}

export function getDefaultAutostartPaths(env = process.env) {
  const stackName = getStackName(env);
  const { baseDir, isLegacy } = resolveStackBaseDir(stackName, env);
  const logsDir = join(baseDir, 'logs');

  const primaryLabel = getStackLabel(stackName, env);
  const legacyLabel = getLegacyStackLabel(stackName, env);
  const primaryPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${primaryLabel}.plist`);
  const legacyPlistPath = join(homedir(), 'Library', 'LaunchAgents', `${legacyLabel}.plist`);

  const primaryStdoutPath = join(logsDir, `${PRIMARY_APP_SLUG}.out.log`);
  const primaryStderrPath = join(logsDir, `${PRIMARY_APP_SLUG}.err.log`);
  const legacyStdoutPath = join(logsDir, `${LEGACY_APP_SLUG}.out.log`);
  const legacyStderrPath = join(logsDir, `${LEGACY_APP_SLUG}.err.log`);

  // Best-effort: prefer primary, but fall back to legacy if that's what's installed.
  const hasPrimaryPlist = existsSync(primaryPlistPath);
  const hasLegacyPlist = existsSync(legacyPlistPath);
  const hasPrimaryLogs = existsSync(primaryStdoutPath) || existsSync(primaryStderrPath);
  const hasLegacyLogs = existsSync(legacyStdoutPath) || existsSync(legacyStderrPath);

  const activeLabel = hasPrimaryPlist ? primaryLabel : hasLegacyPlist ? legacyLabel : primaryLabel;
  const activePlistPath = hasPrimaryPlist ? primaryPlistPath : hasLegacyPlist ? legacyPlistPath : primaryPlistPath;
  const stdoutPath = hasPrimaryLogs ? primaryStdoutPath : hasLegacyLogs ? legacyStdoutPath : primaryStdoutPath;
  const stderrPath = hasPrimaryLogs ? primaryStderrPath : hasLegacyLogs ? legacyStderrPath : primaryStderrPath;

  return {
    baseDir,
    logsDir,
    stackName,
    isLegacy,

    // Active (best-effort) for commands like status/logs/start/stop.
    label: activeLabel,
    plistPath: activePlistPath,
    stdoutPath,
    stderrPath,

    // Primary/legacy info (for display + migration).
    primaryLabel,
    legacyLabel,
    primaryPlistPath,
    legacyPlistPath,
    primaryStdoutPath,
    primaryStderrPath,
    legacyStdoutPath,
    legacyStderrPath,
  };
}

