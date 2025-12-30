import {
  ensureCliBuilt,
  ensureHappyCliLocalNpmLinked,
  ensureDepsInstalled,
  getComponentDir,
  getRootDir,
  parseArgs,
  pathExists,
  run,
} from './shared.mjs';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { installService, uninstallService } from './service.mjs';

/**
 * Install/setup the local stack:
 * - ensure components exist (optionally clone if missing)
 * - pnpm install where needed
 * - build + npm link happy-cli (so `happy` is on PATH)
 * - build the web UI bundle (so `run` can serve it)
 * - optional macOS autostart (LaunchAgent)
 */

const DEFAULT_FORK_REPOS = {
  server: 'https://github.com/leeroybrun/happy-server-light.git',
  cli: 'https://github.com/leeroybrun/happy-cli.git',
  ui: 'https://github.com/leeroybrun/happy.git',
};

const DEFAULT_UPSTREAM_REPOS = {
  // Upstream for server-light lives in the main happy-server repo.
  server: 'https://github.com/slopus/happy-server.git',
  cli: 'https://github.com/slopus/happy-cli.git',
  ui: 'https://github.com/slopus/happy.git',
};

function resolveRepoSource({ flags }) {
  if (flags.has('--forks')) {
    return 'forks';
  }
  if (flags.has('--upstream')) {
    return 'upstream';
  }
  const fromEnv = (process.env.HAPPY_LOCAL_REPO_SOURCE ?? '').trim().toLowerCase();
  if (fromEnv === 'fork' || fromEnv === 'forks') {
    return 'forks';
  }
  if (fromEnv === 'upstream') {
    return 'upstream';
  }
  return 'forks';
}

function getRepoUrls({ repoSource }) {
  const defaults = repoSource === 'upstream' ? DEFAULT_UPSTREAM_REPOS : DEFAULT_FORK_REPOS;
  return {
    server: process.env.HAPPY_LOCAL_SERVER_REPO_URL?.trim() || defaults.server,
    cli: process.env.HAPPY_LOCAL_CLI_REPO_URL?.trim() || defaults.cli,
    ui: process.env.HAPPY_LOCAL_UI_REPO_URL?.trim() || defaults.ui,
  };
}

async function ensureComponentPresent({ dir, label, repoUrl, allowClone }) {
  if (await pathExists(dir)) {
    return;
  }
  if (!allowClone) {
    throw new Error(`[local] missing ${label} at ${dir} (run with --clone or add it under components/)`);
  }
  if (!repoUrl) {
    throw new Error(
      `[local] missing ${label} at ${dir} and no repo URL configured.\n` +
        `Set HAPPY_LOCAL_${label}_REPO_URL, or run: pnpm bootstrap -- --forks / --upstream`
    );
  }
  await mkdir(dirname(dir), { recursive: true });
  console.log(`[local] cloning ${label} into ${dir}...`);
  await run('git', ['clone', repoUrl, dir]);
}

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));
  const repoSource = resolveRepoSource({ flags });
  const repos = getRepoUrls({ repoSource });

  // Default: clone missing components (fresh checkouts "just work").
  // Disable with --no-clone or HAPPY_LOCAL_CLONE_MISSING=0.
  const cloneMissingDefault = (process.env.HAPPY_LOCAL_CLONE_MISSING ?? '1') !== '0';
  const allowClone = !flags.has('--no-clone') && (flags.has('--clone') || cloneMissingDefault);
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
    repoUrl: repos.server,
    allowClone,
  });
  await ensureComponentPresent({
    dir: cliDir,
    label: 'CLI',
    repoUrl: repos.cli,
    allowClone,
  });
  await ensureComponentPresent({
    dir: uiDir,
    label: 'UI',
    repoUrl: repos.ui,
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
  const buildArgs = [join(rootDir, 'scripts', 'build.mjs')];
  // Tauri builds are opt-in (slow + requires additional toolchain).
  if (flags.has('--tauri') && !flags.has('--no-tauri')) {
    buildArgs.push('--tauri');
  } else if (flags.has('--no-tauri')) {
    buildArgs.push('--no-tauri');
  }
  await run(process.execPath, buildArgs, { cwd: rootDir });

  // Optional autostart (macOS)
  if (disableAutostart) {
    await uninstallService();
  } else if (enableAutostart) {
    await installService();
  }

  console.log('[local] setup complete');
}

main().catch((err) => {
  console.error('[local] install failed:', err);
  process.exit(1);
});


