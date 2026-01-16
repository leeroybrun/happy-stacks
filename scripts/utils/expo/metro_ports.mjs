import { isTcpPortFree, pickNextFreeTcpPort } from '../net/ports.mjs';

function hashStringToInt(s) {
  let h = 0;
  const str = String(s ?? '');
  for (let i = 0; i < str.length; i++) {
    h = (h * 31 + str.charCodeAt(i)) >>> 0;
  }
  return h >>> 0;
}

function coercePositiveInt(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function resolveStablePortStart({
  env = process.env,
  stackName,
  baseKey,
  rangeKey,
  defaultBase,
  defaultRange,
}) {
  const baseRaw = (env[baseKey] ?? '').toString().trim();
  const rangeRaw = (env[rangeKey] ?? '').toString().trim();
  const base = coercePositiveInt(baseRaw) ?? defaultBase;
  const range = coercePositiveInt(rangeRaw) ?? defaultRange;
  return base + (hashStringToInt(stackName) % range);
}

export async function pickMetroPort({
  startPort,
  forcedPort,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  const forced = coercePositiveInt(forcedPort);
  if (forced) {
    const ok = await isTcpPortFree(forced, { host });
    if (ok) return forced;
  }
  return await pickNextFreeTcpPort(startPort, { reservedPorts, host });
}

export function wantsStablePortStrategy({ env = process.env, strategyKey, legacyStrategyKey } = {}) {
  const raw = (env[strategyKey] ?? env[legacyStrategyKey] ?? 'ephemeral').toString().trim() || 'ephemeral';
  return raw === 'stable';
}

export async function pickUiDevMetroPort({
  env = process.env,
  stackMode,
  stackName,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  const forcedPort =
    (env.HAPPY_STACKS_UI_DEV_PORT ?? env.HAPPY_LOCAL_UI_DEV_PORT ?? '').toString().trim() || '';

  const stable = stackMode && wantsStablePortStrategy({ env, strategyKey: 'HAPPY_STACKS_UI_DEV_PORT_STRATEGY', legacyStrategyKey: 'HAPPY_LOCAL_UI_DEV_PORT_STRATEGY' });
  const startPort = stable
    ? resolveStablePortStart({
        env,
        stackName,
        baseKey: 'HAPPY_STACKS_UI_DEV_PORT_BASE',
        rangeKey: 'HAPPY_STACKS_UI_DEV_PORT_RANGE',
        defaultBase: 8081,
        defaultRange: 1000,
      })
    : 8081;

  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

export async function pickMobileDevMetroPort({
  env = process.env,
  stackMode,
  stackName,
  reservedPorts = new Set(),
  host = '127.0.0.1',
} = {}) {
  // Back-compat: MOBILE_PORT has historically been the "start scanning from here" knob.
  // If MOBILE_DEV_PORT is set, treat it as the forced port.
  const forcedPort =
    (env.HAPPY_STACKS_MOBILE_DEV_PORT ??
      env.HAPPY_LOCAL_MOBILE_DEV_PORT ??
      env.HAPPY_STACKS_MOBILE_PORT ??
      env.HAPPY_LOCAL_MOBILE_PORT ??
      '')
      .toString()
      .trim() || '';

  const stable = stackMode && wantsStablePortStrategy({ env, strategyKey: 'HAPPY_STACKS_MOBILE_DEV_PORT_STRATEGY', legacyStrategyKey: 'HAPPY_LOCAL_MOBILE_DEV_PORT_STRATEGY' });
  const startPort = stable
    ? resolveStablePortStart({
        env,
        stackName,
        baseKey: 'HAPPY_STACKS_MOBILE_DEV_PORT_BASE',
        rangeKey: 'HAPPY_STACKS_MOBILE_DEV_PORT_RANGE',
        // Avoid colliding with UI dev default range by default, but keep it fully configurable.
        defaultBase: 9081,
        defaultRange: 1000,
      })
    : 8081;

  return await pickMetroPort({ startPort, forcedPort, reservedPorts, host });
}

