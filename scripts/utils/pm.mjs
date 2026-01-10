import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, mkdir, realpath, rm, stat, writeFile } from 'node:fs/promises';

import { pathExists } from './fs.mjs';
import { run, runCapture, spawnProc } from './proc.mjs';
import { getDefaultAutostartPaths, getHappyStacksHomeDir } from './paths.mjs';
import { resolveInstalledPath, resolveInstalledCliRoot } from './runtime.mjs';

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

export async function ensureDepsInstalled(dir, label) {
  const pkgJson = join(dir, 'package.json');
  if (!(await pathExists(pkgJson))) {
    return;
  }

  const nodeModules = join(dir, 'node_modules');
  const pnpmModulesMeta = join(dir, 'node_modules', '.modules.yaml');
  const pm = await getComponentPm(dir);

  if (await pathExists(nodeModules)) {
    const yarnLock = join(dir, 'yarn.lock');
    const yarnIntegrity = join(nodeModules, '.yarn-integrity');
    const pnpmLock = join(dir, 'pnpm-lock.yaml');

    // If this repo is Yarn-managed (yarn.lock present) but node_modules was created by pnpm,
    // reinstall with Yarn to restore upstream-locked dependency versions.
    if (pm.name === 'yarn' && (await pathExists(pnpmModulesMeta))) {
      // eslint-disable-next-line no-console
      console.log(`[local] converting ${label} dependencies back to yarn (reinstalling node_modules)...`);
      await rm(nodeModules, { recursive: true, force: true });
      await run(pm.cmd, ['install'], { cwd: dir });
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
        // eslint-disable-next-line no-console
        console.log(`[local] refreshing ${label} dependencies (yarn.lock/package.json changed)...`);
        await run(pm.cmd, ['install'], { cwd: dir });
      }
    }

    if (pm.name === 'pnpm' && (await pathExists(pnpmLock))) {
      const lockM = await mtimeMs(pnpmLock);
      const metaM = await mtimeMs(pnpmModulesMeta);
      if (!metaM || lockM > metaM) {
        // eslint-disable-next-line no-console
        console.log(`[local] refreshing ${label} dependencies (pnpm-lock changed)...`);
        await run(pm.cmd, ['install'], { cwd: dir });
      }
    }

    return;
  }

  // eslint-disable-next-line no-console
  console.log(`[local] installing ${label} dependencies (first run)...`);
  await run(pm.cmd, ['install'], { cwd: dir });
}

export async function ensureCliBuilt(cliDir, { buildCli }) {
  await ensureDepsInstalled(cliDir, 'happy-cli');
  if (!buildCli) {
    return;
  }
  // eslint-disable-next-line no-console
  console.log('[local] building happy-cli...');
  const pm = await getComponentPm(cliDir);
  await run(pm.cmd, ['build'], { cwd: cliDir });
}

function getPathEntries() {
  const raw = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return raw.split(delimiter).filter(Boolean);
}

async function findHappyOnPath() {
  const candidates = process.platform === 'win32' ? ['happy.cmd', 'happy.exe', 'happy.bat', 'happy'] : ['happy'];
  for (const dir of getPathEntries()) {
    for (const name of candidates) {
      const p = join(dir, name);
      if (await pathExists(p)) {
        return p;
      }
    }
  }
  return null;
}

function isPathInside(path, dir) {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

export async function ensureCliNpmLinked(cliDir, { npmLinkCli }) {
  if (!npmLinkCli) {
    return;
  }

  // Reliable check: does global node_modules/happy-coder resolve into this folder?
  try {
    const npmRootRaw = await runCapture('npm', ['root', '-g']);
    const npmRoot = npmRootRaw.trim();
    if (npmRoot) {
      const globalPkg = join(npmRoot, 'happy-coder');
      if (await pathExists(globalPkg)) {
        const resolvedPkg = await realpath(globalPkg);
        if (isPathInside(resolvedPkg, cliDir)) {
          return;
        }
      }
    }
  } catch {
    // ignore and fall back to PATH heuristic below
  }

  const happyBin = await findHappyOnPath();
  if (happyBin) {
    try {
      const resolved = await realpath(happyBin);
      if (isPathInside(resolved, cliDir)) {
        return;
      }
    } catch {
      // ignore
    }
  }

  // eslint-disable-next-line no-console
  console.log('[local] linking happy-cli into PATH (npm link)...');
  await run('npm', ['link'], { cwd: cliDir });

  const happyBinAfter = await findHappyOnPath();
  if (happyBinAfter) {
    return;
  }

  // If npm global bin isn't on PATH, users won't see the command.
  try {
    const npmBin = (await runCapture('npm', ['bin', '-g'])).trim();
    if (npmBin) {
      // eslint-disable-next-line no-console
      console.log(`[local] 'happy' was linked but is still not on your PATH.`);
      // eslint-disable-next-line no-console
      console.log(`[local] Add this directory to PATH: ${npmBin}`);
      // eslint-disable-next-line no-console
      console.log(`[local] Example (zsh): echo 'export PATH=\"${npmBin}:$PATH\"' >> ~/.zshrc && source ~/.zshrc`);
    }
  } catch {
    // ignore
  }
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
HOME_DIR="\${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"
HAPPYS="$HOME_DIR/bin/happys"
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

export async function pmExecBin({ dir, bin, args, env }) {
  const pm = await getComponentPm(dir);
  if (pm.name === 'yarn') {
    await run(pm.cmd, [bin, ...args], { env, cwd: dir });
    return;
  }
  await run(pm.cmd, ['exec', bin, ...args], { env, cwd: dir });
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
      <string>${nodePath}</string>
      <string>${happysEntrypoint}</string>
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
