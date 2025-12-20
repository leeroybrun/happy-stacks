import { spawn } from 'node:child_process';
import { access, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

// happy-local itself is typically run via pnpm, but we intentionally keep the embedded
// component repos upstream-compatible (they use Yarn), so we run Yarn inside components.
// (This avoids pnpm picking different dependency versions and breaking builds.)

function parseDotenv(contents) {
  const out = new Map();
  for (const rawLine of contents.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) {
      continue;
    }
    const idx = line.indexOf('=');
    if (idx <= 0) {
      continue;
    }
    const key = line.slice(0, idx).trim();
    let value = line.slice(idx + 1).trim();
    if (!key) {
      continue;
    }
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

async function loadEnvFile(path) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      if (process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}

// Load happy-local env (optional). This is intentionally lightweight and does not require extra deps.
const __scriptsDir = dirname(fileURLToPath(import.meta.url));
const __rootDir = dirname(__scriptsDir);
await loadEnvFile(process.env.HAPPY_LOCAL_ENV_FILE?.trim() ? process.env.HAPPY_LOCAL_ENV_FILE.trim() : join(__rootDir, '.env'));
await loadEnvFile(join(__rootDir, 'env.local'));

/**
 * Shared helpers for happy-local scripts.
 *
 * Responsibilities:
 * - Resolve component directories (embedded components/ layout only)
 * - Run subprocesses with consistent logging
 * - Perform lightweight install/build/link steps
 * - Optionally configure macOS autostart via LaunchAgent
 */

export function getRootDir(importMetaUrl) {
  return dirname(dirname(fileURLToPath(importMetaUrl)));
}

export function spawnProc(label, cmd, args, env, options = {}) {
  const child = spawn(cmd, args, {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
    // Create a new process group so we can kill the whole tree reliably on shutdown.
    detached: process.platform !== 'win32',
    ...options,
  });

  child.stdout?.on('data', (d) => process.stdout.write(`[${label}] ${d.toString()}`));
  child.stderr?.on('data', (d) => process.stderr.write(`[${label}] ${d.toString()}`));
  child.on('exit', (code, sig) => {
    if (code !== 0) {
      process.stderr.write(`[${label}] exited (code=${code}, sig=${sig})\n`);
    }
  });

  return child;
}

export function killProcessTree(child, signal) {
  if (!child || child.exitCode != null || !child.pid) {
    return;
  }

  try {
    if (process.platform !== 'win32') {
      // Kill the process group.
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // ignore
  }
}

export async function run(cmd, args, options = {}) {
  await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => (code === 0 ? resolvePromise() : rejectPromise(new Error(`${cmd} failed (code=${code})`))));
  });
}

export async function runCapture(cmd, args, options = {}) {
  return await new Promise((resolvePromise, rejectPromise) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false, ...options });
    let out = '';
    let err = '';
    proc.stdout?.on('data', (d) => (out += d.toString()));
    proc.stderr?.on('data', (d) => (err += d.toString()));
    proc.on('error', rejectPromise);
    proc.on('exit', (code) => {
      if (code === 0) {
        resolvePromise(out);
      } else {
        rejectPromise(new Error(`${cmd} ${args.join(' ')} failed (code=${code}): ${err.trim()}`));
      }
    });
  });
}

/**
 * Best-effort: kill any processes LISTENing on a TCP port.
 * Used to avoid EADDRINUSE when a previous run left a server behind.
 */
export async function killPortListeners(port, { label = 'port' } = {}) {
  if (!Number.isFinite(port) || port <= 0) {
    return [];
  }
  if (process.platform === 'win32') {
    return [];
  }

  let raw = '';
  try {
    // `lsof` exits non-zero if no matches; normalize to empty output.
    raw = await runCapture('sh', [
      '-lc',
      `command -v lsof >/dev/null 2>&1 && lsof -nP -iTCP:${port} -sTCP:LISTEN -t 2>/dev/null || true`,
    ]);
  } catch {
    return [];
  }

  const pids = Array.from(
    new Set(
      raw
        .split(/\s+/g)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => Number(s))
        .filter((n) => Number.isInteger(n) && n > 1)
    )
  );

  if (!pids.length) {
    return [];
  }

  console.log(`[local] ${label}: freeing tcp:${port} (killing pids: ${pids.join(', ')})`);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // ignore
    }
  }

  await delay(500);

  for (const pid of pids) {
    try {
      process.kill(pid, 0);
      process.kill(pid, 'SIGKILL');
    } catch {
      // not running / no permission
    }
  }

  return pids;
}

