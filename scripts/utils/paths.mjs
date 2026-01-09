import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';

const PRIMARY_APP_SLUG = 'happy-stacks';
const LEGACY_APP_SLUG = 'happy-local';
const PRIMARY_LABEL_BASE = 'com.happy.stacks';
const LEGACY_LABEL_BASE = 'com.happy.local';
const PRIMARY_STORAGE_ROOT = join(homedir(), '.happy', 'stacks');
const LEGACY_STORAGE_ROOT = join(homedir(), '.happy', 'local');

export function getRootDir(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function getComponentsDir(rootDir) {
  return join(rootDir, 'components');
}

export function componentDirEnvKey(name) {
  return `HAPPY_LOCAL_COMPONENT_DIR_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`;
}

function normalizePathForEnv(rootDir, raw) {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) {
    return '';
  }
  const expanded = trimmed.replace(/^~(?=\/)/, homedir());
  // If the path is relative, treat it as relative to the happy-stacks root.
  return expanded.startsWith('/') ? expanded : resolve(rootDir, expanded);
}

export function getComponentDir(rootDir, name) {
  const key = componentDirEnvKey(name);
  const fromEnv = normalizePathForEnv(rootDir, process.env[key]);
  if (fromEnv) {
    return fromEnv;
  }
  return join(getComponentsDir(rootDir), name);
}

export function getStackName() {
  const raw = process.env.HAPPY_STACKS_STACK?.trim()
    ? process.env.HAPPY_STACKS_STACK.trim()
    : process.env.HAPPY_LOCAL_STACK?.trim()
      ? process.env.HAPPY_LOCAL_STACK.trim()
      : '';
  return raw || 'main';
}

export function getStackLabel(stackName = getStackName()) {
  return stackName === 'main' ? PRIMARY_LABEL_BASE : `${PRIMARY_LABEL_BASE}.${stackName}`;
}

export function getLegacyStackLabel(stackName = getStackName()) {
  return stackName === 'main' ? LEGACY_LABEL_BASE : `${LEGACY_LABEL_BASE}.${stackName}`;
}

export function getStacksStorageRoot() {
  const fromEnv = (process.env.HAPPY_STACKS_STORAGE_DIR ?? process.env.HAPPY_LOCAL_STORAGE_DIR ?? '').trim();
  if (fromEnv) {
    return fromEnv.replace(/^~(?=\/)/, homedir());
  }
  return PRIMARY_STORAGE_ROOT;
}

export function getLegacyStorageRoot() {
  return LEGACY_STORAGE_ROOT;
}

export function resolveStackBaseDir(stackName = getStackName()) {
  const preferredRoot = getStacksStorageRoot();
  const newBase = join(preferredRoot, stackName);
  const legacyBase = stackName === 'main' ? LEGACY_STORAGE_ROOT : join(LEGACY_STORAGE_ROOT, 'stacks', stackName);

  // Prefer the new layout by default.
  //
  // For non-main stacks, keep legacy layout if the legacy env exists and the new env does not.
  // This avoids breaking existing stacks until `pnpm stack migrate` is run.
  if (stackName !== 'main') {
    const newEnv = join(preferredRoot, stackName, 'env');
    const legacyEnv = join(LEGACY_STORAGE_ROOT, 'stacks', stackName, 'env');
    if (!existsSync(newEnv) && existsSync(legacyEnv)) {
      return { baseDir: legacyBase, isLegacy: true };
    }
  }

  return { baseDir: newBase, isLegacy: false };
}

export function resolveStackEnvPath(stackName = getStackName()) {
  const { baseDir: activeBase, isLegacy } = resolveStackBaseDir(stackName);
  // New layout: ~/.happy/stacks/<name>/env
  const newEnv = join(getStacksStorageRoot(), stackName, 'env');
  // Legacy layout: ~/.happy/local/stacks/<name>/env
  const legacyEnv = join(LEGACY_STORAGE_ROOT, 'stacks', stackName, 'env');

  if (existsSync(newEnv)) {
    return { envPath: newEnv, isLegacy: false, baseDir: join(getStacksStorageRoot(), stackName) };
  }
  if (existsSync(legacyEnv)) {
    return { envPath: legacyEnv, isLegacy: true, baseDir: join(LEGACY_STORAGE_ROOT, 'stacks', stackName) };
  }
  return { envPath: newEnv, isLegacy, baseDir: activeBase };
}

export function getDefaultAutostartPaths() {
  const stackName = getStackName();
  const { baseDir, isLegacy } = resolveStackBaseDir(stackName);
  const logsDir = join(baseDir, 'logs');

  const primaryLabel = getStackLabel(stackName);
  const legacyLabel = getLegacyStackLabel(stackName);
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

