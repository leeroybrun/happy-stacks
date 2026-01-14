export function resolveServerPortFromEnv({ env = process.env, defaultPort = 3005 } = {}) {
  const raw =
    (env.HAPPY_STACKS_SERVER_PORT ?? '').toString().trim() ||
    (env.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim() ||
    '';
  const n = raw ? Number(raw) : Number(defaultPort);
  return Number.isFinite(n) && n > 0 ? n : Number(defaultPort);
}

