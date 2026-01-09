import { setTimeout as delay } from 'node:timers/promises';
import { runCapture } from './proc.mjs';

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

  // eslint-disable-next-line no-console
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

