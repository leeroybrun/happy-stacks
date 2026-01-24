import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getHappyStacksHomeDir, getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { getCanonicalHomeDir } from './utils/env/config.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { waitForHappyHealthOk } from './utils/server/server.mjs';
import { tailscaleServeEnable, tailscaleServeHttpsUrlForInternalServerUrl } from './tailscale.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { homedir } from 'node:os';
import { installService } from './service.mjs';
import { getDevAuthKeyPath } from './utils/auth/dev_key.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { boolFromFlags, boolFromFlagsOrKv } from './utils/cli/flags.mjs';
import { normalizeProfile, normalizeServerComponent } from './utils/cli/normalize.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { commandExists } from './utils/proc/commands.mjs';
import { readServerPortFromEnvFile, resolveServerPortFromEnv } from './utils/server/port.mjs';
import { guidedStackAuthLoginNow } from './utils/auth/stack_guided_login.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { runCommandLogged } from './utils/cli/progress.mjs';
import { bold, cyan, dim, green, yellow } from './utils/ui/ansi.mjs';
import { expandHome } from './utils/paths/canonical_home.mjs';
import { listAllStackNames } from './utils/stack/stacks.mjs';

function resolveWorkspaceDirDefault() {
  const explicit = (process.env.HAPPY_STACKS_WORKSPACE_DIR ?? process.env.HAPPY_LOCAL_WORKSPACE_DIR ?? '').toString().trim();
  if (explicit) return expandHome(explicit);
  return join(getHappyStacksHomeDir(process.env), 'workspace');
}

function normalizeWorkspaceDirInput(raw, { homeDir }) {
  const trimmed = String(raw ?? '').trim();
  const expanded = expandHome(trimmed);
  if (!expanded) return '';
  // If relative, treat it as relative to the home dir (same rule as init.mjs).
  return expanded.startsWith('/') ? expanded : join(homeDir, expanded);
}

async function resolveMainServerPort() {
  // Priority:
  // - explicit env var
  // - main stack env file (preferred)
  // - default
  const hasEnvOverride =
    (process.env.HAPPY_STACKS_SERVER_PORT ?? process.env.HAPPY_LOCAL_SERVER_PORT ?? '').toString().trim() !== '';
  if (hasEnvOverride) {
    return resolveServerPortFromEnv({ env: process.env, defaultPort: 3005 });
  }
  const envPath = resolveStackEnvPath('main').envPath;
  return await readServerPortFromEnvFile(envPath, { defaultPort: 3005 });
}

async function ensureSetupConfigPersisted({ rootDir, profile, serverComponent, tailscaleWanted, menubarMode }) {
  const repoSourceForProfile =
    profile === 'selfhost' ? (serverComponent === 'happy-server-light' ? 'forks' : 'upstream') : null;
  const updates = [
    { key: 'HAPPY_STACKS_SERVER_COMPONENT', value: serverComponent },
    { key: 'HAPPY_LOCAL_SERVER_COMPONENT', value: serverComponent },
    // Default for selfhost:
    // - full server: upstream (slopus/*)
    // - server-light: forks (sqlite server-light is not available upstream today)
    ...(repoSourceForProfile
      ? [
          { key: 'HAPPY_STACKS_REPO_SOURCE', value: repoSourceForProfile },
          { key: 'HAPPY_LOCAL_REPO_SOURCE', value: repoSourceForProfile },
        ]
      : []),
    { key: 'HAPPY_STACKS_MENUBAR_MODE', value: menubarMode },
    { key: 'HAPPY_LOCAL_MENUBAR_MODE', value: menubarMode },
    ...(tailscaleWanted
      ? [
          { key: 'HAPPY_STACKS_TAILSCALE_SERVE', value: '1' },
          { key: 'HAPPY_LOCAL_TAILSCALE_SERVE', value: '1' },
        ]
      : []),
  ];
  await ensureEnvLocalUpdated({ rootDir, updates });
}

async function ensureSystemdAvailable() {
  if (process.platform !== 'linux') return true;
  return (await commandExists('systemctl')) && (await commandExists('journalctl'));
}

async function runNodeScript({ rootDir, rel, args = [], env = process.env }) {
  await run(process.execPath, [join(rootDir, rel), ...args], { cwd: rootDir, env });
}

async function spawnDetachedNodeScript({ rootDir, rel, args = [], env = process.env }) {
  const child = spawn(process.execPath, [join(rootDir, rel), ...args], {
    cwd: rootDir,
    env,
    stdio: 'ignore',
    detached: process.platform !== 'win32',
  });
  child.unref();
  return child.pid;
}

