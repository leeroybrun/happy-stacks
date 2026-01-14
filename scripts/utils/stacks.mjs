import { readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { getLegacyStorageRoot, getStacksStorageRoot } from './paths.mjs';

export async function listAllStackNames() {
  const names = new Set(['main']);
  const roots = [
    // New layout: ~/.happy/stacks/<name>/env
    getStacksStorageRoot(),
    // Legacy layout: ~/.happy/local/stacks/<name>/env
    join(getLegacyStorageRoot(), 'stacks'),
  ];

  for (const root of roots) {
    let entries = [];
    try {
      // eslint-disable-next-line no-await-in-loop
      entries = await readdir(root, { withFileTypes: true });
    } catch {
      entries = [];
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (!name || name.startsWith('.')) continue;
      const envPath = join(root, name, 'env');
      if (existsSync(envPath)) {
        names.add(name);
      }
    }
  }

  return Array.from(names).sort();
}
