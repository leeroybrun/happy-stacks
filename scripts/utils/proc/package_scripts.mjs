import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

import { pathExists } from '../fs/fs.mjs';
import { requirePnpm } from './pm.mjs';

export async function detectPackageManagerCmd(dir) {
  if (await pathExists(join(dir, 'yarn.lock'))) {
    return { name: 'yarn', cmd: 'yarn', argsForScript: (script) => ['-s', script] };
  }
  await requirePnpm();
  return { name: 'pnpm', cmd: 'pnpm', argsForScript: (script) => ['--silent', script] };
}

export async function readPackageJsonScripts(dir) {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return scripts;
  } catch {
    return null;
  }
}

export function pickFirstScript(scripts, candidates) {
  if (!scripts) return null;
  const list = Array.isArray(candidates) ? candidates : [];
  return list.find((k) => typeof scripts[k] === 'string' && scripts[k].trim()) ?? null;
}

