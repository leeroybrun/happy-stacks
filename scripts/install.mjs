import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { getComponentDir, getComponentRepoDir, getRootDir, isHappyMonorepoRoot } from './utils/paths/paths.mjs';
import { getServerComponentName } from './utils/server/server.mjs';
import { ensureCliBuilt, ensureDepsInstalled, ensureHappyCliLocalNpmLinked } from './utils/proc/pm.mjs';
import { dirname, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { installService, uninstallService } from './service.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { bold, cyan, dim } from './utils/ui/ansi.mjs';

/**
 * Install/setup the local stack:
 * - ensure components exist (optionally clone if missing)
 * - install dependencies where needed
 * - build happy-cli (optional) and install `happy`/`happys` shims under `<homeDir>/bin`
 * - build the web UI bundle (so `run` can serve it)
 * - optional macOS autostart (LaunchAgent)
 */

const DEFAULT_FORK_REPOS = {
  serverLight: 'https://github.com/leeroybrun/happy-server-light.git',
  // Both server flavors live as branches in the same fork repo:
  // - happy-server-light (sqlite)
  // - happy-server (full)
  serverFull: 'https://github.com/leeroybrun/happy-server-light.git',
  cli: 'https://github.com/leeroybrun/happy-cli.git',
  ui: 'https://github.com/leeroybrun/happy.git',
};

const DEFAULT_UPSTREAM_REPOS = {
  // Upstream for server-light lives in the main happy-server repo.
  serverLight: 'https://github.com/slopus/happy-server.git',
  serverFull: 'https://github.com/slopus/happy.git',
  // slopus/happy is now a monorepo that contains:
  // - expo-app/ (UI)
  // - cli/      (happy-cli)
  // - server/   (happy-server)
  cli: 'https://github.com/slopus/happy.git',
  ui: 'https://github.com/slopus/happy.git',
};

function repoUrlsFromOwners({ forkOwner, upstreamOwner }) {
  const fork = (name) => `https://github.com/${forkOwner}/${name}.git`;
  const up = (name) => `https://github.com/${upstreamOwner}/${name}.git`;
  return {
    forks: {
      serverLight: fork('happy-server-light'),
      // Fork convention: server full is a branch in happy-server-light repo (not a separate repo).
      serverFull: fork('happy-server-light'),
      cli: fork('happy-cli'),
      ui: fork('happy'),
    },
    upstream: {
      // server-light upstream lives in happy-server
      serverLight: up('happy-server'),
      serverFull: up('happy'),
      cli: up('happy'),
      ui: up('happy'),
    },
  };
}

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
  const ui = process.env.HAPPY_LOCAL_UI_REPO_URL?.trim() || defaults.ui;
  return {
    // Backwards compatible: HAPPY_LOCAL_SERVER_REPO_URL historically referred to the server-light component.
    serverLight: process.env.HAPPY_LOCAL_SERVER_LIGHT_REPO_URL?.trim() || process.env.HAPPY_LOCAL_SERVER_REPO_URL?.trim() || defaults.serverLight,
    // Default to the UI repo when using a monorepo (override to keep split repos).
    serverFull: process.env.HAPPY_LOCAL_SERVER_FULL_REPO_URL?.trim() || defaults.serverFull || ui,
    cli: process.env.HAPPY_LOCAL_CLI_REPO_URL?.trim() || defaults.cli || ui,
    ui,
  };
}

async function ensureGitBranchCheckedOut({ repoDir, branch, label }) {
  if (!(await pathExists(join(repoDir, '.git')))) return;
  const b = String(branch ?? '').trim();
  if (!b) return;

  try {
    const head = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoDir })).trim();
    if (head && head === b) return;
  } catch {
    // ignore
  }

  // Ensure branch exists locally, otherwise fetch it from origin.
  let hasLocal = true;
  try {
    await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { cwd: repoDir });
  } catch {
    hasLocal = false;
  }
  if (!hasLocal) {
    try {
      await run('git', ['fetch', '--quiet', 'origin', b], { cwd: repoDir });
    } catch {
      throw new Error(
        `[local] ${label}: expected branch "${b}" to exist in ${repoDir}.\n` +
          `[local] Fix: use --forks for happy-server-light (sqlite), or use --server=happy-server with --upstream.`
      );
    }
  }

  try {
    await run('git', ['checkout', '-q', b], { cwd: repoDir });
  } catch {
    // If remote-tracking branch exists but local doesn't, create it.
    try {
      await run('git', ['checkout', '-q', '-B', b, `origin/${b}`], { cwd: repoDir });
    } catch {
      throw new Error(
        `[local] ${label}: failed to checkout branch "${b}" in ${repoDir}.\n` +
          `[local] Fix: re-run with --force in worktree flows, or delete the checkout and re-run install/bootstrap.`
      );
    }
  }
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
        `Set HAPPY_LOCAL_${label}_REPO_URL, or run: happys bootstrap -- --forks / --upstream`
    );
  }
  await mkdir(dirname(dir), { recursive: true });
  console.log(`[local] cloning ${label} into ${dir}...`);
  await run('git', ['clone', repoUrl, dir]);
}

