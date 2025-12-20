import {
  ensureCliBuilt,
  ensureHappyCliLocalNpmLinked,
  ensureMacAutostartDisabled,
  ensureMacAutostartEnabled,
  ensureDepsInstalled,
  getComponentDir,
  getDefaultAutostartPaths,
  getRootDir,
  parseArgs,
  pathExists,
  run,
} from './shared.mjs';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';

/**
 * Install/setup the local stack:
 * - ensure components exist (optionally clone if missing)
 * - pnpm install where needed
 * - build + npm link happy-cli (so `happy` is on PATH)
 * - build the web UI bundle (so `run` can serve it)
 * - optional macOS autostart (LaunchAgent)
 */

const DEFAULT_REPOS = {
  server: process.env.HAPPY_LOCAL_SERVER_REPO_URL?.trim() || '',
  cli: process.env.HAPPY_LOCAL_CLI_REPO_URL?.trim() || '',
  ui: process.env.HAPPY_LOCAL_UI_REPO_URL?.trim() || '',
};

async function ensureComponentPresent({ dir, label, repoUrl, allowClone }) {
  if (await pathExists(dir)) {
    return;
  }
  if (!allowClone) {
    throw new Error(`[local] missing ${label} at ${dir} (run with --clone or add it under components/)`);
  }
  if (!repoUrl) {
    throw new Error(`[local] missing ${label} at ${dir} and no repo URL configured (set HAPPY_LOCAL_${label}_REPO_URL)`);
  }
  await mkdir(dirname(dir), { recursive: true });
  console.log(`[local] cloning ${label} into ${dir}...`);
  await run('git', ['clone', repoUrl, dir]);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const allowClone = !flags.has('--no-clone') && (flags.has('--clone') || (process.env.HAPPY_LOCAL_CLONE_MISSING ?? '0') === '1');
  const enableAutostart = flags.has('--autostart') || (process.env.HAPPY_LOCAL_AUTOSTART ?? '0') === '1';
  const disableAutostart = flags.has('--no-autostart');

  const rootDir = getRootDir(import.meta.url);
  const serverDir = getComponentDir(rootDir, 'happy-server-light');
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const uiDir = getComponentDir(rootDir, 'happy');

  // Ensure components exist (embedded layout)
  await ensureComponentPresent({
    dir: serverDir,
    label: 'SERVER',
    repoUrl: DEFAULT_REPOS.server,
    allowClone,
  });
  await ensureComponentPresent({
    dir: cliDir,
    label: 'CLI',
    repoUrl: DEFAULT_REPOS.cli,
    allowClone,
  });
  await ensureComponentPresent({
    dir: uiDir,
    label: 'UI',
    repoUrl: DEFAULT_REPOS.ui,
    allowClone,
  });

  const serverDirFinal = serverDir;
  const cliDirFinal = cliDir;
  const uiDirFinal = uiDir;

  // Install deps
  await ensureDepsInstalled(serverDirFinal, 'happy-server-light');
  await ensureDepsInstalled(uiDirFinal, 'happy');
  await ensureDepsInstalled(cliDirFinal, 'happy-cli');

  // CLI build + link
  const buildCli = (process.env.HAPPY_LOCAL_CLI_BUILD ?? '1') !== '0';
  const npmLinkCli = (process.env.HAPPY_LOCAL_NPM_LINK ?? '1') !== '0';
  await ensureCliBuilt(cliDirFinal, { buildCli });
  await ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli });

  // Build UI (so run works without expo dev server)
  await run(process.execPath, [join(rootDir, 'scripts', 'build.mjs')], { cwd: rootDir });

  // Optional autostart (macOS)
  if (disableAutostart) {
    await ensureMacAutostartDisabled({});
  } else if (enableAutostart) {
    const serverPort = process.env.HAPPY_LOCAL_SERVER_PORT ?? '3005';
    const env = {
      HAPPY_LOCAL_SERVER_PORT: String(serverPort),
      HAPPY_LOCAL_SERVER_URL: process.env.HAPPY_LOCAL_SERVER_URL ?? '',
      HAPPY_LOCAL_DAEMON: process.env.HAPPY_LOCAL_DAEMON ?? '1',
      HAPPY_LOCAL_SERVE_UI: process.env.HAPPY_LOCAL_SERVE_UI ?? '1',
      HAPPY_LOCAL_UI_PREFIX: process.env.HAPPY_LOCAL_UI_PREFIX ?? '/',
      HAPPY_LOCAL_UI_BUILD_DIR: process.env.HAPPY_LOCAL_UI_BUILD_DIR ?? join(getDefaultAutostartPaths().baseDir, 'ui'),
      HAPPY_LOCAL_CLI_HOME_DIR: process.env.HAPPY_LOCAL_CLI_HOME_DIR ?? '',
    };
    // Drop empty env vars (LaunchAgent env dict is annoying with blanks)
    for (const [k, v] of Object.entries(env)) {
      if (!String(v).trim()) {
        delete env[k];
      }
    }
    await ensureMacAutostartEnabled({ rootDir, env });
    console.log('[local] autostart enabled (macOS LaunchAgent)');
  }

  console.log('[local] setup complete');
}

main().catch((err) => {
  console.error('[local] install failed:', err);
  process.exit(1);
});


