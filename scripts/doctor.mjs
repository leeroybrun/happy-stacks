import {
  getComponentDir,
  getDefaultAutostartPaths,
  getRootDir,
  killPortListeners,
  parseArgs,
  pathExists,
  runCapture,
} from './shared.mjs';
import { daemonStatusSummary } from './daemon.mjs';
import { tailscaleServeStatus, resolvePublicServerUrl } from './tailscale.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Doctor script for common happy-local failure modes.
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
  try {
    const res = await fetch(`${url}/health`, { method: 'GET' });
    const body = await res.text();
    return { ok: res.ok, status: res.status, body: body.trim() };
  } catch (e) {
    return { ok: false, status: null, body: null };
  }
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const fix = flags.has('--fix');

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
    : join(homedir(), '.happy', 'local', 'cli');

  const serveUi = (process.env.HAPPY_LOCAL_SERVE_UI ?? '1') !== '0';
  const uiBuildDir = process.env.HAPPY_LOCAL_UI_BUILD_DIR?.trim()
    ? process.env.HAPPY_LOCAL_UI_BUILD_DIR.trim()
    : join(getDefaultAutostartPaths().baseDir, 'ui');

  const serverDir = getComponentDir(rootDir, 'happy-server-light');
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const cliBin = join(cliDir, 'bin', 'happy.mjs');

  console.log('🩺 happy-local doctor\n');
  console.log(`- internal: ${internalServerUrl}`);
  console.log(`- public:   ${publicServerUrl}`);
  console.log(`- uiBuild:  ${uiBuildDir}`);
  console.log(`- cliHome:  ${cliHomeDir}`);
  console.log('');

  if (!(await pathExists(serverDir))) {
    console.log(`❌ missing component: ${serverDir}`);
  }
  if (!(await pathExists(cliDir))) {
    console.log(`❌ missing component: ${cliDir}`);
  }

  // Server health / port conflicts
  const health = await fetchHealth(internalServerUrl);
  if (health.ok) {
    console.log(`✅ server health: ${health.status} ${health.body}`);
  } else {
    console.log(`❌ server health: unreachable (${internalServerUrl})`);
    if (fix) {
      console.log(`↪ attempting fix: freeing tcp:${serverPort}`);
      await killPortListeners(serverPort, { label: 'doctor' });
    }
  }

  // UI build dir check
  if (serveUi) {
    if (await pathExists(uiBuildDir)) {
      console.log('✅ ui build dir present');
    } else {
      console.log(`❌ ui build dir missing (${uiBuildDir}) → run: pnpm build`);
    }
  } else {
    console.log('ℹ️ ui serving disabled (HAPPY_LOCAL_SERVE_UI=0)');
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
    console.log(`✅ daemon: ${line ? line : 'status ok'}`);
  } catch (e) {
    console.log('❌ daemon: not running / status failed');
  }

  // Tailscale Serve status (best-effort)
  try {
    const status = await tailscaleServeStatus();
    const httpsLine = status.split('\n').find((l) => l.toLowerCase().includes('https://'))?.trim();
    console.log(`✅ tailscale serve: ${httpsLine ? httpsLine : 'configured'}`);
  } catch {
    console.log('ℹ️ tailscale serve: unavailable (tailscale not installed / not running)');
  }

  // macOS LaunchAgent status
  if (process.platform === 'darwin') {
    try {
      const list = await runCapture('launchctl', ['list']);
      const line = list.split('\n').find((l) => l.includes('com.happy.local'))?.trim();
      console.log(`✅ launchd: ${line ? line : 'not loaded'}`);
    } catch {
      console.log('ℹ️ launchd: unable to query');
    }
  }

  // happy wrapper
  try {
    const happyPath = (await runCapture('sh', ['-lc', 'command -v happy'])).trim();
    if (happyPath) {
      console.log(`✅ happy on PATH: ${happyPath}`);
    }
  } catch {
    console.log('ℹ️ happy on PATH: not found (run: pnpm bootstrap)');
  }
}

main().catch((err) => {
  console.error('[local] doctor failed:', err);
  process.exit(1);
});

