import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { runCapture } from './utils/proc/proc.mjs';
import { resolveCommandPath } from './utils/proc/commands.mjs';
import { getComponentDir, getDefaultAutostartPaths, getHappyStacksHomeDir, getRootDir, getWorkspaceDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { killPortListeners } from './utils/net/ports.mjs';
import { getServerComponentName } from './utils/server/server.mjs';
import { fetchHappyHealth } from './utils/server/server.mjs';
import { daemonStatusSummary } from './daemon.mjs';
import { tailscaleServeStatus } from './tailscale.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { assertServerComponentDirMatches } from './utils/server/validate.mjs';
import { resolveServerPortFromEnv, resolveServerUrls } from './utils/server/urls.mjs';
import { resolveStackContext } from './utils/stack/context.mjs';
import { readJsonIfExists } from './utils/fs/json.mjs';
import { readPackageJsonVersion } from './utils/fs/package_json.mjs';

/**
 * Doctor script for common happy-stacks failure modes.
 *
 * Checks:
 * - server port in use / server health
 * - UI build directory existence
 * - daemon status
 * - tailscale serve status (if available)
 * - launch agent status (macOS)
 *
 * Flags:
 * - --fix : best-effort fixes (kill server port listener)
 */

async function fetchHealth(url) {
  const tryGet = async (path) => {
  try {
      const res = await fetch(`${url}${path}`, { method: 'GET' });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.trim() };
    } catch {
    return { ok: false, status: null, body: null };
  }
  };

  // Prefer /health when available, but fall back to / (matches waitForServerReady).
  const healthRaw = await fetchHappyHealth(url);
  const health = { ok: healthRaw.ok, status: healthRaw.status, body: healthRaw.text ? healthRaw.text.trim() : null };
  if (health.ok) {
    return health;
  }
  const root = await tryGet('/');
  if (root.ok && root.body?.includes('Welcome to Happy Server!')) {
    return root;
  }
  return health.ok ? health : root;
}

