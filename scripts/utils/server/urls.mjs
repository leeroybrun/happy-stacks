import { existsSync, readFileSync } from 'node:fs';

import { getStackName, resolveStackEnvPath } from '../paths/paths.mjs';
import { resolvePublicServerUrl } from '../../tailscale.mjs';
import { resolveServerPortFromEnv } from './port.mjs';

function stackEnvExplicitlySetsPublicUrl({ env, stackName }) {
  try {
    const envPath =
      (env.HAPPY_STACKS_ENV_FILE ?? env.HAPPY_LOCAL_ENV_FILE ?? '').toString().trim() ||
      resolveStackEnvPath(stackName).envPath;
    if (!envPath || !existsSync(envPath)) return false;
    const raw = readFileSync(envPath, 'utf-8');
    return /^(HAPPY_STACKS_SERVER_URL|HAPPY_LOCAL_SERVER_URL)=/m.test(raw);
  } catch {
    return false;
  }
}

export function getPublicServerUrlEnvOverride({ env = process.env, serverPort } = {}) {
  const defaultPublicUrl = `http://localhost:${serverPort}`;
  const stackName = (env.HAPPY_STACKS_STACK ?? env.HAPPY_LOCAL_STACK ?? '').toString().trim() || getStackName();

  let envPublicUrl =
    (env.HAPPY_STACKS_SERVER_URL ?? env.HAPPY_LOCAL_SERVER_URL ?? '').toString().trim() || '';

  // Safety: for non-main stacks, ignore a global SERVER_URL unless it was explicitly set in the stack env file.
  if (stackName !== 'main' && envPublicUrl && !stackEnvExplicitlySetsPublicUrl({ env, stackName })) {
    envPublicUrl = '';
  }

  return { defaultPublicUrl, envPublicUrl, publicServerUrl: envPublicUrl || defaultPublicUrl };
}

export async function resolveServerUrls({ env = process.env, serverPort, allowEnable = true } = {}) {
  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const { defaultPublicUrl, envPublicUrl } = getPublicServerUrlEnvOverride({ env, serverPort });
  const resolved = await resolvePublicServerUrl({
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    allowEnable,
  });
  return {
    internalServerUrl,
    defaultPublicUrl,
    envPublicUrl,
    publicServerUrl: resolved.publicServerUrl,
    publicServerUrlSource: resolved.source,
  };
}

export { resolveServerPortFromEnv };

