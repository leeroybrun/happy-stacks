import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { pathExists } from '../fs/fs.mjs';
import { readJsonIfExists, writeJsonAtomic } from '../fs/json.mjs';
import { run, runCapture, spawnProc } from './proc.mjs';
import { commandExists } from './commands.mjs';
import { getDefaultAutostartPaths, getHappyStacksHomeDir } from '../paths/paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from '../paths/runtime.mjs';

function sha256Hex(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf-8').digest('hex');
}

function resolveBuildStatePath({ label, dir }) {
  const homeDir = getHappyStacksHomeDir();
  const key = sha256Hex(resolve(dir));
  return join(homeDir, 'cache', 'build', label, `${key}.json`);
}

async function computeGitWorktreeSignature(dir) {
  try {
    // Fast path: only if this is a git worktree.
    const inside = (await runCapture('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'])).trim();
    if (inside !== 'true') return null;
    const head = (await runCapture('git', ['-C', dir, 'rev-parse', 'HEAD'])).trim();
    // Includes staged + unstaged + untracked changes; captures “dirty” vs “clean”.
    const status = await runCapture('git', ['-C', dir, 'status', '--porcelain=v1']);
    return {
      kind: 'git',
      head,
      statusHash: sha256Hex(status),
      signature: sha256Hex(`${head}\n${status}`),
    };
  } catch {
    return null;
  }
}

export async function requirePnpm() {
  if (await commandExists('pnpm')) {
    return;
  }
  throw new Error(
    '[local] pnpm is required to install dependencies for Happy Stacks.\n' +
      'Install it via Corepack: `corepack enable && corepack prepare pnpm@latest --activate`'
  );
}

async function getComponentPm(dir) {
  const yarnLock = join(dir, 'yarn.lock');
  if (await pathExists(yarnLock)) {
    // IMPORTANT: when happy-stacks itself is pinned to pnpm via Corepack, running `yarn`
    // from the happy-stacks cwd can be blocked. Always probe yarn with cwd=componentDir.
    if (!(await commandExists('yarn', { cwd: dir }))) {
      throw new Error(`[local] yarn is required for component at ${dir} (yarn.lock present). Install it via Corepack: \`corepack enable\``);
    }
    return { name: 'yarn', cmd: 'yarn' };
  }

  // Default fallback if no yarn.lock: use pnpm.
  await requirePnpm();
  return { name: 'pnpm', cmd: 'pnpm' };
}

export async function requireDir(label, dir) {
  if (await pathExists(dir)) {
    return;
  }
  throw new Error(
    `[local] missing ${label} at ${dir}\n` +
      `Run: happys bootstrap (auto-clones missing components), or place the repo under components/`
  );
}

