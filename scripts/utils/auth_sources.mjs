import { homedir } from 'node:os';
import { join } from 'node:path';

export function isLegacyAuthSourceName(name) {
  const s = String(name ?? '').trim().toLowerCase();
  return s === 'legacy' || s === 'system' || s === 'local-install';
}

export function getLegacyHappyBaseDir() {
  return join(homedir(), '.happy');
}

