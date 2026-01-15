import { readEnvValueFromFile } from '../env/read.mjs';

export function resolveServerPortFromEnv({ env = process.env, defaultPort = 3005 } = {}) {
  const raw =
    (env.HAPPY_STACKS_SERVER_PORT ?? '').toString().trim() ||
    (env.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim() ||
    '';
  const n = raw ? Number(raw) : Number(defaultPort);
  return Number.isFinite(n) && n > 0 ? n : Number(defaultPort);
}

export async function readServerPortFromEnvFile(envPath, { defaultPort = 3005 } = {}) {
  const v =
    (await readEnvValueFromFile(envPath, 'HAPPY_STACKS_SERVER_PORT')) ||
    (await readEnvValueFromFile(envPath, 'HAPPY_LOCAL_SERVER_PORT')) ||
    '';
  const n = v ? Number(String(v).trim()) : Number(defaultPort);
  return Number.isFinite(n) && n > 0 ? n : Number(defaultPort);
}

// For stack env files, "missing" means "ephemeral stack" (no pinned port).
export async function readPinnedServerPortFromEnvFile(envPath) {
  const v =
    (await readEnvValueFromFile(envPath, 'HAPPY_STACKS_SERVER_PORT')) ||
    (await readEnvValueFromFile(envPath, 'HAPPY_LOCAL_SERVER_PORT')) ||
    '';
  const n = v ? Number(String(v).trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

