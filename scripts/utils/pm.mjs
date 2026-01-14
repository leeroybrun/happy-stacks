import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

import { pathExists } from './fs.mjs';
import { run, runCapture, spawnProc } from './proc.mjs';
import { getDefaultAutostartPaths, getHappyStacksHomeDir } from './paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from './runtime.mjs';

function sha256Hex(s) {
  return createHash('sha256').update(String(s ?? ''), 'utf-8').digest('hex');
}

async function readJsonIfExists(path) {
  try {
    if (!path || !existsSync(path)) return null;
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

async function writeJsonAtomic(path, value) {
  const dir = dirname(path);
  await mkdir(dir, { recursive: true }).catch(() => {});
  const tmp = join(dir, `.tmp.${Date.now()}.${Math.random().toString(16).slice(2)}.json`);
  await writeFile(tmp, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  await rename(tmp, path);
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

async function commandExists(cmd, options = {}) {
  try {
    await runCapture(cmd, ['--version'], options);
    return true;
  } catch {
    return false;
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

    if (pm.name === 'yarn' && (await pathExists(yarnLock))) {
      const lockM = await mtimeMs(yarnLock);
      const pkgM = await mtimeMs(pkgJson);
      const intM = await mtimeMs(yarnIntegrity);
      if (!intM || lockM > intM || pkgM > intM) {
        if (!quiet) {
          // eslint-disable-next-line no-console
          console.log(`[local] refreshing ${label} dependencies (yarn.lock/package.json changed)...`);
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
  if (mode === 'never') {
    return { built: false, reason: 'mode_never' };
  }
  const distEntrypoint = join(cliDir, 'dist', 'index.mjs');
  const buildStatePath = resolveBuildStatePath({ label: 'happy-cli', dir: cliDir });
  const gitSig = await computeGitWorktreeSignature(cliDir);
  const prev = await readJsonIfExists(buildStatePath);

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
exec happys happy "$@"
`;

  await writeFile(happyShim, shim, 'utf-8');
  await chmod(happyShim, 0o755).catch(() => {});

  // eslint-disable-next-line no-console
  console.log(`[local] installed 'happy' shim at ${happyShim}`);
  if (!existsSync(happysShim)) {
    // eslint-disable-next-line no-console
    console.log(`[local] note: run \`happys init\` to install a stable ${happysShim} shim for services/SwiftBar.`);
  }
}

export async function pmSpawnScript({ label, dir, script, env, options = {} }) {
  const pm = await getComponentPm(dir);
  if (pm.name === 'yarn') {
    return spawnProc(label, pm.cmd, ['-s', script], env, { ...options, cwd: dir });
  }
  return spawnProc(label, pm.cmd, ['--silent', script], env, { ...options, cwd: dir });
}

export async function pmSpawnBin({ label, dir, bin, args, env, options = {} }) {
  const pm = await getComponentPm(dir);
  if (pm.name === 'yarn') {
    return spawnProc(label, pm.cmd, [bin, ...args], env, { ...options, cwd: dir });
  }
  return spawnProc(label, pm.cmd, ['exec', bin, ...args], env, { ...options, cwd: dir });
}

export async function pmExecBin({ dir, bin, args, env, quiet = false }) {
  const pm = await getComponentPm(dir);
  const stdio = quiet ? 'ignore' : 'inherit';
  if (pm.name === 'yarn') {
    await run(pm.cmd, [bin, ...args], { env, cwd: dir, stdio });
    return;
  }
  await run(pm.cmd, ['exec', bin, ...args], { env, cwd: dir, stdio });
}

export async function ensureMacAutostartEnabled({ rootDir, label = 'com.happy.local', env = {} }) {
  if (process.platform !== 'darwin') {
    throw new Error('[local] autostart is currently only implemented for macOS (LaunchAgents).');
  }

  const {
    logsDir,
    stdoutPath,
    stderrPath,
    plistPath,
    primaryLabel,
    legacyLabel,
    primaryPlistPath,
    legacyPlistPath,
    primaryStdoutPath,
    primaryStderrPath,
    legacyStdoutPath,
    legacyStderrPath,
  } = getDefaultAutostartPaths();
  await mkdir(logsDir, { recursive: true });

  const nodePath = process.env.HAPPY_STACKS_NODE?.trim()
    ? process.env.HAPPY_STACKS_NODE.trim()
    : process.env.HAPPY_LOCAL_NODE?.trim()
      ? process.env.HAPPY_LOCAL_NODE.trim()
      : process.execPath;
  const installedRoot = resolveInstalledCliRoot(rootDir);
  const happysEntrypoint = resolveInstalledPath(rootDir, join('bin', 'happys.mjs'));
  const happysShim = join(getHappyStacksHomeDir(), 'bin', 'happys');
  const useShim = existsSync(happysShim);

  // Ensure we write to the plist path that matches the label we're installing, instead of the
  // "active" plist path (which might be legacy and cause filename/label mismatches).
  const resolvedPlistPath =
    label === primaryLabel ? primaryPlistPath : label === legacyLabel ? legacyPlistPath : join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  const resolvedStdoutPath = label === primaryLabel ? primaryStdoutPath : label === legacyLabel ? legacyStdoutPath : stdoutPath;
  const resolvedStderrPath = label === primaryLabel ? primaryStderrPath : label === legacyLabel ? legacyStderrPath : stderrPath;

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      ${useShim ? `<string>${happysShim}</string>` : `<string>${nodePath}</string>\n      <string>${happysEntrypoint}</string>`}
      <string>start</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${installedRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${resolvedStdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${resolvedStderrPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(env)
  .map(([k, v]) => `      <key>${k}</key>\n      <string>${String(v)}</string>`)
  .join('\n')}
    </dict>
  </dict>
</plist>
`;

  await mkdir(dirname(resolvedPlistPath), { recursive: true });
  await writeFile(resolvedPlistPath, plist, 'utf-8');

  // Best-effort (works on most macOS setups). If it fails, the plist still exists and can be loaded manually.
  try {
    await run('launchctl', ['unload', '-w', resolvedPlistPath]);
  } catch {
    // ignore
  }
  await run('launchctl', ['load', '-w', resolvedPlistPath]);
}

export async function ensureMacAutostartDisabled({ label = 'com.happy.local' }) {
  if (process.platform !== 'darwin') {
    return;
  }
  const { primaryLabel, legacyLabel, primaryPlistPath, legacyPlistPath } = getDefaultAutostartPaths();
  const resolvedPlistPath =
    label === primaryLabel ? primaryPlistPath : label === legacyLabel ? legacyPlistPath : join(homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
  try {
    await run('launchctl', ['unload', '-w', resolvedPlistPath]);
  } catch {
    // Old-style unload can fail on newer macOS; fall back to modern bootout.
    try {
      const uid = typeof process.getuid === 'function' ? process.getuid() : null;
      if (uid != null) {
        await run('launchctl', ['bootout', `gui/${uid}/${label}`]);
      }
    } catch {
      // ignore
    }
  }
  // eslint-disable-next-line no-console
  console.log(`[local] autostart disabled (${label})`);
}
