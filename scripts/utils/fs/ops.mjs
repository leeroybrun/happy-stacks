import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';

export async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

export async function readTextIfExists(path) {
  try {
    const p = String(path ?? '').trim();
    if (!p || !existsSync(p)) return null;
    const raw = await readFile(p, 'utf-8');
    const t = raw.trim();
    return t ? t : null;
  } catch {
    return null;
  }
}

