import { join } from 'node:path';
import { ensureEnvFileUpdated } from './env_file.mjs';

export async function ensureEnvLocalUpdated({ rootDir, updates }) {
  const envPath = join(rootDir, 'env.local');
  await ensureEnvFileUpdated({ envPath, updates });
}

