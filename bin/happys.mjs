#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getCliRootDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function resolveHomeDir() {
  const fromEnv = (process.env.HAPPY_STACKS_HOME_DIR ?? '').trim();
  if (fromEnv) {
    return fromEnv.replace(/^~(?=\/)/, homedir());
  }
  return join(homedir(), '.happy-stacks');
}

function maybeAutoUpdateNotice(cliRootDir, cmd) {
  // Non-blocking, cached update checks:
  // - never run network calls in-process
  // - optionally print a notice (TTY only) if cache says an update is available
  // - periodically kick off a background check that refreshes the cache
  const enabled = (process.env.HAPPY_STACKS_UPDATE_CHECK ?? '1') !== '0';
  if (!enabled) return;
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
  return [
    'happys - Happy Stacks CLI',
    '',
    'usage:',
    '  happys init [--home-dir=PATH] [--workspace-dir=PATH] [--runtime-dir=PATH] [--install-path] [--no-runtime] [--no-bootstrap] [--] [bootstrap args...]',
    '  happys bootstrap [-- ...]',
    '  happys start [-- ...]',
    '  happys dev [-- ...]',
    '  happys build [-- ...]',
    '  happys mobile [-- ...]',
    '  happys doctor [--fix] [--json]',
    '  happys self status|update|check [--json]',
    '  happys auth status|login [--json]',
    '  happys happy <happy-cli args...>',
    '  happys wt <args...>',
    '  happys srv <status|use ...>',
    '  happys stack <args...>',
    '  happys tailscale <status|enable|disable|url ...>',
    '  happys service <install|uninstall|status|start|stop|restart|enable|disable|logs|tail>',
    '  happys menubar <install|open>',
  ].join('\n');
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
  const argv = process.argv.slice(2);

  const cmd = argv.find((a) => !a.startsWith('--')) ?? 'help';
  const rest = cmd === 'help' ? [] : argv.slice(argv.indexOf(cmd) + 1);

  maybeAutoUpdateNotice(cliRootDir, cmd);

  switch (cmd) {
    case 'help':
    case '--help':
    case '-h':
      console.log(usage());
      return;
    case 'init':
      return runNodeScript(cliRootDir, 'scripts/init.mjs', rest);
    case 'bootstrap':
      return runNodeScript(cliRootDir, 'scripts/install.mjs', rest);
    case 'start':
      return runNodeScript(cliRootDir, 'scripts/run.mjs', rest);
    case 'dev':
      return runNodeScript(cliRootDir, 'scripts/dev.mjs', rest);
    case 'build':
      return runNodeScript(cliRootDir, 'scripts/build.mjs', rest);
    case 'mobile':
      return runNodeScript(cliRootDir, 'scripts/mobile.mjs', rest);
    case 'mobile:prebuild':
      return runNodeScript(cliRootDir, 'scripts/mobile.mjs', ['--prebuild', '--clean', '--no-metro', ...rest]);
    case 'mobile:ios':
      return runNodeScript(cliRootDir, 'scripts/mobile.mjs', ['--run-ios', '--no-metro', ...rest]);
    case 'mobile:ios:release':
      return runNodeScript(cliRootDir, 'scripts/mobile.mjs', ['--run-ios', '--no-metro', '--configuration=Release', ...rest]);
    case 'mobile:install':
      return runNodeScript(cliRootDir, 'scripts/mobile.mjs', ['--run-ios', '--no-metro', '--configuration=Release', ...rest]);
    case 'mobile:devices': {
      const res = spawnSync('xcrun', ['xcdevice', 'list'], { stdio: 'inherit', env: process.env });
      process.exit(res.status ?? 1);
    }
    case 'doctor':
      return runNodeScript(cliRootDir, 'scripts/doctor.mjs', rest);
    case 'self':
      return runNodeScript(cliRootDir, 'scripts/self.mjs', rest);
    case 'stack:doctor':
      return runNodeScript(cliRootDir, 'scripts/doctor.mjs', rest);
    case 'stack:fix':
      return runNodeScript(cliRootDir, 'scripts/doctor.mjs', ['--fix', ...rest]);
    case 'auth':
      return runNodeScript(cliRootDir, 'scripts/auth.mjs', rest);
    case 'happy':
      return runNodeScript(cliRootDir, 'scripts/happy.mjs', rest);
    case 'wt':
      return runNodeScript(cliRootDir, 'scripts/worktrees.mjs', rest);
    case 'srv':
    case 'server-flavor':
      return runNodeScript(cliRootDir, 'scripts/server_flavor.mjs', rest);
    case 'stack':
      return runNodeScript(cliRootDir, 'scripts/stack.mjs', rest);
    case 'cli:link':
      return runNodeScript(cliRootDir, 'scripts/cli-link.mjs', rest);
    case 'tailscale':
      return runNodeScript(cliRootDir, 'scripts/tailscale.mjs', rest);
    case 'service':
      return runNodeScript(cliRootDir, 'scripts/service.mjs', rest);
    case 'service:status':
    case 'service:start':
    case 'service:stop':
    case 'service:restart':
    case 'service:enable':
    case 'service:disable':
    case 'service:install':
    case 'service:uninstall':
      return runNodeScript(cliRootDir, 'scripts/service.mjs', [cmd.slice('service:'.length), ...rest]);
    case 'logs':
      return runNodeScript(cliRootDir, 'scripts/service.mjs', ['logs', ...rest]);
    case 'logs:tail':
      return runNodeScript(cliRootDir, 'scripts/service.mjs', ['tail', ...rest]);
    case 'menubar':
    case 'menubar:install':
    case 'menubar:open':
      return runNodeScript(cliRootDir, 'scripts/menubar.mjs', [cmd, ...rest].filter(Boolean));
    case 'tailscale:status':
    case 'tailscale:enable':
    case 'tailscale:disable':
    case 'tailscale:reset':
    case 'tailscale:url':
      return runNodeScript(cliRootDir, 'scripts/tailscale.mjs', [cmd.slice('tailscale:'.length), ...rest]);
    default:
      console.error(`[happys] unknown command: ${cmd}`);
      console.error('');
      console.error(usage());
      process.exit(1);
  }
}

main();
