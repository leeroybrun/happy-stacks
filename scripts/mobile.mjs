import './utils/env.mjs';
import { parseArgs } from './utils/args.mjs';
import { killPortListeners } from './utils/ports.mjs';
import { run, runCapture, spawnProc } from './utils/proc.mjs';
import { getComponentDir, getRootDir } from './utils/paths.mjs';
import { ensureDepsInstalled, requireDir } from './utils/pm.mjs';

/**
 * Mobile dev helper for the embedded `components/happy` Expo app.
 *
 * Goals:
 * - Avoid editing upstream config files in-place.
 * - Ensure the QR/deeplink opens the *dev build* even if the App Store app is installed.
 *
 * Usage:
 *   pnpm mobile
 *   pnpm mobile --host=lan
 *   pnpm mobile --scheme=com.slopus.happy.dev
  *   pnpm mobile --no-metro
 *   pnpm mobile --run-ios --device="Your iPhone"
 */

async function main() {
  const { flags, kv } = parseArgs(process.argv.slice(2));
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
  const port = kv.get('--port') ?? process.env.HAPPY_STACKS_MOBILE_PORT ?? process.env.HAPPY_LOCAL_MOBILE_PORT ?? '8081';
  // Default behavior:
  // - `pnpm mobile` starts Metro and keeps running.
  // - `pnpm mobile --run-ios` / `pnpm mobile:ios` just builds/installs and exits (unless --metro is provided).
  const shouldStartMetro =
    flags.has('--metro') ||
    (!flags.has('--no-metro') && !flags.has('--run-ios') && !flags.has('--prebuild'));

  const env = {
    ...process.env,
    APP_ENV: appEnv,
  };

  // Allow happy-stacks to define the default server URL baked into the app bundle.
  // This is read by the app via `process.env.EXPO_PUBLIC_HAPPY_SERVER_URL`.
  const stacksServerUrl =
    process.env.HAPPY_STACKS_SERVER_URL?.trim() || process.env.HAPPY_LOCAL_SERVER_URL?.trim() || '';
  if (stacksServerUrl && !env.EXPO_PUBLIC_HAPPY_SERVER_URL) {
    env.EXPO_PUBLIC_HAPPY_SERVER_URL = stacksServerUrl;
  }

  const shouldPrebuild = flags.has('--prebuild');
  if (shouldPrebuild) {
    const platform = kv.get('--platform') ?? 'ios';
    const shouldClean = flags.has('--clean');
    // Prebuild can fail during `pod install` if deployment target mismatches.
    // We skip installs, patch deployment target + RN build mode, then run `pod install` ourselves.
    const prebuildArgs = ['expo', 'prebuild', '--no-install', '--platform', platform];
    if (shouldClean) {
      prebuildArgs.push('--clean');
    }
    await run('npx', prebuildArgs, { cwd: uiDir, env });

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
          next = next.replaceAll(/PRODUCT_NAME = [^;]+;/g, `PRODUCT_NAME = ${iosAppName.trim()};`);
        }
        if (next !== raw) {
          await fs.writeFile(pbxprojPath, next, 'utf-8');
        }
      } catch {
        // ignore
      }
    }

    const configuration = kv.get('--configuration') ?? 'Debug';
    const args = ['expo', 'run:ios', '--no-bundler', '--no-build-cache', '--configuration', configuration];
    if (device) {
      args.push('-d', device);
    }
    // Ensure CocoaPods doesn't crash due to locale issues.
    env.LANG = env.LANG ?? 'en_US.UTF-8';
    env.LC_ALL = env.LC_ALL ?? 'en_US.UTF-8';
    await run('npx', args, { cwd: uiDir, env });
  }

  if (!shouldStartMetro) {
    return;
  }

  const portNumber = Number.parseInt(port, 10);
  if (Number.isFinite(portNumber) && portNumber > 0) {
    await killPortListeners(portNumber, { label: 'expo' });
  }

  // Start Metro for a dev client.
  // The critical part is --scheme: without it, Expo defaults to `exp+<slug>` (here `exp+happy`)
  // which the App Store app also registers, so iOS can open the wrong app.
  spawnProc(
    'mobile',
    'npx',
    ['expo', 'start', '--dev-client', '--host', host, '--port', port, '--scheme', scheme],
    env,
    { cwd: uiDir }
  );

  await new Promise(() => {});
}

main().catch((err) => {
  console.error('[mobile] failed:', err);
  process.exit(1);
});

