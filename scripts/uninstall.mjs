import './utils/env.mjs';

import { rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { expandHome } from './utils/canonical_home.mjs';
import { getHappyStacksHomeDir, getRootDir, getStacksStorageRoot } from './utils/paths.mjs';
import { getRuntimeDir } from './utils/runtime.mjs';
import { getCanonicalHomeEnvPath } from './utils/config.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/sandbox.mjs';

function resolveWorkspaceDir({ rootDir, homeDir }) {
  // Uninstall should never default to deleting the repo root (getWorkspaceDir() can fall back to cliRootDir).
  const fromEnv = (process.env.HAPPY_STACKS_WORKSPACE_DIR ?? '').trim();
  if (fromEnv) {
    return expandHome(fromEnv);
  }
  void rootDir;
  return join(homeDir, 'workspace');
}

function resolveSwiftbarPluginsDir() {
  // Same logic as extras/swiftbar/install.sh.
  const s =
    'DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; if [[ -n "$DIR" && -d "$DIR" ]]; then echo "$DIR"; exit 0; fi; D="$HOME/Library/Application Support/SwiftBar/Plugins"; if [[ -d "$D" ]]; then echo "$D"; exit 0; fi; echo ""';
  const res = spawnSync('bash', ['-lc', s], { encoding: 'utf-8' });
  const out = String(res.stdout ?? '').trim();
  return out || null;
}

async function removeSwiftbarPluginFiles() {
  if (process.platform !== 'darwin') {
    return { ok: true, removed: 0, pluginsDir: null };
  }
  const pluginsDir = resolveSwiftbarPluginsDir();
  if (!pluginsDir) {
    return { ok: true, removed: 0, pluginsDir: null };
  }

  let removed = 0;
  const patterns = ['happy-stacks.*.sh', 'happy-local.*.sh'];
  for (const pat of patterns) {
    const res = spawnSync('bash', ['-lc', `rm -f "${pluginsDir}"/${pat} 2>/dev/null || true`], { stdio: 'ignore' });
    void res;
    // best-effort count: if directory exists, we can scan remaining files; skip precise counts
  }

  // Count remaining matches (best-effort).
  const check = spawnSync('bash', ['-lc', `ls -1 "${pluginsDir}"/happy-stacks.*.sh 2>/dev/null | wc -l | tr -d ' '`], {
    encoding: 'utf-8',
  });
  const remaining = Number(String(check.stdout ?? '').trim());
  if (Number.isFinite(remaining) && remaining === 0) {
    removed = 1;
  }
  return { ok: true, removed, pluginsDir };
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags }) || argv.includes('help')) {
    printResult({
      json,
      data: { flags: ['--remove-workspace', '--remove-stacks', '--yes', '--global'], json: true },
      text: [
        '[uninstall] usage:',
        '  happys uninstall [--json]   # dry-run',
        '  happys uninstall --yes [--json]',
        '  happys uninstall --remove-workspace --yes',
        '  happys uninstall --remove-stacks --yes',
        '  happys uninstall --global --yes   # also remove global OS integrations (services/SwiftBar) even in sandbox mode',
        '',
        'notes:',
        '  - default removes: runtime, shims, cache, SwiftBar assets + plugin files, and LaunchAgent services',
        '  - stacks under ~/.happy/stacks are kept unless --remove-stacks is provided',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const homeDir = getHappyStacksHomeDir();
  const runtimeDir = getRuntimeDir();
  const workspaceDir = resolveWorkspaceDir({ rootDir, homeDir });

  const yes = flags.has('--yes');
  const removeWorkspace = flags.has('--remove-workspace');
  const removeStacks = flags.has('--remove-stacks');
  const allowGlobal = flags.has('--global') || sandboxAllowsGlobalSideEffects();

  const dryRun = !yes;

  // 1) Stop/uninstall services best-effort.
  if (!dryRun && (!isSandboxed() || allowGlobal)) {
    try {
      spawnSync(process.execPath, [join(rootDir, 'scripts', 'service.mjs'), 'uninstall'], {
        stdio: json ? 'ignore' : 'inherit',
        env: process.env,
        cwd: rootDir,
      });
    } catch {
      // ignore
    }
  }

  // 2) Remove SwiftBar plugin files best-effort.
  const menubar =
    isSandboxed() && !allowGlobal
      ? { ok: true, removed: 0, pluginsDir: null, skipped: 'sandbox' }
      : dryRun
        ? { ok: true, removed: 0, pluginsDir: resolveSwiftbarPluginsDir() }
        : await removeSwiftbarPluginFiles().catch(() => ({ ok: false, removed: 0, pluginsDir: null }));

  // 3) Remove home-managed runtime + shims + extras + cache + env pointers.
  const canonicalEnv = getCanonicalHomeEnvPath();
  const toRemove = [
    join(homeDir, 'bin'),
    join(homeDir, 'runtime'),
    join(homeDir, 'extras'),
    join(homeDir, 'cache'),
    join(homeDir, '.env'),
    join(homeDir, 'env.local'),
    // Stable pointer file (can differ from homeDir for custom installs).
    canonicalEnv,
  ];
  const removedPaths = [];
  for (const p of toRemove) {
    try {
      if (existsSync(p)) {
        if (!dryRun) {
          await rm(p, { recursive: true, force: true });
        }
        removedPaths.push(p);
      }
    } catch {
      // ignore
    }
  }

  // 4) Optionally remove workspace (components/worktrees).
  if (removeWorkspace) {
    const ws = expandHome(workspaceDir);
    if (existsSync(ws)) {
      if (!dryRun) {
        await rm(ws, { recursive: true, force: true });
      }
      removedPaths.push(ws);
    }
  }

  // 5) Optionally remove stacks data.
  if (removeStacks) {
    const stacksRoot = getStacksStorageRoot();
    if (existsSync(stacksRoot)) {
      if (!dryRun) {
        await rm(stacksRoot, { recursive: true, force: true });
      }
      removedPaths.push(stacksRoot);
    }
  }

  printResult({
    json,
    data: {
      ok: true,
      homeDir,
      runtimeDir,
      workspaceDir,
      removedPaths,
      menubar,
      removeWorkspace,
      removeStacks,
      dryRun,
    },
    text: [
      dryRun ? '[uninstall] dry run (no changes made)' : '[uninstall] complete',
      dryRun ? '[uninstall] re-run with --yes to apply removals' : null,
      `[uninstall] home: ${homeDir}`,
      `[uninstall] removed: ${removedPaths.length ? removedPaths.join(', ') : '(nothing)'}`,
      menubar?.pluginsDir ? `[uninstall] SwiftBar plugins dir: ${menubar.pluginsDir}` : null,
      removeWorkspace ? `[uninstall] workspace removed: ${workspaceDir}` : `[uninstall] workspace kept: ${workspaceDir}`,
      removeStacks ? `[uninstall] stacks removed: ${getStacksStorageRoot()}` : `[uninstall] stacks kept: ${getStacksStorageRoot()}`,
    ]
      .filter(Boolean)
      .join('\n'),
  });
}

main().catch((err) => {
  console.error('[uninstall] failed:', err);
  process.exit(1);
});
