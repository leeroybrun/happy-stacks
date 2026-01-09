import { setTimeout as delay } from 'node:timers/promises';

export function getServerComponentName({ kv } = {}) {
  const fromArgRaw = kv?.get('--server')?.trim() ? kv.get('--server').trim() : '';
  const fromEnvRaw = process.env.HAPPY_STACKS_SERVER_COMPONENT?.trim()
    ? process.env.HAPPY_STACKS_SERVER_COMPONENT.trim()
    : process.env.HAPPY_LOCAL_SERVER_COMPONENT?.trim()
      ? process.env.HAPPY_LOCAL_SERVER_COMPONENT.trim()
      : '';
  const raw = fromArgRaw || fromEnvRaw || 'happy-server-light';
  const v = raw.toLowerCase();
  if (v === 'light' || v === 'server-light' || v === 'happy-server-light') {
    return 'happy-server-light';
  }
  if (v === 'server' || v === 'full' || v === 'happy-server') {
    return 'happy-server';
  }
  if (v === 'both') {
    return 'both';
  }
  // Allow explicit component dir names (advanced).
  return raw;
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