export async function ensureDepsInstalled(dir, label, { quiet = false } = {}) {
  const pkgJson = join(dir, 'package.json');
  if (!(await pathExists(pkgJson))) {
    return;
  }

  const nodeModules = join(dir, 'node_modules');
  const pnpmModulesMeta = join(dir, 'node_modules', '.modules.yaml');
  const pm = await getComponentPm(dir);
  const stdio = quiet ? 'ignore' : 'inherit';

  if (await pathExists(nodeModules)) {
    const yarnLock = join(dir, 'yarn.lock');
    const yarnIntegrity = join(nodeModules, '.yarn-integrity');
    const pnpmLock = join(dir, 'pnpm-lock.yaml');

    // If this repo is Yarn-managed (yarn.lock present) but node_modules was created by pnpm,
    // reinstall with Yarn to restore upstream-locked dependency versions.
    if (pm.name === 'yarn' && (await pathExists(pnpmModulesMeta))) {
      if (!quiet) {
        // eslint-disable-next-line no-console
        console.log(`[local] converting ${label} dependencies back to yarn (reinstalling node_modules)...`);
      }
      await rm(nodeModules, { recursive: true, force: true });
      await run(pm.cmd, ['install'], { cwd: dir, stdio });
    }

    // If dependencies changed since the last install, re-run install even if node_modules exists.
    const mtimeMs = async (p) => {
      try {
        const s = await stat(p);
        return s.mtimeMs ?? 0;
      } catch {
        return 0;
      }
    };

    const patchesMtimeMs = async () => {
      // Happy's mobile app (and some other repos) use patch-package and keep patches under `patches/`.
      // If a patch file changes but yarn.lock/package.json do not, Yarn won't reinstall and
      // patch-package won't re-apply the patch, leading to confusing "why isn't my patch wired?"
      // failures later (e.g. during iOS pod install).
      const patchesDir = join(dir, 'patches');
      if (!(await pathExists(patchesDir))) return 0;
      try {
        const entries = await readdir(patchesDir, { withFileTypes: true });
        let max = 0;
        for (const e of entries) {
          if (!e.isFile()) continue;
          if (!e.name.endsWith('.patch')) continue;
          const m = await mtimeMs(join(patchesDir, e.name));
          if (m > max) max = m;
        }
        return max;
      } catch {
        return 0;
      }
    };

    if (pm.name === 'yarn' && (await pathExists(yarnLock))) {
      const lockM = await mtimeMs(yarnLock);
      const pkgM = await mtimeMs(pkgJson);
      const intM = await mtimeMs(yarnIntegrity);
      const patchM = await patchesMtimeMs();
      if (!intM || lockM > intM || pkgM > intM || patchM > intM) {
        if (!quiet) {
          // eslint-disable-next-line no-console
          console.log(`[local] refreshing ${label} dependencies (yarn.lock/package.json/patches changed)...`);
        }
        await run(pm.cmd, ['install'], { cwd: dir, stdio });
      }
    }

    if (pm.name === 'pnpm' && (await pathExists(pnpmLock))) {
      const lockM = await mtimeMs(pnpmLock);
      const metaM = await mtimeMs(pnpmModulesMeta);
      if (!metaM || lockM > metaM) {
        if (!quiet) {
          // eslint-disable-next-line no-console
          console.log(`[local] refreshing ${label} dependencies (pnpm-lock changed)...`);
        }
        await run(pm.cmd, ['install'], { cwd: dir, stdio });
      }
    }

    return;
  }

  if (!quiet) {
    // eslint-disable-next-line no-console
    console.log(`[local] installing ${label} dependencies (first run)...`);
  }
  await run(pm.cmd, ['install'], { cwd: dir, stdio });
}

