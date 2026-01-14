#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandHelpArgs, renderHappysRootHelp, resolveHappysCommand } from '../scripts/utils/cli/cli_registry.mjs';
import { expandHome, getCanonicalHomeEnvPathFromEnv } from '../scripts/utils/canonical_home.mjs';

function getCliRootDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

// expandHome is imported from scripts/utils/canonical_home.mjs

function dotenvGetQuick(envPath, key) {
  try {
    if (!envPath || !existsSync(envPath)) return '';
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      if (!trimmed.startsWith(`${key}=`)) continue;
      let v = trimmed.slice(`${key}=`.length).trim();
      if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
      if (v.startsWith("'") && v.endsWith("'")) v = v.slice(1, -1);
      return v;
    }
  } catch {
    // ignore
  }
  return '';
}

function resolveCliRootDir() {
  const fromEnv = (
    process.env.HAPPY_STACKS_CLI_ROOT_DIR ??
    process.env.HAPPY_LOCAL_CLI_ROOT_DIR ??
    process.env.HAPPY_STACKS_DEV_CLI_ROOT_DIR ??
    process.env.HAPPY_LOCAL_DEV_CLI_ROOT_DIR ??
    ''
  ).trim();
  if (fromEnv) return expandHome(fromEnv);

  // Stable pointer file: even if the real home dir is elsewhere, `happys init` writes the pointer here.
  const canonicalEnv = getCanonicalHomeEnvPathFromEnv(process.env);
  const v =
    dotenvGetQuick(canonicalEnv, 'HAPPY_STACKS_CLI_ROOT_DIR') ||
    dotenvGetQuick(canonicalEnv, 'HAPPY_LOCAL_CLI_ROOT_DIR') ||
    dotenvGetQuick(canonicalEnv, 'HAPPY_STACKS_DEV_CLI_ROOT_DIR') ||
    dotenvGetQuick(canonicalEnv, 'HAPPY_LOCAL_DEV_CLI_ROOT_DIR') ||
    '';
  return v ? expandHome(v) : '';
}

function maybeReexecToCliRoot(cliRootDir) {
  if ((process.env.HAPPY_STACKS_CLI_REEXEC ?? process.env.HAPPY_STACKS_DEV_REEXEC ?? '') === '1') return;
  if ((process.env.HAPPY_STACKS_CLI_ROOT_DISABLE ?? process.env.HAPPY_STACKS_DEV_CLI_DISABLE ?? '') === '1') return;

  const cliRoot = resolveCliRootDir();
  if (!cliRoot) return;
  if (cliRoot === cliRootDir) return;

  const cliBin = join(cliRoot, 'bin', 'happys.mjs');
  if (!existsSync(cliBin)) return;

  const argv = process.argv.slice(2);
  const res = spawnSync(process.execPath, [cliBin, ...argv], {
    stdio: 'inherit',
    cwd: cliRoot,
    env: {
      ...process.env,
      HAPPY_STACKS_CLI_REEXEC: '1',
      HAPPY_STACKS_CLI_ROOT_DIR: cliRoot,
    },
  });
  process.exit(res.status ?? 1);
}

function resolveHomeDir() {
  const fromEnv = (process.env.HAPPY_STACKS_HOME_DIR ?? process.env.HAPPY_LOCAL_HOME_DIR ?? '').trim();
  if (fromEnv) return expandHome(fromEnv);

  // Stable pointer file: even if the real home dir is elsewhere, `happys init` writes the pointer here.
  const canonicalEnv = getCanonicalHomeEnvPathFromEnv(process.env);
  const v = dotenvGetQuick(canonicalEnv, 'HAPPY_STACKS_HOME_DIR') || dotenvGetQuick(canonicalEnv, 'HAPPY_LOCAL_HOME_DIR') || '';
  return v ? expandHome(v) : join(homedir(), '.happy-stacks');
}

function stripGlobalOpt(argv, { name, aliases = [] }) {
  const names = [name, ...aliases];
  for (const n of names) {
    const eq = `${n}=`;
    const iEq = argv.findIndex((a) => a.startsWith(eq));
    if (iEq >= 0) {
      const value = argv[iEq].slice(eq.length);
      const next = [...argv.slice(0, iEq), ...argv.slice(iEq + 1)];
      return { value, argv: next };
    }
    const i = argv.indexOf(n);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      const value = argv[i + 1];
      const next = [...argv.slice(0, i), ...argv.slice(i + 2)];
      return { value, argv: next };
    }
  }
  return { value: '', argv };
}