async function commandExists(cmd) {
  try {
    await runCapture(cmd, ['--version']);
    return true;
  } catch {
    return false;
  }
}

export async function requirePnpm() {
  if (await commandExists('pnpm')) {
    return;
  }
  throw new Error('[local] pnpm is required to run happy-local. Install it via: `corepack enable && corepack prepare pnpm@latest --activate`');
}

async function getComponentPm(dir) {
  const yarnLock = join(dir, 'yarn.lock');
  if (await pathExists(yarnLock)) {
    if (!(await commandExists('yarn'))) {
      throw new Error(`[local] yarn is required for component at ${dir} (yarn.lock present). Install it via Corepack: \`corepack enable\``);
    }
    return { name: 'yarn', cmd: 'yarn' };
  }

  // Default fallback if no yarn.lock: use pnpm.
  await requirePnpm();
  return { name: 'pnpm', cmd: 'pnpm' };
}

export async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function parseArgs(argv) {
  const flags = new Set();
  const kv = new Map();
  for (const raw of argv) {
    if (!raw.startsWith('--')) {
      continue;
    }
    const [k, v] = raw.split('=', 2);
    if (v === undefined) {
      flags.add(k);
    } else {
      kv.set(k, v);
    }
  }
  return { flags, kv };
}

export function getComponentsDir(rootDir) {
  return join(rootDir, 'components');
}

export function getComponentDir(rootDir, name) {
  return join(getComponentsDir(rootDir), name);
}

export async function requireDir(label, dir) {
  if (await pathExists(dir)) {
    return;
  }
  throw new Error(
    `[local] missing ${label} at ${dir}\n` +
      `Run: pnpm bootstrap -- --clone (if you configured repo URLs), or place the repo under components/`
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
    // If this repo is Yarn-managed (yarn.lock present) but node_modules was created by pnpm,
    // reinstall with Yarn to restore upstream-locked dependency versions.
    if (pm.name === 'yarn' && (await pathExists(pnpmModulesMeta))) {
      console.log(`[local] converting ${label} dependencies back to yarn (reinstalling node_modules)...`);
      await rm(nodeModules, { recursive: true, force: true });
      await run(pm.cmd, ['--cwd', dir, 'install']);
    }
    return;
  }

  console.log(`[local] installing ${label} dependencies (first run)...`);
  if (pm.name === 'yarn') {
    await run(pm.cmd, ['--cwd', dir, 'install']);
  } else {
    await run(pm.cmd, ['-C', dir, 'install']);
  }
}

export async function ensureCliBuilt(cliDir, { buildCli }) {
  await ensureDepsInstalled(cliDir, 'happy-cli');
  if (!buildCli) {
    return;
  }
  console.log('[local] building happy-cli...');
  const pm = await getComponentPm(cliDir);
  if (pm.name === 'yarn') {
    await run(pm.cmd, ['--cwd', cliDir, 'build']);
  } else {
    await run(pm.cmd, ['-C', cliDir, 'build']);
  }
}

function getPathEntries() {
  const raw = process.env.PATH ?? '';
  const delimiter = process.platform === 'win32' ? ';' : ':';
  return raw.split(delimiter).filter(Boolean);
}

async function findHappyOnPath() {
  const candidates = process.platform === 'win32'
    ? ['happy.cmd', 'happy.exe', 'happy.bat', 'happy']
    : ['happy'];

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
      console.log(`[local] 'happy' was linked but is still not on your PATH.`);
      console.log(`[local] Add this directory to PATH: ${npmBin}`);
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

  const wrapperDir = join(rootDir, 'packages', 'happy-cli-local');
  if (!(await pathExists(wrapperDir))) {
    throw new Error(`[local] missing happy-cli-local wrapper at ${wrapperDir}`);
  }

  const happyBin = await findHappyOnPath();
  if (happyBin) {
    try {
      const resolved = await realpath(happyBin);
      if (isPathInside(resolved, wrapperDir)) {
        return;
      }
    } catch {
      // ignore
    }
  }

  console.log('[local] linking happy-cli-local into PATH (npm link)...');
  // `happy` often already exists from a previous global install (e.g. happy-coder).
  // We intentionally overwrite it so the wrapper becomes the default `happy`.
  await run('npm', ['link', '--force'], { cwd: wrapperDir });

  const happyBinAfter = await findHappyOnPath();
  if (happyBinAfter) {
    try {
      const resolved = await realpath(happyBinAfter);
      if (isPathInside(resolved, wrapperDir)) {
        return;
      }
    } catch {
      // ignore
    }
    // happy exists, but may still be the wrong one
    console.log(`[local] warning: 'happy' is on PATH but does not point to happy-cli-local (${happyBinAfter})`);
    return;
  }

  // If npm global bin isn't on PATH, users won't see the command.
  try {
    const npmBin = (await runCapture('npm', ['bin', '-g'])).trim();
    if (npmBin) {
      console.log(`[local] 'happy' was linked but is still not on your PATH.`);
      console.log(`[local] Add this directory to PATH: ${npmBin}`);
      console.log(`[local] Example (zsh): echo 'export PATH=\"${npmBin}:$PATH\"' >> ~/.zshrc && source ~/.zshrc`);
    }
  } catch {
    // ignore
  }
}