export async function ensureCliBuilt(cliDir, { buildCli }) {
  await ensureDepsInstalled(cliDir, 'happy-cli');
  if (!buildCli) {
    return { built: false, reason: 'disabled' };
  }
  // Default: build only when needed (fast + reliable for worktrees that haven't been built yet).
  //
  // You can force always-build by setting:
  // - HAPPY_STACKS_CLI_BUILD_MODE=always (legacy: HAPPY_LOCAL_CLI_BUILD_MODE=always)
  // Or disable via:
  // - HAPPY_STACKS_CLI_BUILD=0 (legacy: HAPPY_LOCAL_CLI_BUILD=0)
  const modeRaw = (process.env.HAPPY_STACKS_CLI_BUILD_MODE ?? process.env.HAPPY_LOCAL_CLI_BUILD_MODE ?? 'auto').trim().toLowerCase();
  const mode = modeRaw === 'always' || modeRaw === 'auto' || modeRaw === 'never' ? modeRaw : 'auto';
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const buildStatePath = resolveBuildStatePath({ label: 'happy-cli', dir: cliDir });
  const gitSig = await computeGitWorktreeSignature(cliDir);
  const prev = await readJsonIfExists(buildStatePath);

  // "never" should prevent rebuild churn, but it must not make the stack unrunnable.
  // If the dist entrypoint is missing, build once even in "never" mode.
  if (mode === 'never') {
    if (await pathExists(distEntrypoint)) {
      return { built: false, reason: 'mode_never' };
    }
    // fallthrough to build
  }

  if (mode === 'auto') {
    // If dist doesn't exist, we must build.
    if (!(await pathExists(distEntrypoint))) {
      // fallthrough to build
    } else if (gitSig && prev?.signature && prev.signature === gitSig.signature) {
      return { built: false, reason: 'up_to_date' };
    } else if (!gitSig) {
      // No git info: best-effort skip if dist exists (keeps this fast outside git worktrees).
      return { built: false, reason: 'no_git_info' };
    }
  }

  // eslint-disable-next-line no-console
  console.log('[local] building happy-cli...');
  const pm = await getComponentPm(cliDir);
  await run(pm.cmd, ['build'], { cwd: cliDir });

  // Sanity check: happy-cli daemon entrypoint must exist after a successful build.
  // Without this, watch-based rebuilds can restart the daemon into a MODULE_NOT_FOUND crash,
  // which looks like the UI "dies out of nowhere" even though the root cause is missing build output.
  if (!(await pathExists(distEntrypoint))) {
    throw new Error(
      `[local] happy-cli build finished but did not produce expected entrypoint.\n` +
        `Expected: ${distEntrypoint}\n` +
        `Fix: run the component build directly and inspect its output:\n` +
        `  cd "${cliDir}" && ${pm.cmd} build`
    );
  }

  // Persist new build state (best-effort).
  const nowSig = gitSig ?? (await computeGitWorktreeSignature(cliDir));
  if (nowSig) {
    await writeJsonAtomic(buildStatePath, {
      label: 'happy-cli',
      dir: resolve(cliDir),
      signature: nowSig.signature,
      head: nowSig.head,
      statusHash: nowSig.statusHash,
      builtAt: new Date().toISOString(),
    }).catch(() => {});
  }
  return { built: true, reason: mode === 'always' ? 'mode_always' : 'changed' };
}

function getPathEntries() {
  const raw = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return raw.split(delimiter).filter(Boolean);
}

function isPathInside(path, dir) {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

export async function ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli }) {
  if (!npmLinkCli) {
    return;
  }

  const homeDir = getHappyStacksHomeDir();
  const binDir = join(homeDir, 'bin');
  await mkdir(binDir, { recursive: true });

  const happysShim = join(binDir, 'happys');
  const happyShim = join(binDir, 'happy');

  const shim = `#!/bin/bash
set -euo pipefail
# Prefer the sibling happys shim (works for sandbox installs too).
BIN_DIR="$(cd "$(dirname "$0")" && pwd)"
HAPPYS="$BIN_DIR/happys"
if [[ -x "$HAPPYS" ]]; then
  exec "$HAPPYS" happy "$@"
fi

# Fallback: run happy-stacks from runtime install if present.
HOME_DIR="\${HAPPY_STACKS_HOME_DIR:-\${HAPPY_LOCAL_HOME_DIR:-$HOME/.happy-stacks}}"
RUNTIME="$HOME_DIR/runtime/node_modules/happy-stacks/bin/happys.mjs"
if [[ -f "$RUNTIME" ]]; then
  exec node "$RUNTIME" happy "$@"
fi

echo "error: cannot find happys shim or runtime install" >&2
exit 1
`;

  const writeIfChanged = async (path, text) => {
    let existing = '';
    try {
      existing = await readFile(path, 'utf-8');
    } catch {
      existing = '';
    }
    if (existing === text) return false;
    await writeFile(path, text, 'utf-8');
    return true;
  };

  await writeIfChanged(happyShim, shim);
  await chmod(happyShim, 0o755).catch(() => {});

  // happys shim: use node + CLI root; if runtime install exists, prefer it.
  const cliRoot = resolveInstalledCliRoot(rootDir);
  const happysShimText = `#!/bin/bash
set -euo pipefail
exec node "${resolveInstalledPath(rootDir, 'bin/happys.mjs')}" "$@"
`;
  await writeIfChanged(happysShim, happysShimText);
  await chmod(happysShim, 0o755).catch(() => {});

  // If user’s PATH points at a legacy install path, try to make it sane (best-effort).
  const entries = getPathEntries();
  const legacyBin = join(homedir(), '.happy-stacks', 'bin');
  const newBin = join(getDefaultAutostartPaths().baseDir, 'bin');
  if (entries.some((p) => isPathInside(p, legacyBin)) && !entries.some((p) => isPathInside(p, newBin))) {
    // eslint-disable-next-line no-console
    console.log(`[local] note: your PATH includes ${legacyBin}; recommended path is ${newBin}`);
  }

  return { ok: true, cliRoot, binDir, happyShim, happysShim };
}

