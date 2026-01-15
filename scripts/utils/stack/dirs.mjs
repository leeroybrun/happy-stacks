import { join } from 'node:path';

export function getCliHomeDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env?.HAPPY_STACKS_CLI_HOME_DIR ?? env?.HAPPY_LOCAL_CLI_HOME_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'cli');
}

export function getServerLightDataDirFromEnvOrDefault({ stackBaseDir, env }) {
  const fromEnv = (env?.HAPPY_SERVER_LIGHT_DATA_DIR ?? '').trim();
  return fromEnv || join(stackBaseDir, 'server-light');
}

