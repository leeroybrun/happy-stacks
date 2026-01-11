import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';

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

function tailscaleStatusMatchesInternalServerUrl(status, internalServerUrl) {
  const raw = (internalServerUrl ?? '').trim();
  if (!raw) return true;

  // Fast path.
  if (status.includes(raw)) return true;

  // Tailscale typically prints proxy targets like:
  //   |-- / proxy http://127.0.0.1:3005
  let port = '';
  try {
    port = new URL(raw).port;
  } catch {
    port = '';
  }
  if (!port) return false;

  const re = new RegExp(String.raw`\\bproxy\\s+https?:\\/\\/(?:127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0):${port}\\b`, 'i');
  return re.test(status);
}

export async function tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl) {
  try {
    const status = await tailscaleServeStatus();
    const https = extractHttpsUrl(status);
    if (!https) return null;
    return tailscaleStatusMatchesInternalServerUrl(status, internalServerUrl) ? https : null;
  } catch {
    return null;
  }
}

function extractServeEnableUrl(text) {
  const m = String(text ?? '').match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=\S+/i);
  return m ? m[0] : null;
}

function parseTimeoutMs(raw, defaultMs) {
  const s = (raw ?? '').trim();
  if (!s) return defaultMs;
  const n = Number(s);
  // Allow 0 to disable timeouts for user-triggered commands.
  if (!Number.isFinite(n)) return defaultMs;
  return n > 0 ? n : 0;
}

function tailscaleProbeTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPY_LOCAL_TAILSCALE_CMD_TIMEOUT_MS, 2500);
}

function tailscaleUserEnableTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPY_LOCAL_TAILSCALE_ENABLE_TIMEOUT_MS, 30000);
}

function tailscaleAutoEnableTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPY_LOCAL_TAILSCALE_ENABLE_TIMEOUT_MS_AUTO, tailscaleProbeTimeoutMs());
}

function tailscaleUserResetTimeoutMs() {
  return parseTimeoutMs(process.env.HAPPY_LOCAL_TAILSCALE_RESET_TIMEOUT_MS, 15000);
}

function tailscaleEnv() {
  // LaunchAgents inherit `XPC_SERVICE_NAME`, which can confuse some CLI tools.
  // In practice, we’ve seen Tailscale commands like `tailscale version` hang under
  // this env. Strip it for any tailscale subprocesses.
  const env = { ...process.env };
  delete env.XPC_SERVICE_NAME;
  return env;
}

