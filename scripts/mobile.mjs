import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pickNextFreeTcpPort } from './utils/net/ports.mjs';
import { run, runCapture, spawnProc } from './utils/proc/proc.mjs';
import { getComponentDir, getDefaultAutostartPaths, getRootDir } from './utils/paths/paths.mjs';
import { ensureDepsInstalled, pmExecBin, pmSpawnBin, requireDir } from './utils/proc/pm.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, isStateProcessRunning, killPid, wantsExpoClearCache, writePidState } from './utils/expo/expo.mjs';
import { killProcessGroupOwnedByStack } from './utils/proc/ownership.mjs';
import { getPublicServerUrlEnvOverride, resolveServerPortFromEnv } from './utils/server/urls.mjs';

/**
 * Mobile dev helper for the embedded `components/happy` Expo app.
 *
 * Goals:
 * - Avoid editing upstream config files in-place.
 * - Ensure the QR/deeplink opens the *dev build* even if the App Store app is installed.
 *
 * Usage:
 *   happys mobile
 *   happys mobile --host=lan
 *   happys mobile --scheme=com.slopus.happy.dev
  *   happys mobile --no-metro
 *   happys mobile --run-ios --device="Your iPhone"
 */

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const restart = flags.has('--restart');

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        flags: [
          '--host=lan|localhost|tunnel',
          '--port=8081',
          '--scheme=<url-scheme>',
          '--ios-bundle-id=<bundle-id>',
          '--ios-app-name=<name>',
          '--app-env=development|production',
          '--prebuild [--platform=ios|all] [--clean]',
          '--run-ios [--device=<id-or-name>] [--configuration=Debug|Release]',
          '--metro / --no-metro',
          '--restart',
          '--no-signing-fix',
        ],
        json: true,
      },
      text: [
        '[mobile] usage:',
        '  happys mobile [--host=lan|localhost|tunnel] [--port=8081] [--scheme=...] [--json]',
        '  happys mobile --restart   # force-restart Metro for this stack/worktree',
        '  happys mobile --run-ios [--device=...] [--configuration=Debug|Release]',
        '  happys mobile --prebuild [--platform=ios|all] [--clean]',
        '  happys mobile --no-metro   # just build/install (if --run-ios) without starting Metro',
        '',
        'Notes:',
        '- This script is designed to avoid editing upstream `components/happy` config in-place.',
        '- It sets EXPO_PUBLIC_HAPPY_SERVER_URL from HAPPY_STACKS_SERVER_URL (legacy: HAPPY_LOCAL_SERVER_URL) if provided.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const uiDir = getComponentDir(rootDir, 'happy');
  await requireDir('happy', uiDir);
  await ensureDepsInstalled(uiDir, 'happy');

  const sanitizeBundleIdSegment = (s) =>
    (s ?? '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user';

  const defaultLocalBundleId = (() => {
    const user = sanitizeBundleIdSegment(process.env.USER ?? process.env.USERNAME ?? 'user');
    return `com.happy.local.${user}.dev`;
  })();

  async function readXcdeviceList() {
    if (process.platform !== 'darwin') {
      return [];
    }
    const raw = await runCapture('xcrun', ['xcdevice', 'list'], { cwd: uiDir, env: process.env });
    const start = raw.indexOf('[');
    const jsonText = start >= 0 ? raw.slice(start) : raw;
    const parsed = JSON.parse(jsonText);
    return Array.isArray(parsed) ? parsed : [];
  }

  // Default to the existing dev bundle identifier, which is also registered as a URL scheme
  // (Info.plist includes `com.slopus.happy.dev`), so iOS will open the dev build instead of the App Store app.
  const appEnv = process.env.APP_ENV ?? kv.get('--app-env') ?? 'development';
  const iosAppName =
    kv.get('--ios-app-name') ??
    process.env.HAPPY_STACKS_IOS_APP_NAME ??
    process.env.HAPPY_LOCAL_IOS_APP_NAME ??
    '';
  const iosBundleId =
    kv.get('--ios-bundle-id') ??
    process.env.HAPPY_STACKS_IOS_BUNDLE_ID ??
    process.env.HAPPY_LOCAL_IOS_BUNDLE_ID ??
    defaultLocalBundleId;
  const scheme =
    kv.get('--scheme') ??
    process.env.HAPPY_STACKS_MOBILE_SCHEME ??
    process.env.HAPPY_LOCAL_MOBILE_SCHEME ??
    iosBundleId;
  const host = kv.get('--host') ?? process.env.HAPPY_STACKS_MOBILE_HOST ?? process.env.HAPPY_LOCAL_MOBILE_HOST ?? 'lan';
  const portRaw = kv.get('--port') ?? process.env.HAPPY_STACKS_MOBILE_PORT ?? process.env.HAPPY_LOCAL_MOBILE_PORT ?? '8081';
  // Default behavior:
  // - `happys mobile` starts Metro and keeps running.
  // - `happys mobile --run-ios` / `happys mobile:ios` just builds/installs and exits (unless --metro is provided).
  const shouldStartMetro =
    flags.has('--metro') ||
    (!flags.has('--no-metro') && !flags.has('--run-ios') && !flags.has('--prebuild'));

  const env = {
    ...process.env,
    APP_ENV: appEnv,
  };

  const autostart = getDefaultAutostartPaths();
  const mobilePaths = getExpoStatePaths({
    baseDir: autostart.baseDir,
    kind: 'mobile-dev',
    projectDir: uiDir,
    stateFileName: 'mobile.state.json',
  });
  await ensureExpoIsolationEnv({
    env,
    stateDir: mobilePaths.stateDir,
    expoHomeDir: mobilePaths.expoHomeDir,
    tmpDir: mobilePaths.tmpDir,
  });

  // Allow happy-stacks to define the default server URL baked into the app bundle.
  // This is read by the app via `process.env.EXPO_PUBLIC_HAPPY_SERVER_URL`.
  const serverPort = resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });
  const { envPublicUrl } = getPublicServerUrlEnvOverride({ env: process.env, serverPort });
  if (envPublicUrl && !env.EXPO_PUBLIC_HAPPY_SERVER_URL) {
    env.EXPO_PUBLIC_HAPPY_SERVER_URL = envPublicUrl;
  }

  if (json) {
    printResult({
      json,
      data: {
        ok: true,
        uiDir,
        appEnv,
        iosAppName,
        iosBundleId,
        scheme,
        host,
        port: portRaw,
        shouldPrebuild: flags.has('--prebuild'),
        shouldRunIos: flags.has('--run-ios'),
        shouldStartMetro,
        expoPublicHappyServerUrl: env.EXPO_PUBLIC_HAPPY_SERVER_URL ?? '',
      },
    });
    return;
  }

  const shouldPrebuild = flags.has('--prebuild');
  if (shouldPrebuild) {
    const platform = kv.get('--platform') ?? 'ios';
    const shouldClean = flags.has('--clean');
    // Prebuild can fail during `pod install` if deployment target mismatches.
    // We skip installs, patch deployment target + RN build mode, then run `pod install` ourselves.
    const prebuildArgs = ['prebuild', '--no-install', '--platform', platform];
    if (shouldClean) {
      prebuildArgs.push('--clean');
    }
    await pmExecBin({ dir: uiDir, bin: 'expo', args: prebuildArgs, env });

    // Always patch iOS props if iOS was generated.
    if (platform === 'ios' || platform === 'all') {
      const fs = await import('node:fs/promises');
      const podPropsPath = `${uiDir}/ios/Podfile.properties.json`;
      const pbxprojPath = `${uiDir}/ios/Happydev.xcodeproj/project.pbxproj`;
      try {
        const raw = await fs.readFile(podPropsPath, 'utf-8');
        const json = JSON.parse(raw);
        json['ios.deploymentTarget'] = '16.0';
        json['ios.buildReactNativeFromSource'] = 'true';
        await fs.writeFile(podPropsPath, JSON.stringify(json, null, 2) + '\n', 'utf-8');
      } catch {
        // ignore if path missing (platform != ios)
      }

      try {
        const raw = await fs.readFile(pbxprojPath, 'utf-8');
        const next = raw.replaceAll('IPHONEOS_DEPLOYMENT_TARGET = 15.1;', 'IPHONEOS_DEPLOYMENT_TARGET = 16.0;');
        if (next !== raw) {
          await fs.writeFile(pbxprojPath, next, 'utf-8');
        }
      } catch {
        // ignore missing pbxproj (unexpected)
      }

      // Ensure CocoaPods doesn't crash due to locale issues.
      env.LANG = env.LANG ?? 'en_US.UTF-8';
      env.LC_ALL = env.LC_ALL ?? 'en_US.UTF-8';
      await run('sh', ['-lc', 'cd ios && pod install'], { cwd: uiDir, env });
    }
  }

  if (flags.has('--run-ios')) {
    let device = kv.get('--device') ?? '';
    let resolvedDevice = null;
    if (process.platform === 'darwin') {
      try {
        const list = await readXcdeviceList();
        resolvedDevice = device
          ? list.find((d) => d && (d.identifier === device || d.name === device)) ?? null
          : null;
      } catch {
        resolvedDevice = null;
      }
    }

    if (!device && process.platform === 'darwin') {
      // Auto-pick a connected physical iPhone/iPad if available.
      // This avoids needing to know the exact "Your iPhone" string.
      try {
        const list = await readXcdeviceList();
        const firstConnectedIosDevice = Array.isArray(list)
          ? list.find(
              (d) =>
                d &&
                d.platform === 'com.apple.platform.iphoneos' &&
                d.interface === 'usb' &&
                (d.available === true || d.available === 'YES') &&
                typeof d.identifier === 'string' &&
                d.identifier.length > 0
            )
          : null;
        if (firstConnectedIosDevice?.identifier) {
          device = firstConnectedIosDevice.identifier;
          resolvedDevice = firstConnectedIosDevice;
          // eslint-disable-next-line no-console
          console.log(`[mobile] using connected device: ${firstConnectedIosDevice.name} (${device})`);
        }
      } catch {
        // ignore and let Expo choose
      }
    }

    const isPhysicalIosDevice =
      resolvedDevice?.platform === 'com.apple.platform.iphoneos' && resolvedDevice?.simulator === false;

    const shouldPatchXcodeProject = isPhysicalIosDevice || !!iosAppName;
    if (shouldPatchXcodeProject && !flags.has('--no-signing-fix')) {
      // Expo CLI only passes `-allowProvisioningUpdates` when it *needs* to configure signing.
      // If the pbxproj already has a DEVELOPMENT_TEAM set but no local provisioning profile exists yet,
      // xcodebuild fails with:
      //   "Automatic signing is disabled ... pass -allowProvisioningUpdates"
      //
      // We force Expo CLI to go through its signing configuration path by clearing DEVELOPMENT_TEAM,
      // so it will re-set the team and include the provisioning flags.
      try {
        const fs = await import('node:fs/promises');
        const pbxprojPath = `${uiDir}/ios/Happydev.xcodeproj/project.pbxproj`;
        const raw = await fs.readFile(pbxprojPath, 'utf-8');
        let next = raw.replaceAll(/^\s*DEVELOPMENT_TEAM = ".*";\s*$/gm, '');
        next = next.replaceAll(/PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g, `PRODUCT_BUNDLE_IDENTIFIER = ${iosBundleId};`);
        if (iosAppName && iosAppName.trim()) {
          const name = iosAppName.trim();
          const quoted = name.includes(' ') || name.includes('"') ? `"${name.replaceAll('"', '\\"')}"` : name;
          next = next.replaceAll(/PRODUCT_NAME = [^;]+;/g, `PRODUCT_NAME = ${quoted};`);
        }
        if (next !== raw) {
          await fs.writeFile(pbxprojPath, next, 'utf-8');
        }
      } catch {
        // ignore
      }
    }

    const configuration = kv.get('--configuration') ?? 'Debug';
    const args = ['run:ios', '--no-bundler', '--no-build-cache', '--configuration', configuration];
    if (device) {
      args.push('-d', device);
    }
    // Ensure CocoaPods doesn't crash due to locale issues.
    env.LANG = env.LANG ?? 'en_US.UTF-8';
    env.LC_ALL = env.LC_ALL ?? 'en_US.UTF-8';
    await pmExecBin({ dir: uiDir, bin: 'expo', args, env });
  }

  if (!shouldStartMetro) {
    return;
  }

  const running = await isStateProcessRunning(mobilePaths.statePath);
  if (!restart && running.running) {
    // eslint-disable-next-line no-console
    console.log(`[mobile] Metro already running for this stack/worktree (pid=${running.state.pid}, port=${running.state.port})`);
    return;
  }
  if (restart && running.state?.pid) {
    const prevPid = Number(running.state.pid);
    const stackName = (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || autostart.stackName;
    const envPath = (process.env.HAPPY_STACKS_ENV_FILE ?? process.env.HAPPY_LOCAL_ENV_FILE ?? '').toString();
    const res = await killProcessGroupOwnedByStack(prevPid, { stackName, envPath, label: 'expo-mobile', json: true });
    if (!res.killed) {
      // eslint-disable-next-line no-console
      console.warn(
        `[mobile] not stopping existing Metro pid=${prevPid} because it does not look stack-owned.\n` +
          `[mobile] continuing by starting a new Metro on a free port.`
      );
    }
  }

  const requestedPort = Number.parseInt(String(portRaw), 10);
  const startPort = Number.isFinite(requestedPort) && requestedPort > 0 ? requestedPort : 8081;
  const portNumber = await pickNextFreeTcpPort(startPort);
  env.RCT_METRO_PORT = String(portNumber);

  // Start Metro for a dev client.
  // The critical part is --scheme: without it, Expo defaults to `exp+<slug>` (here `exp+happy`)
  // which the App Store app also registers, so iOS can open the wrong app.
  const args = ['start', '--dev-client', '--host', host, '--port', String(portNumber), '--scheme', scheme];
  if (wantsExpoClearCache({ env })) {
    args.push('--clear');
  }
  const child = await pmSpawnBin({ label: 'mobile', dir: uiDir, bin: 'expo', args, env });
  await writePidState(mobilePaths.statePath, { pid: child.pid, port: portNumber, uiDir, startedAt: new Date().toISOString() });

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[mobile] failed:', err);
  process.exit(1);
});
