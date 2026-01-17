import { getStackName } from './paths.mjs';
import { sanitizeDnsLabel } from '../net/dns.mjs';

export function resolveLocalhostHost({ stackMode, stackName = null, env = process.env } = {}) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  if (!stackMode) return 'localhost';
  if (!name || name === 'main') return 'localhost';
  return `happy-${sanitizeDnsLabel(name)}.localhost`;
}

export async function preferStackLocalhostHost({ stackName = null, env = process.env } = {}) {
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  if (!name || name === 'main') return 'localhost';
  // IMPORTANT:
  // We intentionally do NOT gate on `dns.lookup()` here.
  //
  // On some systems (notably macOS), Node's DNS resolver may return ENOTFOUND for `*.localhost`
  // even though browsers treat `*.localhost` as loopback and will load it fine.
  //
  // Since this hostname is primarily used for browser-facing URLs and origin isolation, we
  // prefer the stable `happy-<stack>.localhost` form by default and allow opting out via env.
  const modeRaw = (env.HAPPY_STACKS_LOCALHOST_SUBDOMAINS ?? env.HAPPY_LOCAL_LOCALHOST_SUBDOMAINS ?? '')
    .toString()
    .trim()
    .toLowerCase();
  const disabled = modeRaw === '0' || modeRaw === 'false' || modeRaw === 'no' || modeRaw === 'off';
  if (disabled) return 'localhost';

  const preferredHost = resolveLocalhostHost({ stackMode: true, stackName: name, env });
  return preferredHost || 'localhost';
}

// Best-effort: for stacks, prefer `happy-<stack>.localhost` over `localhost` when it's reachable.
// This keeps URLs stable and stack-scoped while still failing closed to plain localhost.
export async function preferStackLocalhostUrl(url, { stackName = null, env = process.env } = {}) {
  const raw = String(url ?? '').trim();
  if (!raw) return '';
  const name = (stackName ?? '').toString().trim() || getStackName(env);
  if (!name || name === 'main') return raw;

  let u = null;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return raw;

  const isLoopbackHost = u.hostname === 'localhost' || u.hostname === '127.0.0.1';
  if (!isLoopbackHost) return raw;

  const preferredHost = await preferStackLocalhostHost({ stackName: name, env });
  if (!preferredHost || preferredHost === 'localhost') return raw;
  return raw.replace(`://${u.hostname}`, `://${preferredHost}`);
}