function mainCliHomeDirForEnvPath(envPath) {
  const { baseDir } = resolveStackEnvPath('main');
  // Prefer stack base dir; envPath is informational and can be legacy/new.
  return join(baseDir, 'cli');
}

function getMainStacksAccessKeyPath() {
  const cliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
  return join(cliHomeDir, 'access.key');
}

function getLegacyHappyAccessKeyPath() {
  return join(homedir(), '.happy', 'cli', 'access.key');
}

function getDevAuthStackAccessKeyPath(stackName = 'dev-auth') {
  const { baseDir, envPath } = resolveStackEnvPath(stackName);
  if (!existsSync(envPath)) return null;
  return join(baseDir, 'cli', 'access.key');
}

function detectAuthSources() {
  const devKeyPath = getDevAuthKeyPath();
  const mainAccessKeyPath = getMainStacksAccessKeyPath();
  const legacyAccessKeyPath = getLegacyHappyAccessKeyPath();
  const devAuthAccessKeyPath = getDevAuthStackAccessKeyPath('dev-auth');
  const allowLegacy = !isSandboxed() || sandboxAllowsGlobalSideEffects();
  return {
    devKeyPath,
    hasDevKey: existsSync(devKeyPath),
    mainAccessKeyPath,
    hasMainAccessKey: existsSync(mainAccessKeyPath),
    legacyAccessKeyPath,
    hasLegacyAccessKey: allowLegacy && existsSync(legacyAccessKeyPath),
    devAuthAccessKeyPath,
    hasDevAuthAccessKey: Boolean(devAuthAccessKeyPath && existsSync(devAuthAccessKeyPath)),
  };
}

