import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { pathExists } from './utils/fs.mjs';
import { runCapture } from './utils/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths.mjs';
import { killPortListeners } from './utils/ports.mjs';
import { getServerComponentName } from './utils/server.mjs';
import { daemonStatusSummary } from './daemon.mjs';
import { tailscaleServeStatus, resolvePublicServerUrl } from './tailscale.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';

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
  const health = await tryGet('/health');
  if (health.ok) {
    return health;
  }
  const root = await tryGet('/');
  if (root.ok && root.body?.includes('Welcome to Happy Server!')) {
    return root;
  }
  return health.ok ? health : root;
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
  const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT?.trim() ? Number(process.env.HAPPY_LOCAL_SERVER_PORT) : 3005;
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;

  const defaultPublicUrl = `http://localhost:${serverPort}`;
  const envPublicUrl = process.env.HAPPY_LOCAL_SERVER_URL?.trim() ? process.env.HAPPY_LOCAL_SERVER_URL.trim() : '';
  const resolved = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable: false,
  });
  const publicServerUrl = resolved.publicServerUrl;

  const cliHomeDir = process.env.HAPPY_LOCAL_CLI_HOME_DIR?.trim()
    ? process.env.HAPPY_LOCAL_CLI_HOME_DIR.trim().replace(/^~(?=\/)/, homedir())
    : join(getDefaultAutostartPaths().baseDir, 'cli');

  const serveUi = (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(getDefaultAutostartPaths().baseDir, 'ui');

  const serverComponentName = getServerComponentName({ kv });
  if (serverComponentName === 'both') {
    throw new Error(`[local] --server=both is not supported for doctor (pick one: happy-server-light or happy-server)`);
  }

  const serverDir = getComponentDir(rootDir, serverComponentName);
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  const report = {
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
      if (!json) console.log(`↪ attempting fix: freeing tcp:${serverPort}`);
      await killPortListeners(serverPort, { label: 'doctor' });
    }
  }

  // UI build dir check
  if (serveUi) {
    if (serverComponentName !== 'happy-server-light') {
      report.checks.uiServing = { ok: false, reason: `requires happy-server-light (current: ${serverComponentName})` };
      if (!json) console.log(`ℹ️ ui serving requires happy-server-light (current: ${serverComponentName})`);
    }
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
      const line = list.split('\n').find((l) => l.includes('com.happy.stacks'))?.trim();
      report.checks.launchd = { ok: true, line: line || null };
      if (!json) console.log(`✅ launchd: ${line ? line : 'not loaded'}`);
    } catch {
      report.checks.launchd = { ok: false };
      if (!json) console.log('ℹ️ launchd: unable to query');
    }
  }

  // happy wrapper
  try {
    const happyPath = (await runCapture('sh', ['-lc', 'command -v happy'])).trim();
    if (happyPath) {
      report.checks.happyOnPath = { ok: true, path: happyPath };
      if (!json) console.log(`✅ happy on PATH: ${happyPath}`);
    }
  } catch {
    report.checks.happyOnPath = { ok: false };
    if (!json) console.log('ℹ️ happy on PATH: not found (run: happys bootstrap)');
  }

  if (json) {
    printResult({ json, data: report });
  }
}

main().catch((err) => {
  console.error('[local] doctor failed:', err);
  process.exit(1);
});
