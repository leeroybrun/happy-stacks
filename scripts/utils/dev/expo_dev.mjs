import {
  ensureExpoIsolationEnv,
  getExpoStatePaths,
  isStateProcessRunning,
  wantsExpoClearCache,
  writePidState,
} from '../expo/expo.mjs';
import { pickExpoDevMetroPort } from '../expo/metro_ports.mjs';
import { recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { expoSpawn } from '../expo/command.mjs';
import { resolveMobileExpoConfig } from '../mobile/config.mjs';
import { resolveMobileReachableServerUrl } from '../server/mobile_api_url.mjs';

function normalizeExpoHost(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (v === 'localhost' || v === 'lan' || v === 'tunnel') return v;
  return 'lan';
}

export function resolveExpoDevHost({ env = process.env } = {}) {
  // Always prefer LAN by default so phones can reach Metro.
  const raw = (env.HAPPY_STACKS_EXPO_HOST ?? env.HAPPY_LOCAL_EXPO_HOST ?? '').toString();
  return normalizeExpoHost(raw || 'lan');
}

export function buildExpoStartArgs({ port, host, wantWeb, wantDevClient, scheme, clearCache }) {
  const metroPort = Number(port);
  if (!Number.isFinite(metroPort) || metroPort <= 0) {
    throw new Error(`[expo] invalid Metro port: ${String(port)}`);
  }
  if (!wantWeb && !wantDevClient) {
    throw new Error('[expo] cannot build Expo args: neither web nor dev-client requested');
  }

  // IMPORTANT:
  // - We must only run one Expo per stack.
  // - Expo dev-client mode is known to still serve web when accessed locally, so when mobile is
  //   requested we prefer `--dev-client` as the single shared process (no second `--web` process).
  const args = wantDevClient
    ? ['start', '--dev-client', '--host', host, '--port', String(metroPort)]
    : ['start', '--web', '--host', host, '--port', String(metroPort)];

  if (wantDevClient) {
    const s = String(scheme ?? '').trim();
    if (s) {
      args.push('--scheme', s);
    }
  }

  if (clearCache && !args.includes('--clear')) {
    args.push('--clear');
  }

  return args;
}

function expoModeLabel({ wantWeb, wantDevClient }) {
  if (wantWeb && wantDevClient) return 'dev-client+web';
  if (wantDevClient) return 'dev-client';
  if (wantWeb) return 'web';
  return 'disabled';
}

export async function ensureDevExpoServer({
  startUi,
  startMobile,
  uiDir,
  autostart,
  baseEnv,
  apiServerUrl,
  restart,
  stackMode,
  runtimeStatePath,
  stackName,
  envPath,
  children,
  spawnOptions = {},
} = {}) {
  const wantWeb = Boolean(startUi);
  const wantDevClient = Boolean(startMobile);
  if (!wantWeb && !wantDevClient) {
    return { ok: true, skipped: true, reason: 'disabled' };
  }

  const env = { ...(baseEnv || process.env) };
  delete env.CI;
  // Expo app config: this is what both web + native app use to reach the Happy server.
  // When dev-client is enabled, `localhost` / `*.localhost` are not reachable from the phone,
  // so rewrite to LAN IP here (centralized) to avoid relying on call sites.
  const serverPortFromEnvRaw = (env.HAPPY_STACKS_SERVER_PORT ?? env.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim();
  const serverPortFromEnv = serverPortFromEnvRaw ? Number(serverPortFromEnvRaw) : null;
  const effectiveApiServerUrl = wantDevClient
    ? resolveMobileReachableServerUrl({
        env,
        serverUrl: apiServerUrl,
        serverPort: Number.isFinite(serverPortFromEnv) ? serverPortFromEnv : null,
      })
    : apiServerUrl;
  env.EXPO_PUBLIC_HAPPY_SERVER_URL = effectiveApiServerUrl;
  env.EXPO_PUBLIC_DEBUG = env.EXPO_PUBLIC_DEBUG ?? '1';

  // Optional: allow per-stack storage isolation inside a single dev-client build by
  // scoping app persistence (MMKV / SecureStore) to a stack-specific namespace.
  //
  // This stays upstream-safe because the app behavior is unchanged unless the Expo public
  // env var is explicitly set. Happy Stacks sets it automatically for stack-mode dev-client.
  if (wantDevClient) {
    const explicitScope = (
      env.HAPPY_STACKS_STORAGE_SCOPE ??
      env.HAPPY_LOCAL_STORAGE_SCOPE ??
      env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE ??
      ''
    )
      .toString()
      .trim();
    const defaultScope = stackMode && stackName ? String(stackName).trim() : '';
    const scope = explicitScope || defaultScope;
    if (scope && !env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE) {
      env.EXPO_PUBLIC_HAPPY_STORAGE_SCOPE = scope;
    }
  }

  // We own the browser opening behavior in Happy Stacks so we can reliably open the correct origin.
  env.EXPO_NO_BROWSER = '1';
  env.BROWSER = 'none';

  // Mobile config is needed for `--scheme` and for the app's environment.
  let scheme = '';
  if (wantDevClient) {
    const cfg = resolveMobileExpoConfig({ env });
    env.APP_ENV = cfg.appEnv;
    scheme = cfg.scheme;
  }

  const paths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'expo-dev',
    projectDir: uiDir,
    stateFileName: 'expo.state.json',
  });
  await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir: paths.tmpDir });

  const running = await isStateProcessRunning(paths.statePath);
  const alreadyRunning = Boolean(running.running);

  // Always publish runtime metadata when we can.
  const publishRuntime = async ({ pid, port }) => {
    if (!stackMode || !runtimeStatePath) return;
    const nPid = Number(pid);
    const nPort = Number(port);
    await recordStackRuntimeUpdate(runtimeStatePath, {
      processes: { expoPid: Number.isFinite(nPid) && nPid > 1 ? nPid : null },
      expo: {
        port: Number.isFinite(nPort) && nPort > 0 ? nPort : null,
        // For now keep these populated for callers that still expect webPort/mobilePort.
        webPort: wantWeb && Number.isFinite(nPort) && nPort > 0 ? nPort : null,
        mobilePort: wantDevClient && Number.isFinite(nPort) && nPort > 0 ? nPort : null,
        webEnabled: wantWeb,
        devClientEnabled: wantDevClient,
        host: resolveExpoDevHost({ env }),
        scheme: wantDevClient ? scheme : null,
      },
    }).catch(() => {});
  };

  if (alreadyRunning && !restart) {
    const pid = Number(running.state?.pid);
    const port = Number(running.state?.port);

    // Capability check: refuse to spawn a second Expo, so if the existing process doesn't match the
    // requested capabilities we fail closed and instruct a restart with the superset.
    const stateWeb = Boolean(running.state?.webEnabled);
    const stateDevClient = Boolean(running.state?.devClientEnabled);
    const stateHasCaps = 'webEnabled' in (running.state ?? {}) || 'devClientEnabled' in (running.state ?? {});
    const missingWeb = wantWeb && stateHasCaps && !stateWeb;
    const missingDevClient = wantDevClient && stateHasCaps && !stateDevClient;
    if (missingWeb || missingDevClient) {
      throw new Error(
        `[expo] Expo already running for stack=${stackName}, but it does not match the requested mode.\n` +
          `- running: ${expoModeLabel({ wantWeb: stateWeb, wantDevClient: stateDevClient })}\n` +
          `- wanted:  ${expoModeLabel({ wantWeb, wantDevClient })}\n` +
          `Fix: re-run with --restart (and include --mobile if you need dev-client).`
      );
    }

    await publishRuntime({ pid, port });
    return {
      ok: true,
      skipped: true,
      reason: 'already_running',
      pid: Number.isFinite(pid) ? pid : null,
      port: Number.isFinite(port) ? port : null,
      mode: expoModeLabel({ wantWeb, wantDevClient }),
    };
  }

  const metroPort = await pickExpoDevMetroPort({ env: baseEnv, stackMode, stackName });
  env.RCT_METRO_PORT = String(metroPort);
  const host = resolveExpoDevHost({ env });
  const args = buildExpoStartArgs({
    port: metroPort,
    host,
    wantWeb,
    wantDevClient,
    scheme,
    clearCache: wantsExpoClearCache({ env: baseEnv || process.env }),
  });

  if (restart && running.state?.pid) {
    const prevPid = Number(running.state.pid);
    const res = await killProcessGroupOwnedByStack(prevPid, { stackName, envPath, label: 'expo', json: true });
    if (!res.killed) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] expo: not stopping existing Expo pid=${prevPid} because it does not look stack-owned.\n` +
          `[local] expo: continuing by starting a new Expo process on a free port.`
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[local] expo: starting Expo (${expoModeLabel({ wantWeb, wantDevClient })}, metro port=${metroPort}, host=${host})`);
  const proc = await expoSpawn({ label: 'expo', dir: uiDir, args, env, options: spawnOptions });
  children.push(proc);

  await publishRuntime({ pid: proc.pid, port: metroPort });

  try {
    await writePidState(paths.statePath, {
      pid: proc.pid,
      port: metroPort,
      uiDir,
      startedAt: new Date().toISOString(),
      webEnabled: wantWeb,
      devClientEnabled: wantDevClient,
      host,
      scheme: wantDevClient ? scheme : null,
    });
  } catch {
    // ignore
  }

  return { ok: true, skipped: false, pid: proc.pid, port: metroPort, proc, mode: expoModeLabel({ wantWeb, wantDevClient }) };
}

