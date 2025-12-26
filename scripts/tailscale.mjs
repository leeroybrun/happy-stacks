import { parseArgs, run, runCapture } from './shared.mjs';

/**
 * Manage Tailscale Serve for exposing the local UI/API over HTTPS (secure context).
 *
 * This wraps:
 * - `tailscale serve --bg http://127.0.0.1:3005`
 * - `tailscale serve status`
 * - `tailscale serve reset`
 *
 * Commands:
 * - status
 * - enable
 * - disable (alias: reset)
 * - url (print the first https:// URL from status output)
 */

function getInternalServerUrl() {
  const port = process.env.HAPPY_LOCAL_SERVER_PORT?.trim() ? Number(process.env.HAPPY_LOCAL_SERVER_PORT) : 3005;
  return `http://127.0.0.1:${port}`;
}

function getServeConfig(internalServerUrl) {
  const upstream = process.env.HAPPY_LOCAL_TAILSCALE_UPSTREAM?.trim()
    ? process.env.HAPPY_LOCAL_TAILSCALE_UPSTREAM.trim()
    : internalServerUrl;
  const servePath = process.env.HAPPY_LOCAL_TAILSCALE_SERVE_PATH?.trim()
    ? process.env.HAPPY_LOCAL_TAILSCALE_SERVE_PATH.trim()
    : '/';
  return { upstream, servePath };
}

function extractHttpsUrl(serveStatusText) {
  const line = serveStatusText
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.toLowerCase().includes('https://'));
  if (!line) return null;
  const m = line.match(/https:\/\/\S+/i);
  return m ? m[0] : null;
}

async function resolveTailscaleCmd() {
  // Allow explicit override (useful for LaunchAgents where aliases don't exist).
  if (process.env.HAPPY_LOCAL_TAILSCALE_BIN?.trim()) {
    return process.env.HAPPY_LOCAL_TAILSCALE_BIN.trim();
  }

  // Try PATH first.
  try {
    await runCapture('tailscale', ['version']);
    return 'tailscale';
  } catch {
    // fall through
  }

  // Common macOS app install path.
  const appPath = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  try {
    await runCapture(appPath, ['version']);
    return appPath;
  } catch {
    // fall through
  }

  throw new Error(
    `[local] tailscale CLI not found.\n` +
    `- Install Tailscale, or\n` +
    `- Put 'tailscale' on PATH, or\n` +
    `- Set HAPPY_LOCAL_TAILSCALE_BIN="${appPath}"`
  );
}

export async function tailscaleServeHttpsUrl() {
  try {
    const status = await tailscaleServeStatus();
    return extractHttpsUrl(status);
  } catch {
    return null;
  }
}

export async function tailscaleServeStatus() {
  const cmd = await resolveTailscaleCmd();
  return await runCapture(cmd, ['serve', 'status']);
}

export async function tailscaleServeEnable({ internalServerUrl }) {
  const cmd = await resolveTailscaleCmd();
  const { upstream, servePath } = getServeConfig(internalServerUrl);
  const args = ['serve', '--bg'];
  if (servePath && servePath !== '/' && servePath !== '') {
    args.push(`--set-path=${servePath}`);
  }
  args.push(upstream);
  await run(cmd, args);
  const status = await runCapture(cmd, ['serve', 'status']).catch(() => '');
  return { status, httpsUrl: status ? extractHttpsUrl(status) : null };
}

export async function tailscaleServeReset() {
  const cmd = await resolveTailscaleCmd();
  await run(cmd, ['serve', 'reset']);
}