async function resolveSwiftbarPluginsDir() {
  if (process.platform !== 'darwin') {
    return null;
  }
  try {
    const dir = (await runCapture('bash', [
      '-lc',
      'DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; if [[ -n "$DIR" && -d "$DIR" ]]; then echo "$DIR"; exit 0; fi; D="$HOME/Library/Application Support/SwiftBar/Plugins"; if [[ -d "$D" ]]; then echo "$D"; exit 0; fi; echo ""',
    ])).trim();
    return dir || null;
  } catch {
    return null;
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const fix = flags.has('--fix');
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { flags: ['--fix', '--server=happy-server|happy-server-light'], json: true },
      text: [
        '[doctor] usage:',
        '  happys doctor [--fix] [--json]',
        '  node scripts/doctor.mjs [--fix] [--server=happy-server|happy-server-light] [--json]',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const homeDir = getHappyStacksHomeDir();
  const runtimeDir = getRuntimeDir();
  const workspaceDir = getWorkspaceDir(rootDir);
  const updateCachePath = join(homeDir, 'cache', 'update.json');
  const runtimePkgJson = join(runtimeDir, 'node_modules', 'happy-stacks', 'package.json');
  const runtimeVersion = await readPackageJsonVersion(runtimePkgJson);
  const updateCache = await readJsonIfExists(updateCachePath, { defaultValue: null });

  const autostart = getDefaultAutostartPaths();
  const stackCtx = resolveStackContext({ env: process.env, autostart });
  const stackMode = stackCtx.stackMode;

  const serverPort = resolveServerPortFromEnv({ defaultPort: 3005 });
  const resolvedUrls = await resolveServerUrls({ serverPort, allowEnable: false });
  const internalServerUrl = resolvedUrls.internalServerUrl;
  const publicServerUrl = resolvedUrls.publicServerUrl;

  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(autostart.baseDir, 'cli');

  const serveUi = (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(autostart.baseDir, 'ui');

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for doctor (pick one: happy-server-light or happy-server)`);
  }

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir });

  const report = {
    paths: {
      rootDir,
      homeDir,
      runtimeDir,
      workspaceDir,
      updateCachePath,
    },
    runtime: {
      installed: Boolean(runtimeVersion),
      version: runtimeVersion,
      packageJson: runtimePkgJson,
      updateCache,
    },
    env: {
      homeEnv: join(homeDir, '.env'),
      homeLocal: join(homeDir, 'env.local'),
      mainStackEnv: resolveStackEnvPath('main').envPath,
      activeEnv: process.env.HAPPY_STACKS_ENV_FILE?.trim() || process.env.HAPPY_LOCAL_ENV_FILE?.trim() || null,
    },
    internalServerUrl,
    publicServerUrl,
    serverComponentName,
    uiBuildDir,
    cliHomeDir,
    checks: {},
  };
  if (!json) {
    console.log('🩺 happy-stacks doctor\n');
    console.log(`- internal: ${internalServerUrl}`);
    console.log(`- public:   ${publicServerUrl}`);
    console.log(`- server:   ${serverComponentName}`);
    console.log(`- uiBuild:  ${uiBuildDir}`);
    console.log(`- cliHome:  ${cliHomeDir}`);
    console.log(`- home:     ${homeDir}`);
    console.log(`- runtime:  ${runtimeVersion ? `${runtimeDir} (${runtimeVersion})` : `${runtimeDir} (not installed)`}`);
    console.log(`- workspace:${workspaceDir}`);
    console.log('');
  }

  if (!(await pathExists(serverDir))) {
    report.checks.serverDir = { ok: false, missing: serverDir };
    if (!json) console.log(`❌ missing component: ${serverDir}`);
  }
  if (!(await pathExists(cliDir))) {
    report.checks.cliDir = { ok: false, missing: cliDir };
    if (!json) console.log(`❌ missing component: ${cliDir}`);
  }

  // Server health / port conflicts
  const health = await fetchHealth(internalServerUrl);
  if (health.ok) {
    report.checks.serverHealth = { ok: true, status: health.status, body: health.body };
    if (!json) console.log(`✅ server health: ${health.status} ${health.body}`);
  } else {
    report.checks.serverHealth = { ok: false };
    if (!json) console.log(`❌ server health: unreachable (${internalServerUrl})`);
    if (fix) {
      if (stackMode) {
        if (!json) {
          console.log(`↪ fix skipped: refusing to kill unknown port listeners in stack mode.`);
          console.log(`↪ Fix: use stack-safe controls instead: happys stack stop ${process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? 'main'} --aggressive`);
        }
      } else {
        if (!json) console.log(`↪ attempting fix: freeing tcp:${serverPort}`);
        await killPortListeners(serverPort, { label: 'doctor' });
      }
    }
  }

  // UI build dir check
  if (serveUi) {
    if (await pathExists(uiBuildDir)) {
      report.checks.uiBuildDir = { ok: true, path: uiBuildDir };
      if (!json) console.log('✅ ui build dir present');
    } else {
      report.checks.uiBuildDir = { ok: false, missing: uiBuildDir };
      if (!json) console.log(`❌ ui build dir missing (${uiBuildDir}) → run: happys build`);
    }
  } else {
    report.checks.uiServing = { ok: false, reason: 'disabled (HAPPY_LOCAL_SERVE_UI=0)' };
    if (!json) console.log('ℹ️ ui serving disabled (HAPPY_LOCAL_SERVE_UI=0)');
  }

  // Daemon status
  try {
    const out = await daemonStatusSummary({
      cliBin,
      cliHomeDir,
      internalServerUrl,
      publicServerUrl,
    });
    const line = out.split('\n').find((l) => l.includes('Daemon is running'))?.trim();
    report.checks.daemon = { ok: true, line: line || null };
    if (!json) console.log(`✅ daemon: ${line ? line : 'status ok'}`);
  } catch (e) {
    const accessKeyPath = join(cliHomeDir, 'access.key');
    const hasAccessKey = existsSync(accessKeyPath);
    report.checks.daemon = { ok: false, hasAccessKey, accessKeyPath };
    if (!json) {
      console.log('❌ daemon: not running / status failed');
      if (!hasAccessKey) {
        const stackName = (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
        console.log(`  ↪ likely cause: missing credentials at ${accessKeyPath}`);
        console.log(`  ↪ fix: authenticate for this stack:`);
        console.log(`     ${stackName === 'main' ? 'happys auth login' : `happys stack auth ${stackName} login`}`);
      }
    }
  }

  // Tailscale Serve status (best-effort)
  try {
    const status = await tailscaleServeStatus();
    const httpsLine = status.split('\n').find((l) => l.toLowerCase().includes('https://'))?.trim();
    report.checks.tailscaleServe = { ok: true, httpsLine: httpsLine || null };
    if (!json) console.log(`✅ tailscale serve: ${httpsLine ? httpsLine : 'configured'}`);
  } catch {
    report.checks.tailscaleServe = { ok: false };
    if (!json) console.log('ℹ️ tailscale serve: unavailable (tailscale not installed / not running)');
  }

  // macOS LaunchAgent status
  if (process.platform === 'darwin') {
    try {
      const list = await runCapture('launchctl', ['list']);
      const { primaryLabel, legacyLabel } = getDefaultAutostartPaths();
      const primaryLine = list.split('\n').find((l) => l.includes(primaryLabel))?.trim() || null;
      const legacyLine = list.split('\n').find((l) => l.includes(legacyLabel))?.trim() || null;
      const line = primaryLine || legacyLine;
      report.checks.launchd = { ok: true, line: line || null };
      if (!json) console.log(`✅ launchd: ${line ? line : 'not loaded'}`);
    } catch {
      report.checks.launchd = { ok: false };
      if (!json) console.log('ℹ️ launchd: unable to query');
    }
  }

  // SwiftBar plugin status (macOS)
  if (process.platform === 'darwin') {
    const pluginsDir = await resolveSwiftbarPluginsDir();
    const pluginInstalled =
      pluginsDir && existsSync(pluginsDir)
        ? Boolean((await runCapture('bash', ['-lc', `ls -1 "${pluginsDir}"/happy-stacks.*.sh 2>/dev/null | head -n 1 || true`])).trim())
        : false;
    report.checks.swiftbar = { ok: true, pluginsDir, pluginInstalled };
    if (!json) {
      console.log(`✅ swiftbar: ${pluginInstalled ? 'plugin installed' : 'not installed'}`);
    }
  }

  // happy wrapper
  try {
    const happyPath = await resolveCommandPath('happy');
    if (happyPath) {
      report.checks.happyOnPath = { ok: true, path: happyPath };
      if (!json) console.log(`✅ happy on PATH: ${happyPath}`);
    }
  } catch {
    report.checks.happyOnPath = { ok: false };
    if (!json) console.log(`ℹ️ happy on PATH: not found (run: happys init --install-path, or add ${join(getHappyStacksHomeDir(), 'bin')} to PATH)`);
  }

  // happys on PATH
  try {
    const happysPath = await resolveCommandPath('happys');
    if (happysPath) {
      report.checks.happysOnPath = { ok: true, path: happysPath };
      if (!json) console.log(`✅ happys on PATH: ${happysPath}`);
    }
  } catch {
    report.checks.happysOnPath = { ok: false };
    if (!json) console.log(`ℹ️ happys on PATH: not found (run: happys init --install-path, or add ${join(getHappyStacksHomeDir(), 'bin')} to PATH)`);
  }

  if (!json) {
    if (!runtimeVersion) {
      console.log('');
      console.log('Tips:');
      console.log('- Install a stable runtime (recommended for SwiftBar/services): happys self update');
    }
    if (!report.checks.happysOnPath?.ok) {
      console.log(`- Add shims to PATH: export PATH="${join(getHappyStacksHomeDir(), 'bin')}:$PATH" (or: happys init --install-path)`);
    }
    console.log('');
  }

  if (json) {
    printResult({ json, data: report });
  }
}

main().catch((err) => {
  console.error('[local] doctor failed:', err);
  process.exit(1);
});