export async function pmExecBin(dirOrOpts, binArg, argsArg, optsArg) {
  const usesObjectStyle = typeof dirOrOpts === 'object' && dirOrOpts !== null;

  const dir = usesObjectStyle ? dirOrOpts.dir : dirOrOpts;
  const bin = usesObjectStyle ? dirOrOpts.bin : binArg;
  const args = usesObjectStyle ? (dirOrOpts.args ?? []) : (argsArg ?? []);

  const env = usesObjectStyle ? (dirOrOpts.env ?? process.env) : (optsArg?.env ?? process.env);
  const quiet = usesObjectStyle ? Boolean(dirOrOpts.quiet) : Boolean(optsArg?.quiet);
  const stdio = quiet ? 'ignore' : 'inherit';

  const pm = await getComponentPm(dir);
  if (pm.name === 'yarn') {
    await run(pm.cmd, ['run', bin, ...args], { cwd: dir, env, stdio });
    return;
  }
  await run(pm.cmd, ['exec', bin, ...args], { cwd: dir, env, stdio });
}

export async function pmSpawnBin(dir, label, bin, args, { env = process.env } = {}) {
  const usesObjectStyle = typeof dir === 'object' && dir !== null;
  const componentDir = usesObjectStyle ? dir.dir : dir;
  const componentLabel = usesObjectStyle ? dir.label : label;
  const componentBin = usesObjectStyle ? dir.bin : bin;
  const componentArgs = usesObjectStyle ? (dir.args ?? []) : (args ?? []);
  const componentEnv = usesObjectStyle ? (dir.env ?? process.env) : (env ?? process.env);
  const options = usesObjectStyle ? (dir.options ?? {}) : {};

  const pm = await getComponentPm(componentDir);
  if (pm.name === 'yarn') {
    return spawnProc(componentLabel, pm.cmd, ['run', componentBin, ...componentArgs], componentEnv, { cwd: componentDir, ...options });
  }
  return spawnProc(componentLabel, pm.cmd, ['exec', componentBin, ...componentArgs], componentEnv, { cwd: componentDir, ...options });
}

export async function pmSpawnScript(dir, label, script, args, { env = process.env } = {}) {
  const usesObjectStyle = typeof dir === 'object' && dir !== null;
  const componentDir = usesObjectStyle ? dir.dir : dir;
  const componentLabel = usesObjectStyle ? dir.label : label;
  const componentScript = usesObjectStyle ? dir.script : script;
  const componentArgs = usesObjectStyle ? (dir.args ?? []) : (args ?? []);
  const componentEnv = usesObjectStyle ? (dir.env ?? process.env) : (env ?? process.env);
  const options = usesObjectStyle ? (dir.options ?? {}) : {};

  const pm = await getComponentPm(componentDir);
  if (pm.name === 'yarn') {
    return spawnProc(componentLabel, pm.cmd, ['run', componentScript, ...componentArgs], componentEnv, { cwd: componentDir, ...options });
  }
  return spawnProc(componentLabel, pm.cmd, ['run', componentScript, ...componentArgs], componentEnv, { cwd: componentDir, ...options });
}
