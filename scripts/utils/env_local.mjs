import { ensureUserConfigEnvUpdated } from './config.mjs';

export async function ensureEnvLocalUpdated({ rootDir, updates }) {
  await ensureUserConfigEnvUpdated({ cliRootDir: rootDir, updates });
}