async function ensureUpstreamRemote({ repoDir, upstreamUrl }) {
  if (!(await pathExists(join(repoDir, '.git')))) {
    return;
  }
  try {
    await run('git', ['remote', 'get-url', 'upstream'], { cwd: repoDir });
    // Upstream remote exists; best-effort update if different.
    await run('git', ['remote', 'set-url', 'upstream', upstreamUrl], { cwd: repoDir }).catch(() => {});
  } catch {
    await run('git', ['remote', 'add', 'upstream', upstreamUrl], { cwd: repoDir });
  }
}

async function interactiveWizard({ rootDir, defaults }) {
  return await withRl(async (rl) => {
    const repoSource = await promptSelect(rl, {
      title: `${bold('Repo source')}\n${dim('Where should Happy Stacks clone the component repos from?')}`,
      options: [
        { label: `${cyan('forks')} (default, recommended)`, value: 'forks' },
        { label: `${cyan('upstream')} (slopus/*)`, value: 'upstream' },
      ],
      defaultIndex: defaults.repoSource === 'upstream' ? 1 : 0,
    });

    // eslint-disable-next-line no-console
    console.log(dim('Tip: keep the defaults unless you maintain your own forks.'));
    const forkOwner = await prompt(rl, `GitHub fork owner (default: ${defaults.forkOwner}): `, { defaultValue: defaults.forkOwner });
    const upstreamOwner = await prompt(rl, `GitHub upstream owner (default: ${defaults.upstreamOwner}): `, {
      defaultValue: defaults.upstreamOwner,
    });

    const serverMode = await promptSelect(rl, {
      title: `${bold('Server components')}\n${dim('Choose which server repo(s) to clone and install deps for.')}`,
      options: [
        { label: `${cyan('happy-server-light')} only (default)`, value: 'happy-server-light' },
        { label: `${cyan('happy-server')} only (full server)`, value: 'happy-server' },
        { label: `both (${cyan('server-light')} + ${cyan('full server')})`, value: 'both' },
      ],
      defaultIndex: defaults.serverComponentName === 'both' ? 2 : defaults.serverComponentName === 'happy-server' ? 1 : 0,
    });

    const allowClone = await promptSelect(rl, {
      title: `${bold('Cloning')}\n${dim('If repos are missing under components/, should we clone them automatically?')}`,
      options: [
        { label: 'yes (default)', value: true },
        { label: 'no', value: false },
      ],
      defaultIndex: defaults.allowClone ? 0 : 1,
    });

    const enableAutostart = await promptSelect(rl, {
      title: isSandboxed()
        ? `${bold('Autostart (macOS)')}\n${dim('Sandbox mode: this is global OS state; normally disabled in sandbox.')}`
        : `${bold('Autostart (macOS)')}\n${dim('Install a LaunchAgent so Happy starts at login?')}`,
      options: [
        { label: 'no (default)', value: false },
        { label: 'yes', value: true },
      ],
      defaultIndex: defaults.enableAutostart ? 1 : 0,
    });

    const buildTauri = await promptSelect(rl, {
      title: `${bold('Desktop app (optional)')}\n${dim('Build the Tauri desktop app as part of setup? (slow; requires extra toolchain)')}`,
      options: [
        { label: 'no (default)', value: false },
        { label: 'yes', value: true },
      ],
      defaultIndex: defaults.buildTauri ? 1 : 0,
    });

    const configureGit = await promptSelect(rl, {
      title: `${bold('Git remotes')}\n${dim('Configure upstream remotes and create/update mirror branches (e.g. slopus/main)?')}`,
      options: [
        { label: 'yes (default)', value: true },
        { label: 'no', value: false },
      ],
      defaultIndex: 0,
    });

    return {
      repoSource,
      forkOwner: forkOwner.trim() || defaults.forkOwner,
      upstreamOwner: upstreamOwner.trim() || defaults.upstreamOwner,
      serverComponentName: serverMode,
      allowClone,
      enableAutostart,
      buildTauri,
      configureGit,
    };
  });
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        flags: [
          '--forks',
          '--upstream',
          '--clone',
          '--no-clone',
          '--autostart',
          '--no-autostart',
          '--server=...',
          '--no-ui-build',
          '--no-ui-deps',
          '--no-cli-deps',
          '--no-cli-build',
        ],
        json: true,
      },
      text: [
        '[bootstrap] usage:',
        '  happys bootstrap [--forks|--upstream] [--server=happy-server|happy-server-light|both] [--json]',
        '  happys bootstrap --interactive',
        '  happys bootstrap --no-clone',
      ].join('\n'),
    });
    return;
  }
  const rootDir = getRootDir(import.meta.url);

  const interactive = flags.has('--interactive') && isTty();
  const allowGlobal = sandboxAllowsGlobalSideEffects();
  const sandboxed = isSandboxed();

  // Defaults for wizard.
  const defaultRepoSource = resolveRepoSource({ flags });
  const defaults = {
    repoSource: defaultRepoSource,
    forkOwner: 'leeroybrun',
    upstreamOwner: 'slopus',
    serverComponentName: getServerComponentName({ kv }),
    allowClone: !flags.has('--no-clone') && ((process.env.HAPPY_LOCAL_CLONE_MISSING ?? '1') !== '0' || flags.has('--clone')),
    enableAutostart: (!sandboxed || allowGlobal) && (flags.has('--autostart') || (process.env.HAPPY_LOCAL_AUTOSTART ?? '0') === '1'),
    buildTauri: flags.has('--tauri') && !flags.has('--no-tauri'),
  };

  const wizard = interactive ? await interactiveWizard({ rootDir, defaults }) : null;
  const repoSource = wizard?.repoSource ?? defaultRepoSource;

  // Persist chosen repo source + URLs into the user config env file:
  // - main stack env by default (recommended; consistent across install modes)
  // - legacy fallback: <repo>/env.local when no home config exists yet
  if (wizard) {
    const owners = repoUrlsFromOwners({ forkOwner: wizard.forkOwner, upstreamOwner: wizard.upstreamOwner });
    const chosen = repoSource === 'upstream' ? owners.upstream : owners.forks;
    await ensureEnvLocalUpdated({
      rootDir,
      updates: [
        { key: 'HAPPY_STACKS_REPO_SOURCE', value: repoSource },
        { key: 'HAPPY_LOCAL_REPO_SOURCE', value: repoSource },
        { key: 'HAPPY_STACKS_UI_REPO_URL', value: chosen.ui },
        { key: 'HAPPY_LOCAL_UI_REPO_URL', value: chosen.ui },
        { key: 'HAPPY_STACKS_CLI_REPO_URL', value: chosen.cli },
        { key: 'HAPPY_LOCAL_CLI_REPO_URL', value: chosen.cli },
        // Backwards compatible: SERVER_REPO_URL historically meant server-light.
        { key: 'HAPPY_STACKS_SERVER_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_LOCAL_SERVER_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_STACKS_SERVER_LIGHT_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_LOCAL_SERVER_LIGHT_REPO_URL', value: chosen.serverLight },
        { key: 'HAPPY_STACKS_SERVER_FULL_REPO_URL', value: chosen.serverFull },
        { key: 'HAPPY_LOCAL_SERVER_FULL_REPO_URL', value: chosen.serverFull },
      ],
    });
  }

  const repos = getRepoUrls({ repoSource });

  // Default: clone missing components (fresh checkouts "just work").
  // Disable with --no-clone or HAPPY_LOCAL_CLONE_MISSING=0.
  const cloneMissingDefault = (process.env.HAPPY_LOCAL_CLONE_MISSING ?? '1') !== '0';
  const allowClone =
    wizard?.allowClone ?? (!flags.has('--no-clone') && (flags.has('--clone') || cloneMissingDefault));
  const enableAutostartRaw = wizard?.enableAutostart ?? (flags.has('--autostart') || (process.env.HAPPY_LOCAL_AUTOSTART ?? '0') === '1');
  const enableAutostart = sandboxed && !allowGlobal ? false : enableAutostartRaw;
  const disableAutostart = flags.has('--no-autostart');

  const serverComponentName = (wizard?.serverComponentName ?? getServerComponentName({ kv })).trim();
  // Safety: upstream server-light is not a separate upstream repo/branch today.
  // Upstream slopus/happy-server is Postgres-only, while happy-server-light requires sqlite.
  if (repoSource === 'upstream' && (serverComponentName === 'happy-server-light' || serverComponentName === 'both')) {
    throw new Error(
      `[bootstrap] --upstream is not supported for happy-server-light (sqlite).\n` +
        `Reason: upstream ${DEFAULT_UPSTREAM_REPOS.serverLight} does not provide a happy-server-light branch.\n` +
        `Fix:\n` +
        `- use --forks (recommended), OR\n` +
        `- use --server=happy-server with --upstream`
    );
  }
  // Repo roots (clone locations)
  const uiRepoDir = getComponentRepoDir(rootDir, 'happy');
  const serverLightRepoDir = getComponentRepoDir(rootDir, 'happy-server-light');

  // Ensure UI exists first (monorepo anchor in slopus/happy).
  await ensureComponentPresent({
    dir: uiRepoDir,
    label: 'UI',
    repoUrl: repos.ui,
    allowClone,
  });

  // Package dirs (where we run installs/builds). Recompute after cloning UI.
  const uiDir = getComponentDir(rootDir, 'happy');
  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const serverFullDir = getComponentDir(rootDir, 'happy-server');

  const cliRepoDir = getComponentRepoDir(rootDir, 'happy-cli');
  const serverFullRepoDir = getComponentRepoDir(rootDir, 'happy-server');
  const hasMonorepo = isHappyMonorepoRoot(uiRepoDir);

  // Ensure other components exist.
  // - server-light stays separate for now.
  // - full server + cli may be embedded in the monorepo.
  if (serverComponentName === 'both' || serverComponentName === 'happy-server-light') {
    await ensureComponentPresent({
      dir: serverLightRepoDir,
      label: 'SERVER',
      repoUrl: repos.serverLight,
      allowClone,
    });
  }
  if (!hasMonorepo) {
    if (serverComponentName === 'both' || serverComponentName === 'happy-server') {
      await ensureComponentPresent({
        dir: serverFullRepoDir,
        label: 'SERVER_FULL',
        repoUrl: repos.serverFull,
        allowClone,
      });
    }
    await ensureComponentPresent({
      dir: cliRepoDir,
      label: 'CLI',
      repoUrl: repos.cli,
      allowClone,
    });
  } else {
    if ((serverComponentName === 'both' || serverComponentName === 'happy-server') && !(await pathExists(serverFullDir))) {
      throw new Error(`[bootstrap] expected monorepo server package at ${serverFullDir} (missing).`);
    }
    if (!(await pathExists(cliDir))) {
      throw new Error(`[bootstrap] expected monorepo cli package at ${cliDir} (missing).`);
    }
  }

  // Ensure expected branches are checked out for server flavors (avoids "server-light directory contains full server" mistakes).
  if (serverComponentName === 'both' || serverComponentName === 'happy-server-light') {
    await ensureGitBranchCheckedOut({ repoDir: serverLightRepoDir, branch: 'happy-server-light', label: 'SERVER' });
  }
  if (serverComponentName === 'both' || serverComponentName === 'happy-server') {
    // In fork mode (split repos), full server is a branch in the fork server repo.
    // In upstream mode and in monorepo mode, use main.
    const serverFullBranch = isHappyMonorepoRoot(serverFullRepoDir) ? 'main' : repoSource === 'upstream' ? 'main' : 'happy-server';
    await ensureGitBranchCheckedOut({ repoDir: serverFullRepoDir, branch: serverFullBranch, label: 'SERVER_FULL' });
  }

  const cliDirFinal = cliDir;
  const uiDirFinal = uiDir;

  // Install deps
  const skipUiDeps = flags.has('--no-ui-deps') || (process.env.HAPPY_STACKS_INSTALL_NO_UI_DEPS ?? '').trim() === '1';
  const skipCliDeps = flags.has('--no-cli-deps') || (process.env.HAPPY_STACKS_INSTALL_NO_CLI_DEPS ?? '').trim() === '1';
  if (serverComponentName === 'both' || serverComponentName === 'happy-server-light') {
    await ensureDepsInstalled(getComponentDir(rootDir, 'happy-server-light'), 'happy-server-light');
  }
  if (serverComponentName === 'both' || serverComponentName === 'happy-server') {
    await ensureDepsInstalled(serverFullDir, 'happy-server');
  }
  if (!skipUiDeps) {
    await ensureDepsInstalled(uiDirFinal, 'happy');
  }
  if (!skipCliDeps) {
    await ensureDepsInstalled(cliDirFinal, 'happy-cli');
  }

  // CLI build + link
  const skipCliBuild = flags.has('--no-cli-build') || (process.env.HAPPY_STACKS_INSTALL_NO_CLI_BUILD ?? '').trim() === '1';
  if (!skipCliBuild) {
    const buildCli = (process.env.HAPPY_LOCAL_CLI_BUILD ?? '1') !== '0';
    const npmLinkCli = (process.env.HAPPY_LOCAL_NPM_LINK ?? '1') !== '0';
    await ensureCliBuilt(cliDirFinal, { buildCli });
    await ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli });
  }

  // Build UI (so run works without expo dev server)
  const skipUiBuild = flags.has('--no-ui-build') || (process.env.HAPPY_STACKS_INSTALL_NO_UI_BUILD ?? '').trim() === '1';
  const buildArgs = [join(rootDir, 'scripts', 'build.mjs')];
  // Tauri builds are opt-in (slow + requires additional toolchain).
  const buildTauri = wizard?.buildTauri ?? (flags.has('--tauri') && !flags.has('--no-tauri'));
  if (!skipUiBuild) {
    if (buildTauri) {
      buildArgs.push('--tauri');
    } else if (flags.has('--no-tauri')) {
      buildArgs.push('--no-tauri');
    }
    await run(process.execPath, buildArgs, { cwd: rootDir });
  }

  // Optional autostart (macOS)
  if (disableAutostart) {
    await uninstallService();
  } else if (enableAutostart) {
    await installService();
  }

  // Optional git remote + mirror branch configuration
  if (wizard?.configureGit) {
    // Ensure upstream remotes exist so `happys wt sync-all` works consistently.
    const upstreamRepos = getRepoUrls({ repoSource: 'upstream' });
    await ensureUpstreamRemote({ repoDir: uiRepoDir, upstreamUrl: upstreamRepos.ui });
    if (cliRepoDir !== uiRepoDir) {
      await ensureUpstreamRemote({ repoDir: cliRepoDir, upstreamUrl: upstreamRepos.cli });
    }
    // server-light and server-full both track upstream happy-server
    if (await pathExists(serverLightRepoDir)) {
      await ensureUpstreamRemote({ repoDir: serverLightRepoDir, upstreamUrl: upstreamRepos.serverLight });
    }
    if (serverFullRepoDir !== uiRepoDir && (await pathExists(serverFullRepoDir))) {
      await ensureUpstreamRemote({ repoDir: serverFullRepoDir, upstreamUrl: upstreamRepos.serverFull });
    }

    // Create/update mirror branches like slopus/main for each repo (best-effort).
    try {
      await run(process.execPath, [join(rootDir, 'scripts', 'worktrees.mjs'), 'sync-all', '--json'], { cwd: rootDir });
    } catch {
      // ignore (still useful even if one component fails)
    }
  }

  printResult({
    json,
    data: {
      ok: true,
      repoSource,
      serverComponentName,
      dirs: {
        uiRepoDir,
        uiDir: uiDirFinal,
        cliRepoDir,
        cliDir: cliDirFinal,
        serverLightRepoDir,
        serverLightDir: getComponentDir(rootDir, 'happy-server-light'),
        serverFullRepoDir,
        serverFullDir,
      },
      cloned: allowClone,
      autostart: enableAutostart ? 'enabled' : sandboxed && enableAutostartRaw && !allowGlobal ? 'skipped (sandbox)' : disableAutostart ? 'disabled' : 'unchanged',
      interactive: Boolean(wizard),
    },
    text: '[local] setup complete',
  });
}

main().catch((err) => {
  console.error('[local] install failed:', err);
  process.exit(1);
});
