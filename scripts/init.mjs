import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureCanonicalHomeEnvUpdated, ensureHomeEnvUpdated } from './utils/config.mjs';

function expandHome(p) {
  return p.replace(/^~(?=\/)/, homedir());
}

function getCliRootDir() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function parseArgValue(argv, key) {
  const long = `--${key}=`;
  const hit = argv.find((a) => a.startsWith(long));
  if (hit) return hit.slice(long.length);
  const idx = argv.indexOf(`--${key}`);
  if (idx >= 0 && argv[idx + 1]) return argv[idx + 1];
  return null;
}

async function writeExecutable(path, contents) {
  await writeFile(path, contents, { mode: 0o755 });
}

function escapeForDoubleQuotes(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function ensurePathInstalled({ homeDir }) {
  const shell = (process.env.SHELL ?? '').toLowerCase();
  const isDarwin = process.platform === 'darwin';

  const zshrc = join(homedir(), '.zshrc');
  const bashrc = join(homedir(), '.bashrc');
  const bashProfile = join(homedir(), '.bash_profile');
  const fishDir = join(homedir(), '.config', 'fish', 'conf.d');
  const fishConf = join(fishDir, 'happy-stacks.fish');

  const markerStart = '# >>> happy-stacks >>>';
  const markerEnd = '# <<< happy-stacks <<<';

  const lineSh = `export PATH="${escapeForDoubleQuotes(join(homeDir, 'bin'))}:$PATH"`;
  const blockSh = `\n${markerStart}\n${lineSh}\n${markerEnd}\n`;

  const lineFish = `set -gx PATH "${escapeForDoubleQuotes(join(homeDir, 'bin'))}" $PATH`;
  const blockFish = `\n${markerStart}\n${lineFish}\n${markerEnd}\n`;

  const writeIfMissing = async (path, block) => {
    let existing = '';
    try {
      existing = await readFile(path, 'utf-8');
    } catch {
      existing = '';
    }
    if (existing.includes(markerStart) || existing.includes(lineSh) || existing.includes(lineFish)) {
      return { updated: false, path };
    }
    await writeFile(path, existing.replace(/\s*$/, '') + block, 'utf-8');
    return { updated: true, path };
  };

  if (shell.includes('fish')) {
    await mkdir(fishDir, { recursive: true });
    return await writeIfMissing(fishConf, blockFish);
  }

  if (shell.includes('bash')) {
    // macOS interactive bash typically sources ~/.bash_profile; linux usually uses ~/.bashrc.
    const target = isDarwin ? bashProfile : bashrc;
    return await writeIfMissing(target, blockSh);
  }

  // Default to zsh on modern macOS; also fine for linux users.
  return await writeIfMissing(zshrc, blockSh);
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const sep = rawArgv.indexOf('--');
  const argv = sep >= 0 ? rawArgv.slice(0, sep) : rawArgv;
  const bootstrapArgsRaw = sep >= 0 ? rawArgv.slice(sep + 1) : [];
  const bootstrapArgs = bootstrapArgsRaw[0] === '--' ? bootstrapArgsRaw.slice(1) : bootstrapArgsRaw;
  if (argv.includes('--help') || argv.includes('-h') || argv[0] === 'help') {
    console.log([
      '[init] usage:',
      '  happys init [--home-dir=/path] [--workspace-dir=/path] [--runtime-dir=/path] [--install-path] [--no-runtime] [--no-bootstrap] [--] [bootstrap args...]',
      '',
      'notes:',
      '  - writes ~/.happy-stacks/.env (stable pointer file)',
      '  - default workspace: ~/.happy-stacks/workspace',
      '  - default runtime: ~/.happy-stacks/runtime (recommended for services/SwiftBar)',
      '  - optional: --install-path adds ~/.happy-stacks/bin to your shell PATH (idempotent)',
      '  - by default, runs `happys bootstrap --interactive` at the end (TTY only)',
    ].join('\n'));
    return;
  }

  const cliRootDir = getCliRootDir();

  const homeDirRaw = parseArgValue(argv, 'home-dir');
  const homeDir = expandHome((homeDirRaw ?? '').trim() || (process.env.HAPPY_STACKS_HOME_DIR ?? '').trim() || join(homedir(), '.happy-stacks'));
  process.env.HAPPY_STACKS_HOME_DIR = homeDir;

  const workspaceDirRaw = parseArgValue(argv, 'workspace-dir');
  const workspaceDir = expandHome((workspaceDirRaw ?? '').trim() || join(homeDir, 'workspace'));
  process.env.HAPPY_STACKS_WORKSPACE_DIR = process.env.HAPPY_STACKS_WORKSPACE_DIR ?? workspaceDir;

  const runtimeDirRaw = parseArgValue(argv, 'runtime-dir');
  const runtimeDir = expandHome((runtimeDirRaw ?? '').trim() || (process.env.HAPPY_STACKS_RUNTIME_DIR ?? '').trim() || join(homeDir, 'runtime'));
  process.env.HAPPY_STACKS_RUNTIME_DIR = process.env.HAPPY_STACKS_RUNTIME_DIR ?? runtimeDir;

  const nodePath = process.execPath;

  await mkdir(homeDir, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(workspaceDir, 'components'), { recursive: true });
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(join(homeDir, 'bin'), { recursive: true });

  const pointerUpdates = [
    { key: 'HAPPY_STACKS_HOME_DIR', value: homeDir },
    { key: 'HAPPY_STACKS_WORKSPACE_DIR', value: workspaceDir },
    { key: 'HAPPY_STACKS_RUNTIME_DIR', value: runtimeDir },
    { key: 'HAPPY_STACKS_NODE', value: nodePath },
  ];

  // Write the "real" home env (used by runtime + scripts), AND a stable pointer at ~/.happy-stacks/.env.
  // The pointer file allows launchd/SwiftBar/minimal shells to discover the actual install location
  // even when no env vars are exported.
  await ensureHomeEnvUpdated({ updates: pointerUpdates });
  await ensureCanonicalHomeEnvUpdated({ updates: pointerUpdates });

  const installRuntime = !argv.includes('--no-runtime');
  if (installRuntime) {
    const pkg = JSON.parse(await readFile(join(cliRootDir, 'package.json'), 'utf-8'));
    const version = String(pkg.version ?? '').trim() || 'latest';
    const spec = version === '0.0.0' ? 'happy-stacks@latest' : `happy-stacks@${version}`;

    console.log(`[init] installing runtime into ${runtimeDir} (${spec})...`);
    let res = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--prefix', runtimeDir, spec], { stdio: 'inherit' });
    if (res.status !== 0) {
      // Pre-publish developer experience: if the package isn't on npm yet (E404),
      // fall back to installing the local checkout into the runtime prefix.
      console.log(`[init] runtime install failed; attempting local install from ${cliRootDir}...`);
      res = spawnSync('npm', ['install', '--no-audit', '--no-fund', '--silent', '--prefix', runtimeDir, cliRootDir], { stdio: 'inherit' });
      if (res.status !== 0) {
        process.exit(res.status ?? 1);
      }
    }
  }

  const happysShimPath = join(homeDir, 'bin', 'happys');
  const happyShimPath = join(homeDir, 'bin', 'happy');
  const shim = [
    '#!/bin/bash',
    'set -euo pipefail',
    'CANONICAL_ENV="$HOME/.happy-stacks/.env"',
    '',
    '# Best-effort: if env vars are not exported (common under launchd/SwiftBar),',
    '# read the stable pointer file at ~/.happy-stacks/.env to discover the real dirs.',
    'if [[ -f "$CANONICAL_ENV" ]]; then',
    '  if [[ -z "${HAPPY_STACKS_HOME_DIR:-}" ]]; then',
    '    HAPPY_STACKS_HOME_DIR="$(grep -E \'^HAPPY_STACKS_HOME_DIR=\' "$CANONICAL_ENV" | head -n 1 | sed \'s/^HAPPY_STACKS_HOME_DIR=//\')" || true',
    '    export HAPPY_STACKS_HOME_DIR',
    '  fi',
    '  if [[ -z "${HAPPY_STACKS_WORKSPACE_DIR:-}" ]]; then',
    '    HAPPY_STACKS_WORKSPACE_DIR="$(grep -E \'^HAPPY_STACKS_WORKSPACE_DIR=\' "$CANONICAL_ENV" | head -n 1 | sed \'s/^HAPPY_STACKS_WORKSPACE_DIR=//\')" || true',
    '    export HAPPY_STACKS_WORKSPACE_DIR',
    '  fi',
    '  if [[ -z "${HAPPY_STACKS_RUNTIME_DIR:-}" ]]; then',
    '    HAPPY_STACKS_RUNTIME_DIR="$(grep -E \'^HAPPY_STACKS_RUNTIME_DIR=\' "$CANONICAL_ENV" | head -n 1 | sed \'s/^HAPPY_STACKS_RUNTIME_DIR=//\')" || true',
    '    export HAPPY_STACKS_RUNTIME_DIR',
    '  fi',
    '  if [[ -z "${HAPPY_STACKS_NODE:-}" ]]; then',
    '    HAPPY_STACKS_NODE="$(grep -E \'^HAPPY_STACKS_NODE=\' "$CANONICAL_ENV" | head -n 1 | sed \'s/^HAPPY_STACKS_NODE=//\')" || true',
    '    export HAPPY_STACKS_NODE',
    '  fi',
    'fi',
    '',
    'HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"',
    'ENV_FILE="$HOME_DIR/.env"',
    'NODE_BIN="${HAPPY_STACKS_NODE:-}"',
    'if [[ -z "$NODE_BIN" && -f "$ENV_FILE" ]]; then',
    '  NODE_BIN="$(grep -E \'^HAPPY_STACKS_NODE=\' "$ENV_FILE" | head -n 1 | sed \'s/^HAPPY_STACKS_NODE=//\')"',
    'fi',
    'if [[ -z "$NODE_BIN" ]]; then',
    '  NODE_BIN="$(command -v node 2>/dev/null || true)"',
    'fi',
    'RUNTIME_DIR="${HAPPY_STACKS_RUNTIME_DIR:-$HOME_DIR/runtime}"',
    'ENTRY="$RUNTIME_DIR/node_modules/happy-stacks/bin/happys.mjs"',
    'if [[ -f "$ENTRY" ]]; then',
    '  exec "$NODE_BIN" "$ENTRY" "$@"',
    'fi',
    'exec happys "$@"',
    '',
  ].join('\n');

  await writeExecutable(happysShimPath, shim);
  await writeExecutable(happyShimPath, `#!/bin/bash\nset -euo pipefail\nexec \"${happysShimPath}\" happy \"$@\"\n`);

  if (argv.includes('--install-path')) {
    const res = await ensurePathInstalled({ homeDir });
    if (res.updated) {
      console.log(`[init] added ${homeDir}/bin to PATH via ${res.path}`);
    } else {
      console.log(`[init] PATH already configured in ${res.path}`);
    }
  }

  console.log('[init] complete');
  console.log(`[init] home:      ${homeDir}`);
  console.log(`[init] workspace:  ${workspaceDir}`);
  console.log(`[init] shims:     ${homeDir}/bin`);
  console.log('');

  if (!argv.includes('--install-path')) {
    console.log('[init] note: to use `happys` / `happy` from any terminal, add shims to PATH:');
    console.log(`  export PATH="${homeDir}/bin:$PATH"`);
    console.log('  (or re-run: happys init --install-path)');
    console.log('');
  } else {
    console.log('[init] note: restart your terminal (or source your shell config) to pick up PATH changes.');
    console.log('');
  }

  const wantBootstrap = !argv.includes('--no-bootstrap');
  const isTty = process.stdout.isTTY && process.stdin.isTTY;
  const shouldBootstrap = wantBootstrap;

  if (shouldBootstrap) {
    const nextArgs = [...bootstrapArgs];
    if (isTty && !nextArgs.includes('--interactive') && !nextArgs.includes('-i')) {
      nextArgs.unshift('--interactive');
    }
    console.log('[init] running bootstrap...');
    const res = spawnSync(process.execPath, [join(cliRootDir, 'scripts', 'install.mjs'), ...nextArgs], {
      stdio: 'inherit',
      env: process.env,
      cwd: cliRootDir,
    });
    if (res.status !== 0) {
      process.exit(res.status ?? 1);
    }
    return;
  }

  console.log('[init] next steps:');
  console.log(`  export PATH=\"${homeDir}/bin:$PATH\"`);
  console.log('  happys bootstrap --interactive');
}

main().catch((err) => {
  console.error('[init] failed:', err);
  process.exit(1);
});