function applySandboxDirIfRequested(argv) {
  const explicit = (process.env.HAPPY_STACKS_SANDBOX_DIR ?? '').trim();
  const { value, argv: nextArgv } = stripGlobalOpt(argv, { name: '--sandbox-dir', aliases: ['--sandbox'] });
  const raw = value || explicit;
  if (!raw) return { argv: nextArgv, enabled: false };

  const sandboxDir = expandHome(raw);
  // Keep all state under one folder that can be deleted to reset completely.
  const canonicalHomeDir = join(sandboxDir, 'canonical');
  const homeDir = join(sandboxDir, 'home');
  const workspaceDir = join(sandboxDir, 'workspace');
  const runtimeDir = join(sandboxDir, 'runtime');
  const storageDir = join(sandboxDir, 'storage');

  process.env.HAPPY_STACKS_SANDBOX_DIR = sandboxDir;
  process.env.HAPPY_STACKS_CLI_ROOT_DISABLE = '1'; // never re-exec into a user's "real" install when sandboxing

  process.env.HAPPY_STACKS_CANONICAL_HOME_DIR = process.env.HAPPY_STACKS_CANONICAL_HOME_DIR ?? canonicalHomeDir;
  process.env.HAPPY_LOCAL_CANONICAL_HOME_DIR = process.env.HAPPY_LOCAL_CANONICAL_HOME_DIR ?? process.env.HAPPY_STACKS_CANONICAL_HOME_DIR;

  process.env.HAPPY_STACKS_HOME_DIR = process.env.HAPPY_STACKS_HOME_DIR ?? homeDir;
  process.env.HAPPY_LOCAL_HOME_DIR = process.env.HAPPY_LOCAL_HOME_DIR ?? process.env.HAPPY_STACKS_HOME_DIR;

  process.env.HAPPY_STACKS_WORKSPACE_DIR = process.env.HAPPY_STACKS_WORKSPACE_DIR ?? workspaceDir;
  process.env.HAPPY_LOCAL_WORKSPACE_DIR = process.env.HAPPY_LOCAL_WORKSPACE_DIR ?? process.env.HAPPY_STACKS_WORKSPACE_DIR;

  process.env.HAPPY_STACKS_RUNTIME_DIR = process.env.HAPPY_STACKS_RUNTIME_DIR ?? runtimeDir;
  process.env.HAPPY_LOCAL_RUNTIME_DIR = process.env.HAPPY_LOCAL_RUNTIME_DIR ?? process.env.HAPPY_STACKS_RUNTIME_DIR;

  process.env.HAPPY_STACKS_STORAGE_DIR = process.env.HAPPY_STACKS_STORAGE_DIR ?? storageDir;
  process.env.HAPPY_LOCAL_STORAGE_DIR = process.env.HAPPY_LOCAL_STORAGE_DIR ?? process.env.HAPPY_STACKS_STORAGE_DIR;

  return { argv: nextArgv, enabled: true };
}

