import { ensureDepsInstalled, pmSpawnBin } from './proc/pm.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, isStateProcessRunning, wantsExpoClearCache, writePidState } from './expo.mjs';
import { pickDevMetroPort, resolveStackUiDevPortStart } from './dev_server.mjs';
import { recordStackRuntimeUpdate } from './stack/runtime_state.mjs';
import { killProcessGroupOwnedByStack } from './proc/ownership.mjs';

export async function startDevExpoWebUi({
  startUi,
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
}) {
  if (!startUi) return { ok: true, skipped: true, reason: 'disabled' };

  await ensureDepsInstalled(uiDir, 'happy');
  const uiEnv = { ...baseEnv };
  delete uiEnv.CI;
  uiEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = apiServerUrl;
  uiEnv.EXPO_PUBLIC_DEBUG = uiEnv.EXPO_PUBLIC_DEBUG ?? '1';

  // We own the browser opening behavior in Happy Stacks so we can reliably open the correct origin.
  uiEnv.EXPO_NO_BROWSER = '1';
  uiEnv.BROWSER = 'none';

  const uiPaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'ui-dev',
    projectDir: uiDir,
    stateFileName: 'ui.state.json',
  });

  await ensureExpoIsolationEnv({
    env: uiEnv,
    stateDir: uiPaths.stateDir,
    expoHomeDir: uiPaths.expoHomeDir,
    tmpDir: uiPaths.tmpDir,
  });

  const uiRunning = await isStateProcessRunning(uiPaths.statePath);
  const uiAlreadyRunning = Boolean(uiRunning.running);

  if (uiAlreadyRunning && !restart) {
    const pid = Number(uiRunning.state?.pid);
    const port = Number(uiRunning.state?.port);
    if (stackMode && runtimeStatePath && Number.isFinite(pid) && pid > 1) {
      await recordStackRuntimeUpdate(runtimeStatePath, {
        processes: { expoWebPid: pid },
        expo: { webPort: Number.isFinite(port) && port > 0 ? port : null },
      }).catch(() => {});
    }
    return {
      ok: true,
      skipped: true,
      reason: 'already_running',
      pid: Number.isFinite(pid) ? pid : null,
      port: Number.isFinite(port) ? port : null,
    };
  }

  const strategy =
    (baseEnv.HAPPY_STACKS_UI_DEV_PORT_STRATEGY ?? baseEnv.HAPPY_LOCAL_UI_DEV_PORT_STRATEGY ?? 'ephemeral').toString().trim() ||
    'ephemeral';
  const stable = strategy === 'stable';
  const startPort = stackMode && stable ? resolveStackUiDevPortStart({ env: baseEnv, stackName }) : 8081;
  const metroPort = await pickDevMetroPort({ startPort });
  uiEnv.RCT_METRO_PORT = String(metroPort);

  const uiArgs = ['start', '--web', '--port', String(metroPort)];
  if (wantsExpoClearCache({ env: baseEnv })) {
    uiArgs.push('--clear');
  }

  if (restart && uiRunning.state?.pid) {
    const prevPid = Number(uiRunning.state.pid);
    const res = await killProcessGroupOwnedByStack(prevPid, { stackName, envPath, label: 'expo-web', json: true });
    if (!res.killed) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] ui: not stopping existing Expo pid=${prevPid} because it does not look stack-owned.\n` +
          `[local] ui: continuing by starting a new Expo process on a free port.`
      );
    }
  }

  // eslint-disable-next-line no-console
  console.log(`[local] ui: starting Expo web (metro port=${metroPort})`);
  const ui = await pmSpawnBin({ label: 'ui', dir: uiDir, bin: 'expo', args: uiArgs, env: uiEnv, options: spawnOptions });
  children.push(ui);

  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeUpdate(runtimeStatePath, {
      processes: { expoWebPid: ui.pid },
      expo: { webPort: metroPort },
    }).catch(() => {});
  }

  try {
    await writePidState(uiPaths.statePath, { pid: ui.pid, port: metroPort, uiDir, startedAt: new Date().toISOString() });
  } catch {
    // ignore
  }

  return { ok: true, skipped: false, pid: ui.pid, port: metroPort, proc: ui };
}
