import { ensureExpoIsolationEnv, getExpoStatePaths, isStateProcessRunning, wantsExpoClearCache, writePidState } from '../expo/expo.mjs';
import { expoSpawn } from '../expo/command.mjs';
import { pickMobileDevMetroPort } from '../expo/metro_ports.mjs';
import { recordStackRuntimeUpdate } from '../stack/runtime_state.mjs';
import { killProcessGroupOwnedByStack } from '../proc/ownership.mjs';
import { resolveMobileExpoConfig } from '../mobile/config.mjs';

export async function startDevExpoMobile({
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
  reservedPorts = new Set(),
  spawnOptions = {},
}) {
  if (!startMobile) return { ok: true, skipped: true, reason: 'disabled' };

  const mobileEnv = { ...baseEnv };
  delete mobileEnv.CI;
  mobileEnv.EXPO_PUBLIC_HAPPY_SERVER_URL = apiServerUrl;
  mobileEnv.EXPO_PUBLIC_DEBUG = mobileEnv.EXPO_PUBLIC_DEBUG ?? '1';

  // We own the browser opening behavior in Happy Stacks; don't let Expo do it.
  mobileEnv.EXPO_NO_BROWSER = '1';
  mobileEnv.BROWSER = 'none';

  const cfg = resolveMobileExpoConfig({ env: mobileEnv });
  mobileEnv.APP_ENV = cfg.appEnv;

  const mobilePaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'mobile-dev',
    projectDir: uiDir,
    stateFileName: 'mobile.state.json',
  });

  await ensureExpoIsolationEnv({
    env: mobileEnv,
    stateDir: mobilePaths.stateDir,
    expoHomeDir: mobilePaths.expoHomeDir,
    tmpDir: mobilePaths.tmpDir,
  });

  const running = await isStateProcessRunning(mobilePaths.statePath);
  const alreadyRunning = Boolean(running.running);

  if (alreadyRunning && !restart) {
    const pid = Number(running.state?.pid);
    const port = Number(running.state?.port);
    if (stackMode && runtimeStatePath && Number.isFinite(pid) && pid > 1) {
      await recordStackRuntimeUpdate(runtimeStatePath, {
        processes: { expoMobilePid: pid },
        expo: { mobilePort: Number.isFinite(port) && port > 0 ? port : null },
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

  if (restart && running.state?.pid) {
    const prevPid = Number(running.state.pid);
    const res = await killProcessGroupOwnedByStack(prevPid, { stackName, envPath, label: 'expo-mobile', json: true });
    if (!res.killed) {
      // eslint-disable-next-line no-console
      console.warn(
        `[local] mobile: not stopping existing Expo pid=${prevPid} because it does not look stack-owned.\n` +
          `[local] mobile: continuing by starting a new Expo process on a free port.`
      );
    }
  }

  const metroPort = await pickMobileDevMetroPort({
    env: baseEnv,
    stackMode,
    stackName,
    reservedPorts,
  });
  mobileEnv.RCT_METRO_PORT = String(metroPort);

  const args = ['start', '--dev-client', '--host', cfg.host, '--port', String(metroPort), '--scheme', cfg.scheme];
  if (wantsExpoClearCache({ env: baseEnv }) && !args.includes('--clear')) {
    args.push('--clear');
  }

  // eslint-disable-next-line no-console
  console.log(`[local] mobile: starting Expo dev-client (metro port=${metroPort})`);
  const proc = await expoSpawn({ label: 'mobile', dir: uiDir, args, env: mobileEnv, options: spawnOptions });
  children.push(proc);

  if (stackMode && runtimeStatePath) {
    await recordStackRuntimeUpdate(runtimeStatePath, {
      processes: { expoMobilePid: proc.pid },
      expo: { mobilePort: metroPort },
    }).catch(() => {});
  }

  try {
    await writePidState(mobilePaths.statePath, { pid: proc.pid, port: metroPort, uiDir, startedAt: new Date().toISOString() });
  } catch {
    // ignore
  }

  return { ok: true, skipped: false, pid: proc.pid, port: metroPort, proc };
}

