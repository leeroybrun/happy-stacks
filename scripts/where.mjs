import './utils/env.mjs';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { expandHome } from './utils/canonical_home.mjs';
import { getComponentsDir, getComponentDir, getHappyStacksHomeDir, getRootDir, getStackLabel, getStackName, getWorkspaceDir, resolveStackEnvPath } from './utils/paths.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRuntimeDir } from './utils/runtime.mjs';
import { getCanonicalHomeDir, getCanonicalHomeEnvPath } from './utils/config.mjs';
import { getSandboxDir } from './utils/sandbox.mjs';

function getHomeEnvPaths() {
  const homeDir = getHappyStacksHomeDir();
  return {
    homeEnv: join(homeDir, '.env'),
    homeLocal: join(homeDir, 'env.local'),
  };
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags }) || argv.includes('help')) {
    printResult({
      json,
      data: { flags: ['--json'], commands: ['where', 'env'] },
      text: ['[where] usage:', '  happys where [--json]', '  happys env [--json]'].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const homeDir = getHappyStacksHomeDir();
  const canonicalHomeDir = getCanonicalHomeDir();
  const canonicalEnv = getCanonicalHomeEnvPath();
  const sandboxDir = getSandboxDir();
  const runtimeDir = getRuntimeDir();
  const workspaceDir = getWorkspaceDir(rootDir);
  const componentsDir = getComponentsDir(rootDir);

  const stackName = getStackName();
  const stackLabel = getStackLabel(stackName);
  const resolvedMainEnv = resolveStackEnvPath('main');
  const resolvedActiveEnv = process.env.HAPPY_STACKS_ENV_FILE?.trim()
    ? { envPath: expandHome(process.env.HAPPY_STACKS_ENV_FILE.trim()) }
    : process.env.HAPPY_LOCAL_ENV_FILE?.trim()
      ? { envPath: expandHome(process.env.HAPPY_LOCAL_ENV_FILE.trim()) }
      : null;

  const { homeEnv, homeLocal } = getHomeEnvPaths();
  const updateCachePath = join(homeDir, 'cache', 'update.json');

  const componentNames = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];
  const componentDirs = Object.fromEntries(componentNames.map((name) => [name, getComponentDir(rootDir, name)]));

  printResult({
    json,
    data: {
      ok: true,
      rootDir,
      sandbox: sandboxDir ? { enabled: true, dir: sandboxDir } : { enabled: false },
      homeDir,
      canonicalHomeDir,
      runtimeDir,
      workspaceDir,
      componentsDir,
      stack: { name: stackName, label: stackLabel },
      envFiles: {
        canonical: { path: canonicalEnv, exists: existsSync(canonicalEnv) },
        homeEnv: { path: homeEnv, exists: existsSync(homeEnv) },
        homeLocal: { path: homeLocal, exists: existsSync(homeLocal) },
        active: resolvedActiveEnv ? { path: resolvedActiveEnv.envPath, exists: existsSync(resolvedActiveEnv.envPath) } : null,
        main: { path: resolvedMainEnv.envPath, exists: existsSync(resolvedMainEnv.envPath) },
      },
      components: componentDirs,
      update: {
        enabled: (process.env.HAPPY_STACKS_UPDATE_CHECK ?? '1') !== '0',
        cachePath: updateCachePath,
        cacheExists: existsSync(updateCachePath),
      },
    },
    text: [
      `[where] root:      ${rootDir}`,
      sandboxDir ? `[where] sandbox:   ${sandboxDir}` : null,
      `[where] canonical: ${canonicalHomeDir}`,
      `[where] home:      ${homeDir}`,
      `[where] runtime:   ${runtimeDir}`,
      `[where] workspace: ${workspaceDir}`,
      `[where] components:${componentsDir}`,
      '',
      `[where] stack:     ${stackName} (${stackLabel})`,
      `[where] env (canonical pointer): ${existsSync(canonicalEnv) ? canonicalEnv : `${canonicalEnv} (missing)`}`,
      `[where] env (home defaults): ${existsSync(homeEnv) ? homeEnv : `${homeEnv} (missing)`}`,
      `[where] env (home overrides): ${existsSync(homeLocal) ? homeLocal : `${homeLocal} (missing)`}`,
      `[where] env (active): ${resolvedActiveEnv?.envPath ? resolvedActiveEnv.envPath : '(none)'}`,
      `[where] env (main):   ${resolvedMainEnv.envPath}`,
      '',
      ...componentNames.map((n) => `[where] component ${n}: ${componentDirs[n]}`),
      '',
      `[where] update cache: ${updateCachePath}`,
    ].join('\n'),
  });
}

main().catch((err) => {
  console.error('[where] failed:', err);
  process.exit(1);
});