async function isExecutable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveTailscaleCmd() {
  // Allow explicit override (useful for LaunchAgents where aliases don't exist).
  if (process.env.HAPPY_LOCAL_TAILSCALE_BIN?.trim()) {
    return process.env.HAPPY_LOCAL_TAILSCALE_BIN.trim();
  }

  // Try PATH first (without executing `tailscale`, which can hang in some environments).
  try {
    const found = (await runCapture('sh', ['-lc', 'command -v tailscale 2>/dev/null || true'], { env: tailscaleEnv(), timeoutMs: tailscaleProbeTimeoutMs() })).trim();
    if (found) {
      return found;
    }
  } catch {
    // ignore and fall back
  }

  // Common macOS app install paths.
  //
  // IMPORTANT:
  // Prefer the lowercase `tailscale` CLI inside the app bundle. The capitalized
  // `Tailscale` binary can behave differently under LaunchAgents (XPC env),
  // potentially hanging instead of printing a version and exiting.
  const appCliPath = '/Applications/Tailscale.app/Contents/MacOS/tailscale';
  if (await isExecutable(appCliPath)) {
    return appCliPath;
  }

  const appPath = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
  if (await isExecutable(appPath)) {
    return appPath;
  }

  throw new Error(
    `[local] tailscale CLI not found.\n` +
    `- Install Tailscale, or\n` +
    `- Put 'tailscale' on PATH, or\n` +
    `- Set HAPPY_LOCAL_TAILSCALE_BIN="${appCliPath}"`
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
  return await runCapture(cmd, ['serve', 'status'], { env: tailscaleEnv(), timeoutMs: tailscaleProbeTimeoutMs() });
}

export async function tailscaleServeEnable({ internalServerUrl, timeoutMs } = {}) {
  const cmd = await resolveTailscaleCmd();
  const { upstream, servePath } = getServeConfig(internalServerUrl);
  const args = ['serve', '--bg'];
  if (servePath && servePath !== '/' && servePath !== '') {
    args.push(`--set-path=${servePath}`);
  }
  args.push(upstream);
  const env = tailscaleEnv();
  const timeout = Number.isFinite(timeoutMs) ? (timeoutMs > 0 ? timeoutMs : 0) : tailscaleUserEnableTimeoutMs();

  try {
    // `tailscale serve --bg` can hang in some environments (and should never block stack startup).
    // Use a short, best-effort timeout; if it prints an enable URL, open it and return a helpful result.
    await runCapture(cmd, args, { env, timeoutMs: timeout });
  } catch (e) {
    const out = e && typeof e === 'object' && 'out' in e ? e.out : '';
    const err = e && typeof e === 'object' && 'err' in e ? e.err : '';
    const msg = e instanceof Error ? e.message : String(e);
    const combined = `${out ?? ''}\n${err ?? ''}\n${msg ?? ''}`.trim();
    const enableUrl = extractServeEnableUrl(combined);
    if (enableUrl) {
      // User-initiated action (CLI / menubar): open the enable page.
      try {
        await run('open', [enableUrl]);
      } catch {
        // ignore (headless / restricted environment)
      }
      return { status: combined || String(e), httpsUrl: null, enableUrl };
    }
    throw e;
  }

  const status = await runCapture(cmd, ['serve', 'status'], { env, timeoutMs: tailscaleProbeTimeoutMs() }).catch(() => '');
  return { status, httpsUrl: status ? extractHttpsUrl(status) : null };
}

export async function tailscaleServeReset({ timeoutMs } = {}) {
  const cmd = await resolveTailscaleCmd();
  const timeout = Number.isFinite(timeoutMs) ? (timeoutMs > 0 ? timeoutMs : 0) : tailscaleUserResetTimeoutMs();
  await run(cmd, ['serve', 'reset'], { env: tailscaleEnv(), timeoutMs: timeout });
}

export async function maybeEnableTailscaleServe({ internalServerUrl }) {
  const enabled = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';
  if (!enabled) {
    return null;
  }
  try {
    // This is called from automation; it must not hang for long.
    return await tailscaleServeEnable({ internalServerUrl, timeoutMs: tailscaleAutoEnableTimeoutMs() });
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
    // Shutdown path: never block for long.
    await tailscaleServeReset({ timeoutMs: tailscaleProbeTimeoutMs() });
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
  const existing = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
  if (existing) {
    return { publicServerUrl: existing, source: 'tailscale-status' };
  }

  const enableServe = (process.env.HAPPY_LOCAL_TAILSCALE_SERVE ?? '0') === '1';
  if (!enableServe || !allowEnable) {
    return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'default' };
  }

  // Try enabling serve (best-effort); then wait a bit for Tailscale to be ready/configured.
  try {
    const res = await tailscaleServeEnable({ internalServerUrl, timeoutMs: tailscaleAutoEnableTimeoutMs() });
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
    const url = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
    if (url) {
      return { publicServerUrl: url, source: 'tailscale-wait' };
    }
    await sleep(500);
  }

  return { publicServerUrl: envPublicUrl || defaultPublicUrl, source: 'default' };
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] ?? 'help';
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['status', 'enable', 'disable', 'reset', 'url'] },
      text: [
        '[tailscale] usage:',
        '  happys tailscale status [--json]',
        '  happys tailscale enable [--json]',
        '  happys tailscale disable [--json]',
        '  happys tailscale url [--json]',
        '',
        'legacy (cloned repo):',
        '  pnpm tailscale:status [--json]',
        '',
        'advanced:',
        '  node scripts/tailscale.mjs enable --upstream=<url> --path=/ [--json]',
      ].join('\n'),
    });
    return;
  }

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
      if (json) {
        printResult({ json, data: { status, httpsUrl: extractHttpsUrl(status) } });
      } else {
      process.stdout.write(status);
      }
      return;
    }
    case 'url': {
      const status = await tailscaleServeStatus();
      const url = extractHttpsUrl(status);
      if (!url) {
        throw new Error('[local] no https:// URL found in `tailscale serve status` output');
      }
      printResult({ json, data: { url }, text: url });
      return;
    }
    case 'enable': {
      const res = await tailscaleServeEnable({ internalServerUrl });
      if (res?.enableUrl && !res?.httpsUrl) {
        printResult({
          json,
          data: { ok: true, httpsUrl: null, enableUrl: res.enableUrl },
          text: `[local] tailscale serve is not enabled for this tailnet. Opened:\n${res.enableUrl}`,
        });
        return;
      }
      printResult({
        json,
        data: { ok: true, httpsUrl: res.httpsUrl ?? null },
        text: res.httpsUrl ? `[local] tailscale serve enabled: ${res.httpsUrl}` : '[local] tailscale serve enabled',
      });
      return;
    }
    case 'disable':
    case 'reset': {
      await tailscaleServeReset();
      printResult({ json, data: { ok: true }, text: '[local] tailscale serve reset' });
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