async function maybeConfigureAuthDefaults({ rootDir, profile, interactive }) {
  if (!interactive) return;
  if (profile !== 'dev') return;

  const sources = detectAuthSources();
  const autoSeedEnabled =
    (process.env.HAPPY_STACKS_AUTO_AUTH_SEED ?? process.env.HAPPY_LOCAL_AUTO_AUTH_SEED ?? '').toString().trim() === '1';
  const seedFrom = (process.env.HAPPY_STACKS_AUTH_SEED_FROM ?? process.env.HAPPY_LOCAL_AUTH_SEED_FROM ?? '').toString().trim();
  const linkMode =
    (process.env.HAPPY_STACKS_AUTH_LINK ?? process.env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim() === '1' ||
    (process.env.HAPPY_STACKS_AUTH_MODE ?? process.env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim().toLowerCase() === 'link';

  // If we already have dev-auth seeded and configured, don't ask redundant questions.
  // (User can always re-run setup or use stack/auth commands to change this.)
  const alreadyConfiguredDevAuth = autoSeedEnabled && seedFrom === 'dev-auth' && sources.hasDevAuthAccessKey;
  if (alreadyConfiguredDevAuth) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Authentication (development)'));
    // eslint-disable-next-line no-console
    console.log(`${green('✓')} dev-auth auth seeding is already configured`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Seed from:')} ${cyan('dev-auth')}`);
    // eslint-disable-next-line no-console
    console.log(`${dim('Mode:')} ${linkMode ? 'symlink' : 'copy'}`);
    if (sources.hasDevKey) {
      // eslint-disable-next-line no-console
      console.log(`${dim('Dev key:')} configured`);
    }
    // If a user wants to change or recreate:
    // eslint-disable-next-line no-console
    console.log(dim(`Tip: to recreate the seed stack, run: ${yellow('happys stack create-dev-auth-seed')}`));
    return;
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('Authentication (development)'));
  // eslint-disable-next-line no-console
  console.log(
    dim(
      `Recommended: set up a dedicated ${cyan('dev-auth')} seed stack so you authenticate once, then new stacks “just work”.`
    )
  );

  const options = [];
  if (sources.hasDevAuthAccessKey) {
    options.push({
      label: `${green('✓')} use ${cyan('dev-auth')} seed stack (${green('recommended')}) — already authenticated`,
      value: 'use-dev-auth',
    });
  } else {
    options.push({
      label: `create ${cyan('dev-auth')} seed stack (${green('recommended')}) — login once, reuse across stacks`,
      value: 'create-dev-auth',
    });
  }
  if (sources.hasMainAccessKey) {
    options.push({ label: `use ${cyan('main')} as seed — fast, but shares identity with main`, value: 'main' });
  }
  if (sources.hasLegacyAccessKey) {
    options.push({ label: `use legacy ${cyan('~/.happy')} as seed — best-effort`, value: 'legacy' });
  }
  options.push({ label: `skip for now — you can do this later`, value: 'skip' });

  const choice = await withRl(async (rl) => {
    return await promptSelect(rl, {
      title: bold('Choose an auth strategy'),
      options,
      defaultIndex: 0,
    });
  });

  if (choice === 'skip') {
    // eslint-disable-next-line no-console
    console.log(dim(`Tip: run ${yellow('happys stack create-dev-auth-seed')} anytime to set this up.`));
    return;
  }

  const seedChoice = choice === 'create-dev-auth' || choice === 'use-dev-auth' ? 'dev-auth' : String(choice);
  if (choice === 'create-dev-auth') {
    // Guided wizard: creates stack, starts temporary UI/server, saves dev key (optional), logs in CLI.
    await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['create-dev-auth-seed', 'dev-auth'] });
  }

  // Symlink vs copy for seeded stacks (preferred: symlink so credentials stay up to date).
  const linkChoice = await withRl(async (rl) => {
    return await promptSelect(rl, {
      title: `${bold('Auth seeding mode')}\n${dim('When seeding credentials into stacks, should we symlink or copy?')}`,
      options: [
        { label: `symlink (${green('recommended')}) — stays up to date`, value: 'link' },
        { label: `copy — more isolated per stack`, value: 'copy' },
      ],
      defaultIndex: 0,
    });
  });

  await ensureEnvLocalUpdated({
    rootDir,
    updates: [
      { key: 'HAPPY_STACKS_AUTO_AUTH_SEED', value: '1' },
      { key: 'HAPPY_LOCAL_AUTO_AUTH_SEED', value: '1' },
      { key: 'HAPPY_STACKS_AUTH_SEED_FROM', value: seedChoice },
      { key: 'HAPPY_LOCAL_AUTH_SEED_FROM', value: seedChoice },
      { key: 'HAPPY_STACKS_AUTH_LINK', value: linkChoice === 'link' ? '1' : '0' },
      { key: 'HAPPY_LOCAL_AUTH_LINK', value: linkChoice === 'link' ? '1' : '0' },
    ],
  });

  // Optional: seed existing stacks now (useful if the user already has stacks).
  const allStacks = await listAllStackNames().catch(() => ['main']);
  const candidateTargets = allStacks.filter((s) => s !== 'main' && s !== seedChoice);
  if (candidateTargets.length) {
    const seedNow = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: `${bold('Seed existing stacks?')}\n${dim(
          `We found ${candidateTargets.length} existing stack(s) that could reuse auth from ${cyan(seedChoice)}.`
        )}\n${dim('This can fix “auth required / no machine” without re-login.')}`,
        options: [
          { label: 'no (default)', value: false },
          { label: `yes — seed ${candidateTargets.length} stack(s) now`, value: true },
        ],
        defaultIndex: 0,
      });
    });
    if (seedNow) {
      const except = ['main'];
      if (seedChoice !== 'main') except.push(seedChoice);
      const args = [
        'copy-from',
        seedChoice,
        '--all',
        `--except=${except.join(',')}`,
        ...(linkChoice === 'link' ? ['--link'] : []),
      ];
      await runNodeScript({ rootDir, rel: 'scripts/auth.mjs', args });
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(dim('No existing stacks detected that need seeding (nothing to do).'));
  }

  // Dev key UX (for phone/Playwright restores). Keep it explicit because it’s sensitive.
  const sourcesAfter = detectAuthSources();
  if (sourcesAfter.hasDevKey) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Dev key (optional, sensitive)'));
    // eslint-disable-next-line no-console
    console.log(dim('This lets you restore the UI account quickly (and can help automation).'));
    // eslint-disable-next-line no-console
    console.log(dim(`Stored at: ${sourcesAfter.devKeyPath}`));
    const keyChoice = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'Do you want to print it now?',
        options: [
          { label: 'no (default) — keep it private', value: 'skip' },
          { label: `yes — print dev key (${yellow('will display a secret')})`, value: 'print' },
        ],
        defaultIndex: 0,
      });
    });
    if (keyChoice === 'print') {
      await runNodeScript({ rootDir, rel: 'scripts/auth.mjs', args: ['dev-key', '--print'] });
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(dim(`Tip: to store a dev key later, run: ${yellow('happys auth dev-key --set "<key>"')}`));
  }
}

