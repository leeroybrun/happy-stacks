import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ensureCanonicalHomeEnvUpdated, ensureHomeEnvUpdated } from './utils/config.mjs';
import { parseDotenv } from './utils/dotenv.mjs';

function expandHome(p) {
  return p.replace(/^~(?=\/)/, homedir());
}

async function readJsonIfExists(path) {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
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

function firstNonEmpty(...values) {
  for (const v of values) {
    const s = (v ?? '').trim();
    if (s) return s;
  }
  return '';
}

async function loadEnvFile(path, { override = false, overridePrefix = null } = {}) {
  try {
    const contents = await readFile(path, 'utf-8');
    const parsed = parseDotenv(contents);
    for (const [k, v] of parsed.entries()) {
      const allowOverride = override && (!overridePrefix || k.startsWith(overridePrefix));
      if (allowOverride || process.env[k] == null || process.env[k] === '') {
        process.env[k] = v;
      }
    }
  } catch {
    // ignore missing/invalid env file
  }
}

function isWorkspaceBootstrapped(workspaceDir) {
  // Heuristic: if the expected component repos exist in the workspace, we consider bootstrap "already done"
  // and avoid re-running the interactive bootstrap wizard from `happys init`.
  //
  // Users can always re-run bootstrap explicitly:
  //   happys bootstrap --interactive
  try {
    const componentsDir = join(workspaceDir, 'components');
    const ui = join(componentsDir, 'happy', 'package.json');
    const cli = join(componentsDir, 'happy-cli', 'package.json');
    const serverLight = join(componentsDir, 'happy-server-light', 'package.json');
    const serverFull = join(componentsDir, 'happy-server', 'package.json');
    return existsSync(ui) && existsSync(cli) && (existsSync(serverLight) || existsSync(serverFull));
  } catch {
    return false;
  }
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
      '  happys init [--home-dir=/path] [--workspace-dir=/path] [--runtime-dir=/path] [--storage-dir=/path] [--cli-root-dir=/path] [--tailscale-bin=/path] [--tailscale-cmd-timeout-ms=MS] [--tailscale-enable-timeout-ms=MS] [--tailscale-enable-timeout-ms-auto=MS] [--tailscale-reset-timeout-ms=MS] [--install-path] [--no-runtime] [--force-runtime] [--no-bootstrap] [--] [bootstrap args...]',
      '',
      'notes:',
      '  - writes ~/.happy-stacks/.env (stable pointer file)',
      '  - default workspace: ~/.happy-stacks/workspace',
      '  - default runtime: ~/.happy-stacks/runtime (recommended for services/SwiftBar)',
      '  - runtime install is skipped if the same version is already installed (use --force-runtime to reinstall)',
      '  - set HAPPY_STACKS_INIT_NO_RUNTIME=1 to persist skipping runtime installs on this machine',
      '  - optional: --install-path adds ~/.happy-stacks/bin to your shell PATH (idempotent)',
      '  - by default, runs `happys bootstrap --interactive` at the end (TTY only) IF components are not already present',
    ].join('\n'));
    return;
  }

  const cliRootDir = getCliRootDir();

  // Important: `happys init` must be idempotent and must not "forget" custom dirs from a prior install.
  //
  // Other scripts load this pointer via `scripts/utils/env.mjs`, but `init.mjs` is often run before
  // anything else (or directly from a repo checkout). So we load it here too.
  const canonicalEnvPath = join(homedir(), '.happy-stacks', '.env');
  if (existsSync(canonicalEnvPath)) {
    await loadEnvFile(canonicalEnvPath, { override: false });
    await loadEnvFile(canonicalEnvPath, { override: true, overridePrefix: 'HAPPY_STACKS_' });
    await loadEnvFile(canonicalEnvPath, { override: true, overridePrefix: 'HAPPY_LOCAL_' });
  }

  const homeDirRaw = parseArgValue(argv, 'home-dir');
  const homeDir = expandHome(firstNonEmpty(
    homeDirRaw,
    process.env.HAPPY_STACKS_HOME_DIR,
    process.env.HAPPY_LOCAL_HOME_DIR,
    join(homedir(), '.happy-stacks'),
  ));
  process.env.HAPPY_STACKS_HOME_DIR = homeDir;
  process.env.HAPPY_LOCAL_HOME_DIR = process.env.HAPPY_LOCAL_HOME_DIR ?? homeDir;

  const workspaceDirRaw = parseArgValue(argv, 'workspace-dir');
  const workspaceDir = expandHome(firstNonEmpty(
    workspaceDirRaw,
    process.env.HAPPY_STACKS_WORKSPACE_DIR,
    process.env.HAPPY_LOCAL_WORKSPACE_DIR,
    join(homeDir, 'workspace'),
  ));
  process.env.HAPPY_STACKS_WORKSPACE_DIR = workspaceDir;
  process.env.HAPPY_LOCAL_WORKSPACE_DIR = process.env.HAPPY_LOCAL_WORKSPACE_DIR ?? workspaceDir;

  const runtimeDirRaw = parseArgValue(argv, 'runtime-dir');
  const runtimeDir = expandHome(firstNonEmpty(
    runtimeDirRaw,
    process.env.HAPPY_STACKS_RUNTIME_DIR,
    process.env.HAPPY_LOCAL_RUNTIME_DIR,
    join(homeDir, 'runtime'),
  ));
  process.env.HAPPY_STACKS_RUNTIME_DIR = runtimeDir;
  process.env.HAPPY_LOCAL_RUNTIME_DIR = process.env.HAPPY_LOCAL_RUNTIME_DIR ?? runtimeDir;

  const storageDirRaw = parseArgValue(argv, 'storage-dir');
  const storageDirOverride = expandHome((storageDirRaw ?? '').trim());
  if (storageDirOverride) {
    process.env.HAPPY_STACKS_STORAGE_DIR = process.env.HAPPY_STACKS_STORAGE_DIR ?? storageDirOverride;
  }

  const cliRootDirRaw = parseArgValue(argv, 'cli-root-dir');
  const cliRootDirOverride = expandHome((cliRootDirRaw ?? '').trim());
  if (cliRootDirOverride) {
    process.env.HAPPY_STACKS_CLI_ROOT_DIR = process.env.HAPPY_STACKS_CLI_ROOT_DIR ?? cliRootDirOverride;
  }

  const tailscaleBinRaw = parseArgValue(argv, 'tailscale-bin');
  const tailscaleBinOverride = expandHome((tailscaleBinRaw ?? '').trim());
  if (tailscaleBinOverride) {
    process.env.HAPPY_STACKS_TAILSCALE_BIN = process.env.HAPPY_STACKS_TAILSCALE_BIN ?? tailscaleBinOverride;
  }

  const tailscaleCmdTimeoutMsRaw = parseArgValue(argv, 'tailscale-cmd-timeout-ms');
  const tailscaleCmdTimeoutMsOverride = (tailscaleCmdTimeoutMsRaw ?? '').trim();
  if (tailscaleCmdTimeoutMsOverride) {
    process.env.HAPPY_STACKS_TAILSCALE_CMD_TIMEOUT_MS =
      process.env.HAPPY_STACKS_TAILSCALE_CMD_TIMEOUT_MS ?? tailscaleCmdTimeoutMsOverride;
  }

  const tailscaleEnableTimeoutMsRaw = parseArgValue(argv, 'tailscale-enable-timeout-ms');
  const tailscaleEnableTimeoutMsOverride = (tailscaleEnableTimeoutMsRaw ?? '').trim();
  if (tailscaleEnableTimeoutMsOverride) {
    process.env.HAPPY_STACKS_TAILSCALE_ENABLE_TIMEOUT_MS =
      process.env.HAPPY_STACKS_TAILSCALE_ENABLE_TIMEOUT_MS ?? tailscaleEnableTimeoutMsOverride;
  }

  const tailscaleEnableTimeoutMsAutoRaw = parseArgValue(argv, 'tailscale-enable-timeout-ms-auto');
  const tailscaleEnableTimeoutMsAutoOverride = (tailscaleEnableTimeoutMsAutoRaw ?? '').trim();
  if (tailscaleEnableTimeoutMsAutoOverride) {
    process.env.HAPPY_STACKS_TAILSCALE_ENABLE_TIMEOUT_MS_AUTO =
      process.env.HAPPY_STACKS_TAILSCALE_ENABLE_TIMEOUT_MS_AUTO ?? tailscaleEnableTimeoutMsAutoOverride;
  }

  const tailscaleResetTimeoutMsRaw = parseArgValue(argv, 'tailscale-reset-timeout-ms');
  const tailscaleResetTimeoutMsOverride = (tailscaleResetTimeoutMsRaw ?? '').trim();
  if (tailscaleResetTimeoutMsOverride) {
    process.env.HAPPY_STACKS_TAILSCALE_RESET_TIMEOUT_MS =
      process.env.HAPPY_STACKS_TAILSCALE_RESET_TIMEOUT_MS ?? tailscaleResetTimeoutMsOverride;
  }

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
  if (storageDirOverride) {
    pointerUpdates.push({ key: 'HAPPY_STACKS_STORAGE_DIR', value: storageDirOverride });
  }
  if (cliRootDirOverride) {
    pointerUpdates.push({ key: 'HAPPY_STACKS_CLI_ROOT_DIR', value: cliRootDirOverride });
  }

  // Write the "real" home env (used by runtime + scripts), AND a stable pointer at ~/.happy-stacks/.env.
  // The pointer file allows launchd/SwiftBar/minimal shells to discover the actual install location
  // even when no env vars are exported.
  await ensureHomeEnvUpdated({ updates: pointerUpdates });
  await ensureCanonicalHomeEnvUpdated({ updates: pointerUpdates });

  const initNoRuntimeRaw = (process.env.HAPPY_STACKS_INIT_NO_RUNTIME ?? process.env.HAPPY_LOCAL_INIT_NO_RUNTIME ?? '').trim();
  const initNoRuntime = initNoRuntimeRaw === '1' || initNoRuntimeRaw.toLowerCase() === 'true' || initNoRuntimeRaw.toLowerCase() === 'yes';
  const forceRuntime = argv.includes('--force-runtime');
  const skipRuntime = argv.includes('--no-runtime') || (initNoRuntime && !forceRuntime);
  const installRuntime = !skipRuntime;
  if (installRuntime) {
    const cliPkg = await readJsonIfExists(join(cliRootDir, 'package.json'));
    const cliVersion = String(cliPkg?.version ?? '').trim() || 'latest';
    const spec = cliVersion === '0.0.0' ? 'happy-stacks@latest' : `happy-stacks@${cliVersion}`;

    const runtimePkgPath = join(runtimeDir, 'node_modules', 'happy-stacks', 'package.json');
    const runtimePkg = await readJsonIfExists(runtimePkgPath);
    const runtimeVersion = String(runtimePkg?.version ?? '').trim();
    const sameVersionInstalled = Boolean(cliVersion && cliVersion !== '0.0.0' && runtimeVersion && runtimeVersion === cliVersion);

    if (!forceRuntime && sameVersionInstalled) {
      console.log(`[init] runtime already installed in ${runtimeDir} (happy-stacks@${runtimeVersion})`);
    } else {
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
    '  if [[ -z "${HAPPY_STACKS_CLI_ROOT_DIR:-}" ]]; then',
    '    HAPPY_STACKS_CLI_ROOT_DIR="$(grep -E \'^HAPPY_STACKS_CLI_ROOT_DIR=\' "$CANONICAL_ENV" | head -n 1 | sed \'s/^HAPPY_STACKS_CLI_ROOT_DIR=//\')" || true',
    '    export HAPPY_STACKS_CLI_ROOT_DIR',
    '  fi',
    'fi',
    '',
    'HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"',
    'ENV_FILE="$HOME_DIR/.env"',
    'WORKDIR="${HAPPY_STACKS_WORKSPACE_DIR:-$HOME_DIR/workspace}"',
    'if [[ -d "$WORKDIR" ]]; then',
    '  cd "$WORKDIR"',
    'else',
    '  cd "$HOME"',
    'fi',
    'NODE_BIN="${HAPPY_STACKS_NODE:-}"',
    'if [[ -z "$NODE_BIN" && -f "$ENV_FILE" ]]; then',
    '  NODE_BIN="$(grep -E \'^HAPPY_STACKS_NODE=\' "$ENV_FILE" | head -n 1 | sed \'s/^HAPPY_STACKS_NODE=//\')"',
    'fi',
    'if [[ -z "$NODE_BIN" ]]; then',
    '  NODE_BIN="$(command -v node 2>/dev/null || true)"',
    'fi',
    'CLI_ROOT_DIR="${HAPPY_STACKS_CLI_ROOT_DIR:-}"',
    'if [[ -z "$CLI_ROOT_DIR" && -f "$ENV_FILE" ]]; then',
    '  CLI_ROOT_DIR="$(grep -E \'^HAPPY_STACKS_CLI_ROOT_DIR=\' "$ENV_FILE" | head -n 1 | sed \'s/^HAPPY_STACKS_CLI_ROOT_DIR=//\')" || true',
    'fi',
    'if [[ -n "$CLI_ROOT_DIR" ]]; then',
    '  CLI_ENTRY="$CLI_ROOT_DIR/bin/happys.mjs"',
    '  if [[ -f "$CLI_ENTRY" ]]; then',
    '    exec "$NODE_BIN" "$CLI_ENTRY" "$@"',
    '  fi',
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
  const alreadyBootstrapped = isWorkspaceBootstrapped(workspaceDir);
  const bootstrapExplicit = bootstrapArgs.length > 0;
  const shouldBootstrap = wantBootstrap && (bootstrapExplicit || !alreadyBootstrapped);

  if (shouldBootstrap) {
    const nextArgs = [...bootstrapArgs];
    // Only auto-enable the interactive wizard when init is driving bootstrap with no explicit args.
    // If users pass args after `--`, we assume they know what they want and avoid injecting prompts.
    if (!bootstrapExplicit && isTty && !nextArgs.includes('--interactive') && !nextArgs.includes('-i')) {
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

  if (wantBootstrap && alreadyBootstrapped && !bootstrapExplicit) {
    console.log('[init] bootstrap: already set up; skipping');
    console.log('[init] tip: to re-run setup: happys bootstrap --interactive');
    console.log('');
  }

  console.log('[init] next steps:');
  console.log(`  export PATH=\"${homeDir}/bin:$PATH\"`);
  console.log('  happys bootstrap --interactive');
}

main().catch((err) => {
  console.error('[init] failed:', err);
  process.exit(1);
});