function maybeAutoUpdateNotice(cliRootDir, cmd) {
  // Non-blocking, cached update checks:
  // - never run network calls in-process
  // - optionally print a notice (TTY only) if cache says an update is available
  // - periodically kick off a background check that refreshes the cache
  const enabled = (process.env.HAPPY_STACKS_UPDATE_CHECK ?? '1') !== '0';
  if (!enabled) return;
  // Never do background checks for non-interactive invocations (CI, LaunchAgents, scripts).
  if (!process.stdout.isTTY) return;
  if (process.env.HAPPY_STACKS_UPDATE_CHECK_SPAWNED === '1') return;
  if (cmd === 'self' || cmd === 'help' || cmd === '--help' || cmd === '-h') return;

  const homeDir = resolveHomeDir();
  const cacheDir = join(homeDir, 'cache');
  const cachePath = join(cacheDir, 'update.json');

  const intervalMsRaw = (process.env.HAPPY_STACKS_UPDATE_CHECK_INTERVAL_MS ?? '').trim();
  const intervalMs = intervalMsRaw ? Number(intervalMsRaw) : 24 * 60 * 60 * 1000;
  const notifyIntervalMsRaw = (process.env.HAPPY_STACKS_UPDATE_NOTIFY_INTERVAL_MS ?? '').trim();
  const notifyIntervalMs = notifyIntervalMsRaw ? Number(notifyIntervalMsRaw) : 24 * 60 * 60 * 1000;

  let cached = null;
  try {
    if (existsSync(cachePath)) {
      cached = JSON.parse(readFileSync(cachePath, 'utf-8'));
    }
  } catch {
    cached = null;
  }

  const now = Date.now();
  const checkedAt = typeof cached?.checkedAt === 'number' ? cached.checkedAt : 0;
  const shouldCheck = !checkedAt || (Number.isFinite(intervalMs) && now - checkedAt > intervalMs);

  const updateAvailable = Boolean(cached?.updateAvailable);
  const latest = typeof cached?.latest === 'string' ? cached.latest : '';
  const current = typeof cached?.current === 'string' ? cached.current : '';
  const notifiedAt = typeof cached?.notifiedAt === 'number' ? cached.notifiedAt : 0;
  const shouldNotify =
    Boolean(updateAvailable && latest) &&
    Boolean(process.stdout.isTTY) &&
    (!notifiedAt || (Number.isFinite(notifyIntervalMs) && now - notifiedAt > notifyIntervalMs));

  if (shouldNotify) {
    const from = current ? current : 'current';
    // Keep it short; no network calls here.
    console.error(`[happys] update available: ${from} -> ${latest} (run: happys self update)`);
    try {
      mkdirSync(cacheDir, { recursive: true });
      writeFileSync(
        cachePath,
        JSON.stringify(
          {
            ...(cached ?? {}),
            notifiedAt: now,
          },
          null,
          2
        ) + '\n',
        'utf-8'
      );
    } catch {
      // ignore
    }
  }

  if (!shouldCheck) return;

  // Kick off a background refresh (best-effort, no logs).
  try {
    const child = spawn(process.execPath, [join(cliRootDir, 'scripts', 'self.mjs'), 'check', '--quiet'], {
      stdio: 'ignore',
      cwd: cliRootDir,
      env: { ...process.env, HAPPY_STACKS_UPDATE_CHECK_SPAWNED: '1' },
      detached: true,
    });
    child.unref();
  } catch {
    // ignore
  }
}

function usage() {
  return renderHappysRootHelp();
}

function runNodeScript(cliRootDir, scriptRelPath, args) {
  const scriptPath = join(cliRootDir, scriptRelPath);
  if (!existsSync(scriptPath)) {
    console.error(`[happys] missing script: ${scriptPath}`);
    process.exit(1);
  }
  const res = spawnSync(process.execPath, [scriptPath, ...args], {
    stdio: 'inherit',
    env: process.env,
    cwd: cliRootDir,
  });
  process.exit(res.status ?? 1);
}

function main() {
  const cliRootDir = getCliRootDir();
  const initialArgv = process.argv.slice(2);
  const { argv, enabled: sandboxed } = applySandboxDirIfRequested(initialArgv);
  void sandboxed;
  maybeReexecToCliRoot(cliRootDir);

  // If the user passed only flags (common via `npx happy-stacks --help`),
  // treat it as root help rather than `help --help` (which would look like
  // "unknown command: --help").
  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';
  const cmdIndex = argv.indexOf(cmd);
  const rest = cmdIndex >= 0 ? argv.slice(cmdIndex + 1) : [];

  maybeAutoUpdateNotice(cliRootDir, cmd);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    const target = rest[0];
    if (!target || target.startsWith('-')) {
      console.log(usage());
      return;
    }
    const targetCmd = resolveHappysCommand(target);
    if (!targetCmd || targetCmd.kind !== 'node') {
      console.error(`[happys] unknown command: ${target}`);
      console.error('');
      console.log(usage());
      process.exit(1);
    }
    const helpArgs = commandHelpArgs(target) ?? ['--help'];
    return runNodeScript(cliRootDir, targetCmd.scriptRelPath, helpArgs);
  }

  const resolved = resolveHappysCommand(cmd);
  if (!resolved) {
    console.error(`[happys] unknown command: ${cmd}`);
    console.error('');
    console.error(usage());
    process.exit(1);
  }

  if (resolved.kind === 'external') {
    const args = resolved.external?.argsFromRest ? resolved.external.argsFromRest(rest) : rest;
    const res = spawnSync(resolved.external.cmd, args, { stdio: 'inherit', env: process.env });
    process.exit(res.status ?? 1);
  }

  const args = resolved.argsFromRest ? resolved.argsFromRest(rest) : rest;
  return runNodeScript(cliRootDir, resolved.scriptRelPath, args);
}

main();