export async function maybeEnableTailscaleServe({ internalServerUrl }) {
  const enabled = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';
  if (!enabled) {
    return null;
  }
  try {
    return await tailscaleServeEnable({ internalServerUrl });
  } catch (e) {
    throw new Error(`[local] failed to enable tailscale serve (is Tailscale running/authenticated?): ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function maybeResetTailscaleServe() {
  const enabled = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';
  const resetOnExit = (process.env.HAPPY_LOCAL_TAILSCALE_RESET_ON_EXIT ?? '0') === '1';
  if (!enabled || !resetOnExit) {
    return;
  }
  try {
    await tailscaleServeReset();
  } catch {
    // ignore
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms));
}

/**
 * Resolve the best public server URL to present to users / generate links.
 *
 * Priority:
 * 1) explicit HAPPY_LOCAL_SERVER_URL override (if non-default)
 * 2) if enabled, prefer existing https://*.ts.net from tailscale serve status
 * 3) fallback to defaultPublicUrl
 *
 * If HAPPY_LOCAL_TAILSCALE_SERVE=1, this can also try to enable serve and wait briefly for Tailscale to come up.
 */
export async function resolvePublicServerUrl({
  internalServerUrl,
  defaultPublicUrl,
  envPublicUrl,
  allowEnable = true,
}) {
  const preferTailscalePublicUrl = (process.env.HAPPY_LOCAL_TAILSCALE_PREFER_PUBLIC_URL ?? '1') !== '0';
  const userExplicitlySetPublicUrl =
    !!envPublicUrl && envPublicUrl !== defaultPublicUrl && envPublicUrl !== internalServerUrl;

  if (userExplicitlySetPublicUrl || !preferTailscalePublicUrl) {
    return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'env' };
  }

  // If serve is already configured, use its HTTPS URL if present.
  const existing = await tailscaleServeHttpsUrl();
  if (existing) {
    return { publicServerUrl: existing, source: 'tailscale-status' };
  }

  const enableServe = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';
  if (!enableServe || !allowEnable) {
    return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'default' };
  }

  // Try enabling serve (best-effort); then wait a bit for Tailscale to be ready/configured.
  try {
    const res = await tailscaleServeEnable({ internalServerUrl });
    if (res?.httpsUrl) {
      return { publicServerUrl: res.httpsUrl, source: 'tailscale-enable' };
    }
  } catch {
    // ignore and fall back to waiting/polling
  }

  const waitMs = process.env.HAPPY_LOCAL_TAILSCALE_WAIT_MS?.trim()
    ? Number(process.env.HAPPY_LOCAL_TAILSCALE_WAIT_MS.trim())
    : 15000;
  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : 15000);
  while (Date.now() < deadline) {
    const url = await tailscaleServeHttpsUrl();
    if (url) {
      return { publicServerUrl: url, source: 'tailscale-wait' };
    }
    await sleep(500);
  }

  return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'default' };
}

async function main() {
  const { flags, kv } = parseArgs(process.argv.slice(2));
  const cmd = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'status';

  const internalServerUrl = getInternalServerUrl();
  if (flags.has('--upstream') || kv.get('--upstream')) {
    process.env.HAPPY_LOCAL_TAILSCALE_UPSTREAM = kv.get('--upstream') ?? internalServerUrl;
  }
  if (flags.has('--path') || kv.get('--path')) {
    process.env.HAPPY_LOCAL_TAILSCALE_SERVE_PATH = kv.get('--path') ?? '/';
  }

  switch (cmd) {
    case 'status': {
      const status = await tailscaleServeStatus();
      process.stdout.write(status);
      return;
    }
    case 'url': {
      const status = await tailscaleServeStatus();
      const url = extractHttpsUrl(status);
      if (!url) {
        throw new Error('[local] no https:// URL found in `tailscale serve status` output');
      }
      console.log(url);
      return;
    }
    case 'enable': {
      const res = await tailscaleServeEnable({ internalServerUrl });
      if (res.httpsUrl) {
        console.log(`[local] tailscale serve enabled: ${res.httpsUrl}`);
      } else {
        console.log('[local] tailscale serve enabled');
      }
      return;
    }
    case 'disable':
    case 'reset': {
      await tailscaleServeReset();
      console.log('[local] tailscale serve reset');
      return;
    }
    default:
      throw new Error(`[local] unknown tailscale command: ${cmd}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[local] failed:', err);
    process.exit(1);
  });
}