export async function pmSpawnScript({ label, dir, script, env, options = {} }) {
  const pm = await getComponentPm(dir);
  if (pm.name === 'yarn') {
    return spawnProc(label, pm.cmd, ['-s', '--cwd', dir, script], env, options);
  }
  return spawnProc(label, pm.cmd, ['-C', dir, '--silent', script], env, options);
}

export async function pmExecBin({ dir, bin, args, env }) {
  const pm = await getComponentPm(dir);
  if (pm.name === 'yarn') {
    await run(pm.cmd, ['--cwd', dir, bin, ...args], { env });
    return;
  }
  await run(pm.cmd, ['-C', dir, 'exec', bin, ...args], { env });
}

export async function waitForServerReady(url) {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      const text = await res.text();
      if (res.ok && text.includes('Welcome to Happy Server!')) {
        return;
      }
    } catch {
      // ignore
    }
    await delay(300);
  }
  throw new Error(`Timed out waiting for server at ${url}`);
}

export function getDefaultAutostartPaths() {
  const baseDir = join(homedir(), '.happy', 'local');
  const logsDir = join(baseDir, 'logs');
  const stdoutPath = join(logsDir, 'happy-local.out.log');
  const stderrPath = join(logsDir, 'happy-local.err.log');
  const plistPath = join(homedir(), 'Library', 'LaunchAgents', 'com.happy.local.plist');
  return { baseDir, logsDir, stdoutPath, stderrPath, plistPath };
}

export async function ensureMacAutostartEnabled({ rootDir, label = 'com.happy.local', env = {} }) {
  if (process.platform !== 'darwin') {
    throw new Error('[local] autostart is currently only implemented for macOS (LaunchAgents).');
  }

  const { logsDir, stdoutPath, stderrPath, plistPath } = getDefaultAutostartPaths();
  await mkdir(logsDir, { recursive: true });

  const nodePath = process.env.HAPPY_LOCAL_NODE?.trim() ? process.env.HAPPY_LOCAL_NODE.trim() : process.execPath;
  const runScript = join(rootDir, 'scripts', 'run.mjs');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${nodePath}</string>
      <string>${runScript}</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${rootDir}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${stdoutPath}</string>
    <key>StandardErrorPath</key>
    <string>${stderrPath}</string>
    <key>EnvironmentVariables</key>
    <dict>
${Object.entries(env)
  .map(([k, v]) => `      <key>${k}</key>\n      <string>${String(v)}</string>`)
  .join('\n')}
    </dict>
  </dict>
</plist>
`;

  await mkdir(dirname(plistPath), { recursive: true });
  await writeFile(plistPath, plist, 'utf-8');

  // Best-effort (works on most macOS setups). If it fails, the plist still exists and can be loaded manually.
  try {
    await run('launchctl', ['unload', '-w', plistPath]);
  } catch {
    // ignore
  }
  await run('launchctl', ['load', '-w', plistPath]);
}

export async function ensureMacAutostartDisabled({ label = 'com.happy.local' }) {
  if (process.platform !== 'darwin') {
    return;
  }
  const { plistPath } = getDefaultAutostartPaths();
  try {
    await run('launchctl', ['unload', '-w', plistPath]);
  } catch {
    // ignore
  }
  // Don't delete the plist automatically; it can be useful for inspection.
  console.log(`[local] autostart disabled (${label})`);
}