async function cmdSetup({ rootDir, argv }) {
  // Alias: `happys setup pr ...` (maintainer-friendly, idempotent PR setup).
  // This delegates to `setup-pr` so the logic stays centralized.
  const firstPositional = argv.find((a) => !a.startsWith('--')) ?? '';
  if (firstPositional === 'pr') {
    const idx = argv.indexOf('pr');
    const forwarded = idx >= 0 ? argv.slice(idx + 1) : [];
    await run(process.execPath, [join(rootDir, 'scripts', 'setup_pr.mjs'), ...forwarded], { cwd: rootDir });
    return;
  }

  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        profiles: ['selfhost', 'dev'],
        flags: [
          '--profile=selfhost|dev',
          '--server=happy-server-light|happy-server',
          '--workspace-dir=/absolute/path   # dev profile only',
          '--install-path',
          '--start-now',
          '--auth|--no-auth',
          '--tailscale|--no-tailscale',
          '--autostart|--no-autostart',
          '--menubar|--no-menubar',
          '--json',
        ],
      },
      text: [
        '[setup] usage:',
        '  happys setup',
        '  happys setup --profile=selfhost',
        '  happys setup --profile=dev',
        '  happys setup --profile=dev --workspace-dir=~/Development/happy',
        '  happys setup pr --happy=<pr-url|number> [--happy-server-light=<pr-url|number>]',
        '  happys setup --auth',
        '  happys setup --no-auth',
        '',
        'notes:',
        '  - selfhost profile is a guided installer for running Happy locally (optionally with Tailscale + autostart).',
        '  - dev profile prepares a development workspace (bootstrap wizard + optional dev tooling).',
        '  - `setup pr` is a non-interactive, idempotent helper for maintainers to run PR stacks (delegates to `happys setup-pr`).',
      ].join('\n'),
    });
    return;
  }

  const interactive = isTty();
  let profile = normalizeProfile(kv.get('--profile'));
  if (!profile && interactive) {
    profile = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: bold(`✨ ${cyan('Happy Stacks')} setup ✨\n\nWhat is your goal?`),
        options: [
          { label: `${cyan('Self-host')}: use Happy on this machine`, value: 'selfhost' },
          { label: `${cyan('Development')}: worktrees + stacks + contributor workflows`, value: 'dev' },
        ],
        defaultIndex: 0,
      });
    });
  }
  if (!profile) {
    profile = 'selfhost';
  }

  const verbosity = getVerbosityLevel(process.env);
  const quietUi = interactive && verbosity === 0 && !json;

  function isInteractiveChildCommand({ rel, args }) {
    // If a child command needs to prompt the user, it must inherit stdin/stdout.
    // Otherwise setup's quiet mode will break the wizard (stdin is intentionally disabled).
    void rel;
    return args.some((a) => String(a).trim() === '--interactive');
  }

  async function runNodeScriptMaybeQuiet({ label, rel, args = [], env = process.env, interactiveChild = null }) {
    const childIsInteractive = interactiveChild ?? isInteractiveChildCommand({ rel, args });
    if (!quietUi || childIsInteractive) {
      await run(process.execPath, [join(rootDir, rel), ...args], { cwd: rootDir, env });
      return;
    }
    const baseLogDir = join(getHappyStacksHomeDir(process.env), 'logs', 'setup');
    const logPath = join(baseLogDir, `${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.${Date.now()}.log`);
    try {
      await runCommandLogged({
        label,
        cmd: process.execPath,
        args: [join(rootDir, rel), ...args],
        cwd: rootDir,
        env,
        logPath,
        quiet: true,
        showSteps: true,
      });
    } catch (e) {
      const lp = e?.logPath ? String(e.logPath) : logPath;
      // eslint-disable-next-line no-console
      console.error(`[setup] failed: ${label}`);
      // eslint-disable-next-line no-console
      console.error(`${dim('log:')} ${lp}`);
      throw e;
    }
  }

  function printProfileIntro({ profile }) {
    if (!process.stdout.isTTY || json) return;
    const header = profile === 'selfhost' ? `${cyan('Self-host')} setup` : `${cyan('Development')} setup`;
    const lines = [
      '',
      bold(header),
      profile === 'selfhost'
        ? dim('Run Happy locally (optionally with Tailscale + autostart).')
        : dim('Prepare a contributor workspace (components + worktrees + stacks).'),
      '',
      bold('What will happen:'),
      profile === 'selfhost'
        ? [
            `- ${cyan('init')}: set up Happy Stacks home + shims`,
            `- ${cyan('bootstrap')}: clone/install components`,
            `- ${cyan('start')}: (optional) start Happy now`,
            `- ${cyan('login')}: (optional) authenticate`,
          ]
        : [
            `- ${cyan('workspace')}: choose where components + worktrees live`,
            `- ${cyan('init')}: set up Happy Stacks home + shims`,
            `- ${cyan('bootstrap')}: clone/install components + dev tooling`,
            `- ${cyan('auth')}: (recommended) set up a ${cyan('dev-auth')} seed stack (login once, reuse everywhere)`,
            `- ${cyan('stacks')}: (recommended) create an isolated dev stack (keep main stable)`,
            `- ${cyan('mobile')}: (optional) install the iOS dev-client (for phone testing)`,
          ],
      '',
    ].flat();
    // eslint-disable-next-line no-console
    console.log(lines.join('\n'));
  }

  if (interactive) {
    printProfileIntro({ profile });
  }

  const platform = process.platform;
  const supportsAutostart = platform === 'darwin' || platform === 'linux';
  const supportsMenubar = platform === 'darwin';

  const serverFromArg = normalizeServerComponent(kv.get('--server'));
  let serverComponent = serverFromArg || normalizeServerComponent(process.env.HAPPY_STACKS_SERVER_COMPONENT) || 'happy-server-light';
  if (profile === 'selfhost' && interactive && !serverFromArg) {
    serverComponent = await withRl(async (rl) => {
      const picked = await promptSelect(rl, {
        title: `${bold('Server flavor')}\n${dim('Pick the backend you want to run locally. You can switch later.')}`,
        options: [
          { label: `happy-server-light (${green('recommended')}) — simplest local install (SQLite)`, value: 'happy-server-light' },
          { label: `happy-server — full server (Postgres/Redis/Minio via Docker)`, value: 'happy-server' },
        ],
        defaultIndex: serverComponent === 'happy-server' ? 1 : 0,
      });
      return picked;
    });
  }

  // Dev profile: pick where to store components + worktrees.
  const workspaceDirFlagRaw = (kv.get('--workspace-dir') ?? '').toString().trim();
  const homeDirForWorkspace = getHappyStacksHomeDir(process.env);
  let workspaceDirWanted = workspaceDirFlagRaw ? normalizeWorkspaceDirInput(workspaceDirFlagRaw, { homeDir: homeDirForWorkspace }) : '';
  if (profile === 'dev' && interactive && !workspaceDirWanted) {
    const defaultWorkspaceDir = resolveWorkspaceDirDefault();
    const suggested = defaultWorkspaceDir;
    const helpLines = [
      bold('Workspace location'),
      dim('This is where Happy Stacks will keep:'),
      `- ${dim('components')}: ${cyan(join(suggested, 'components'))}`,
      `- ${dim('worktrees')}:  ${cyan(join(suggested, 'components', '.worktrees'))}`,
      '',
      dim('Pick a stable folder that is easy to open in your editor (example: ~/Development/happy).'),
      '',
    ].join('\n');
    // eslint-disable-next-line no-console
    console.log(helpLines);
    const raw = await withRl(async (rl) => {
      return await prompt(rl, `Workspace dir (default: ${suggested}): `, { defaultValue: suggested });
    });
    workspaceDirWanted = normalizeWorkspaceDirInput(raw, { homeDir: homeDirForWorkspace });
  }
  if (profile === 'dev' && workspaceDirWanted) {
    // eslint-disable-next-line no-console
    console.log(`${dim('Workspace:')} ${cyan(workspaceDirWanted)}`);
  }

  const defaultTailscale = false;
  const defaultAutostart = false;
  const defaultMenubar = false;
  const defaultStartNow = profile === 'selfhost';
  const defaultInstallPath = false;

  let tailscaleWanted = boolFromFlags({ flags, onFlag: '--tailscale', offFlag: '--no-tailscale', defaultValue: defaultTailscale });
  let autostartWanted = boolFromFlags({ flags, onFlag: '--autostart', offFlag: '--no-autostart', defaultValue: defaultAutostart });
  let menubarWanted = boolFromFlags({ flags, onFlag: '--menubar', offFlag: '--no-menubar', defaultValue: defaultMenubar });
  let startNow = boolFromFlags({ flags, onFlag: '--start-now', offFlag: '--no-start-now', defaultValue: defaultStartNow });
  let installPath = flags.has('--install-path') ? true : defaultInstallPath;
  let authWanted = boolFromFlagsOrKv({
    flags,
    kv,
    onFlag: '--auth',
    offFlag: '--no-auth',
    key: '--auth',
    defaultValue: profile === 'selfhost',
  });

  if (interactive) {
    if (profile === 'selfhost') {
      tailscaleWanted = await withRl(async (rl) => {
        const v = await promptSelect(rl, {
          title: `${bold('Remote access')}\n${dim('Optional: use Tailscale Serve to get an HTTPS URL for Happy (secure, recommended for phone access).')}`,
          options: [
            { label: 'no (default)', value: false },
            { label: `yes (${green('recommended for phone')}) — enable Tailscale Serve`, value: true },
          ],
          defaultIndex: tailscaleWanted ? 1 : 0,
        });
        return v;
      });

      if (supportsAutostart) {
        autostartWanted = await withRl(async (rl) => {
          const v = await promptSelect(rl, {
            title: `${bold('Autostart')}\n${dim('Optional: start Happy automatically at login (launchd/systemd user service).')}`,
            options: [
              { label: 'no (default)', value: false },
              { label: 'yes', value: true },
            ],
            defaultIndex: autostartWanted ? 1 : 0,
          });
          return v;
        });
      } else {
        autostartWanted = false;
      }

      if (supportsMenubar) {
        menubarWanted = await withRl(async (rl) => {
          const v = await promptSelect(rl, {
            title: `${bold('Menu bar (macOS)')}\n${dim('Optional: install the SwiftBar menu to control stacks quickly.')}`,
            options: [
              { label: 'no (default)', value: false },
              { label: 'yes', value: true },
            ],
            defaultIndex: menubarWanted ? 1 : 0,
          });
          return v;
        });
      } else {
        menubarWanted = false;
      }

      startNow = await withRl(async (rl) => {
        const v = await promptSelect(rl, {
          title: `${bold('Start now')}\n${dim('Recommended: start Happy immediately so you can verify it works.')}`,
          options: [
            { label: 'yes (default)', value: true },
            { label: 'no', value: false },
          ],
          defaultIndex: startNow ? 0 : 1,
        });
        return v;
      });

      authWanted = await withRl(async (rl) => {
        const v = await promptSelect(rl, {
          title: `${bold('Authentication')}\n${dim('Recommended: login now so the daemon can register this machine and you can use Happy from other devices.')}`,
          options: [
            { label: `yes (${green('recommended')}) — login now`, value: true },
            { label: 'no — I will authenticate later', value: false },
          ],
          defaultIndex: authWanted ? 0 : 1,
        });
        return v;
      });

      // Auth requires the stack to be running; if you chose "authenticate now", implicitly start.
      if (authWanted) {
        startNow = true;
      }
    } else if (profile === 'dev') {
      // Dev profile: auth is handled later (after bootstrap) so we can offer the recommended
      // dev-auth seed stack flow (and optional mobile dev-client install).
    }

    installPath = await withRl(async (rl) => {
      const v = await promptSelect(rl, {
        title: bold('Shell PATH'),
        options: [
          { label: `no (default) — you can run via npx / full path`, value: false },
          { label: `yes — add ${cyan(join(getCanonicalHomeDir(), 'bin'))} to your PATH`, value: true },
        ],
        defaultIndex: installPath ? 1 : 0,
      });
      return v;
    });
  }

  // Enforce OS support gates even if flags were passed.
  if (!supportsAutostart) autostartWanted = false;
  if (!supportsMenubar) menubarWanted = false;

  const menubarMode = profile === 'selfhost' ? 'selfhost' : 'dev';

  const config = {
    profile,
    platform,
    interactive,
    serverComponent,
    authWanted,
    tailscaleWanted,
    autostartWanted,
    menubarWanted,
    startNow,
    installPath,
    runtimeDir: getRuntimeDir(),
  };
  if (json) {
    printResult({ json, data: config });
    return;
  }

  if (interactive && process.stdout.isTTY) {
    const summary = [
      '',
      bold('Ready to set up'),
      `${dim('Profile:')} ${cyan(profile)}`,
      ...(profile === 'dev' && workspaceDirWanted ? [`${dim('Workspace:')} ${cyan(workspaceDirWanted)}`] : []),
      ...(profile === 'selfhost' ? [`${dim('Server:')} ${cyan(serverComponent)}`] : []),
      '',
      bold('Press Enter to begin') + dim(' (or Ctrl+C to cancel).'),
    ].join('\n');
    // eslint-disable-next-line no-console
    console.log(summary);
    await withRl(async (rl) => {
      await prompt(rl, '', { defaultValue: '' });
    });
  }

  // 1) Ensure plumbing exists (runtime + shims + pointer env). Avoid auto-bootstrap here; setup drives bootstrap explicitly.
  await runNodeScriptMaybeQuiet({
    label: 'init happy-stacks home',
    rel: 'scripts/init.mjs',
    args: [
      '--no-bootstrap',
      ...(profile === 'dev' && workspaceDirWanted ? [`--workspace-dir=${workspaceDirWanted}`] : []),
      ...(installPath ? ['--install-path'] : []),
    ],
    env: { ...process.env, HAPPY_STACKS_SETUP_CHILD: '1' },
  });

  // 2) Persist profile defaults to stack env (server flavor, repo source, tailscale preference, menubar mode).
  await ensureSetupConfigPersisted({
    rootDir,
    profile,
    serverComponent,
    tailscaleWanted,
    menubarMode,
  });

  // 3) Bootstrap components. Selfhost defaults to upstream; dev defaults to existing bootstrap wizard (forks by default).
  if (profile === 'dev') {
    // Developer setup: keep the existing bootstrap wizard.
    await runNodeScriptMaybeQuiet({
      label: 'bootstrap components',
      rootDir,
      rel: 'scripts/install.mjs',
      args: ['--interactive'],
      interactiveChild: true,
    });

    if (interactive) {
      // Recommended: dev-auth seed stack setup (login once, reuse across stacks).
      await maybeConfigureAuthDefaults({ rootDir, profile, interactive });

      // Recommended: create an isolated dev stack (keeps main stable).
      const createStack = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: `${bold('Stacks')}\n${dim('Recommended: keep main stable by doing dev work in a dedicated stack.')}`,
          options: [
            { label: `yes (${green('recommended')}) — create a new development stack`, value: true },
            { label: `no — I will use ${cyan('main')} for now`, value: false },
          ],
          defaultIndex: 0,
        });
      });
      if (createStack) {
        await runNodeScriptMaybeQuiet({
          label: 'create dev stack',
          rootDir,
          rel: 'scripts/stack.mjs',
          args: ['new', '--interactive'],
          interactiveChild: true,
        });
      }

      // Optional: mobile dev-client install (macOS only).
      if (process.platform === 'darwin') {
        const installMobile = await withRl(async (rl) => {
          return await promptSelect(rl, {
            title: `${bold('Mobile (iOS)')}\n${dim('Optional: install the shared Happy Stacks dev-client app on your iPhone (install once, reuse across stacks).')}`,
            options: [
              { label: 'no (default)', value: false },
              { label: `yes — install iOS dev-client (${yellow('requires Xcode + CocoaPods')})`, value: true },
            ],
            defaultIndex: 0,
          });
        });
        if (installMobile) {
          await runNodeScriptMaybeQuiet({
            label: 'install iOS dev-client',
            rootDir,
            rel: 'scripts/mobile_dev_client.mjs',
            args: ['--install'],
          });
          // eslint-disable-next-line no-console
          console.log(dim(`Tip: run any stack with ${yellow('--mobile')} to get a QR code / deep link for your phone.`));
        }
      } else {
        // eslint-disable-next-line no-console
        console.log(dim(`Tip: iOS dev-client install is macOS-only. You can still use the web UI on mobile via Tailscale.`));
      }
    }
  } else {
    // Selfhost setup: run non-interactively and keep it simple.
    const repoFlag = serverComponent === 'happy-server-light' ? '--forks' : '--upstream';
    await runNodeScriptMaybeQuiet({
      label: 'bootstrap components',
      rootDir,
      rel: 'scripts/install.mjs',
      args: [`--server=${serverComponent}`, repoFlag],
    });
  }

  // 4) Optional: install autostart (macOS launchd / Linux systemd user).
  if (autostartWanted) {
    if (process.platform === 'linux') {
      const ok = await ensureSystemdAvailable();
      if (!ok) {
        // eslint-disable-next-line no-console
        console.log('[setup] autostart skipped: systemd user services not available on this Linux distro.');
      } else {
        await installService();
      }
    } else {
      await installService();
    }
  }

  // 5) Optional: install menubar assets (macOS only).
  if (menubarWanted && process.platform === 'darwin') {
    await runNodeScript({ rootDir, rel: 'scripts/menubar.mjs', args: ['install'] });
  }

  // 6) Optional: enable tailscale serve (best-effort).
  if (tailscaleWanted) {
    try {
      const internalPort = await resolveMainServerPort();
      const internalServerUrl = `http://127.0.0.1:${internalPort}`;
      const res = await tailscaleServeEnable({ internalServerUrl });
      if (res?.enableUrl && !res?.httpsUrl) {
        // eslint-disable-next-line no-console
        console.log('[setup] tailscale serve requires enabling in your tailnet. Open this URL to continue:');
        // eslint-disable-next-line no-console
        console.log(res.enableUrl);
        // Best-effort open
        await openUrlInBrowser(res.enableUrl).catch(() => {});
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[setup] tailscale not available. Install it from: https://tailscale.com/download');
      await openUrlInBrowser('https://tailscale.com/download').catch(() => {});
    }
  }

  // 7) Optional: start now (without requiring setup to keep running).
  if (startNow) {
    const port = await resolveMainServerPort();
    const internalServerUrl = `http://127.0.0.1:${port}`;

    if (!autostartWanted) {
      // Detached background start.
      await spawnDetachedNodeScript({ rootDir, rel: 'scripts/run.mjs', args: [] });
    }

    const ready = await waitForHappyHealthOk(internalServerUrl, { timeoutMs: 90_000 });
    if (!ready) {
      // eslint-disable-next-line no-console
      console.log(`[setup] started, but server did not become healthy yet: ${internalServerUrl}`);
    }

    // Prefer tailscale HTTPS URL if available.
    let openTarget = `http://localhost:${port}/`;
    if (tailscaleWanted) {
      const https = await tailscaleServeHttpsUrlForInternalServerUrl(internalServerUrl);
      if (https) {
        openTarget = https.replace(/\/+$/, '') + '/';
      }
    }

    // 8) Optional: auth login (runs interactive browser flow via happy-cli).
    if (authWanted) {
      const cliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
      const accessKey = join(cliHomeDir, 'access.key');
      if (existsSync(accessKey)) {
        // eslint-disable-next-line no-console
        console.log('[setup] auth: already configured (access.key exists)');
      } else {
        const env = {
          ...process.env,
          HAPPY_STACKS_SERVER_PORT: String(port),
          HAPPY_LOCAL_SERVER_PORT: String(port),
        };
        if (interactive) {
          await guidedStackAuthLoginNow({ rootDir, stackName: 'main', env });
        } else {
          await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['auth', 'main', '--', 'login'], env });
        }

        if (!existsSync(accessKey)) {
          // eslint-disable-next-line no-console
          console.log('[setup] auth: not completed yet (missing access.key). You can retry with: happys auth login');
        } else {
          // eslint-disable-next-line no-console
          console.log('[setup] auth: complete');
        }
      }
    } else {
      // eslint-disable-next-line no-console
      console.log('[setup] tip: when you are ready, authenticate with: happys auth login');
    }

    await openUrlInBrowser(openTarget).catch(() => {});
    // eslint-disable-next-line no-console
    console.log(`[setup] open: ${openTarget}`);
  }
  if (profile === 'selfhost' && authWanted && !startNow) {
    // eslint-disable-next-line no-console
    console.log('[setup] auth: skipped because Happy was not started. When ready:');
    // eslint-disable-next-line no-console
    console.log('  happys start');
    // eslint-disable-next-line no-console
    console.log('  happys auth login');
  }

  // Final tips (keep short).
  if (profile === 'selfhost') {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(green('✓ Setup complete'));
    // eslint-disable-next-line no-console
    console.log(dim('Useful commands:'));
    // eslint-disable-next-line no-console
    console.log('  happys start');
    // eslint-disable-next-line no-console
    console.log('  happys tailscale enable');
    // eslint-disable-next-line no-console
    console.log('  happys service install   # macOS/Linux autostart');
  } else {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(green('✓ Setup complete'));
    // eslint-disable-next-line no-console
    console.log(dim('Useful commands:'));
    // eslint-disable-next-line no-console
    console.log('  happys dev');
    // eslint-disable-next-line no-console
    console.log('  happys wt ...');
    // eslint-disable-next-line no-console
    console.log('  happys stack ...');
  }
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  await cmdSetup({ rootDir, argv });
}

main().catch((err) => {
  console.error('[setup] failed:', err);
  process.exit(1);
});
