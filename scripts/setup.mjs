import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { isTty, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { getCanonicalHomeDir } from './utils/env/config.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { waitForHappyHealthOk } from './utils/server/server.mjs';
import { tailscaleServeEnable, tailscaleServeHttpsUrlForInternalServerUrl } from './tailscale.mjs';
import { getRuntimeDir } from './utils/paths/runtime.mjs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { installService } from './service.mjs';
import { getDevAuthKeyPath } from './utils/auth/dev_key.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { boolFromFlags, boolFromFlagsOrKv } from './utils/cli/flags.mjs';
import { normalizeProfile, normalizeServerComponent } from './utils/cli/normalize.mjs';
import { openUrlInBrowser } from './utils/ui/browser.mjs';
import { commandExists } from './utils/proc/commands.mjs';
import { readEnvValueFromFile } from './utils/env/read.mjs';
import { readServerPortFromEnvFile, resolveServerPortFromEnv } from './utils/server/port.mjs';
import { guidedStackWebSignupThenLogin } from './utils/auth/guided_stack_web_login.mjs';

async function resolveMainWebappUrlForAuth({ rootDir, port }) {
  try {
    const raw = await runCapture(process.execPath, [join(rootDir, 'scripts', 'auth.mjs'), 'login', '--print', '--json'], {
      cwd: rootDir,
      env: {
        ...process.env,
        HAPPY_STACKS_SERVER_PORT: String(port),
        HAPPY_LOCAL_SERVER_PORT: String(port),
      },
    });
    const parsed = JSON.parse(String(raw ?? '').trim());
    const cmd = typeof parsed?.cmd === 'string' ? parsed.cmd : '';
    const m = cmd.match(/HAPPY_WEBAPP_URL="([^"]+)"/);
    return m?.[1] ? String(m[1]) : '';
  } catch {
    return '';
  }
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

  const sources = detectAuthSources();

  // 1) Dev key reuse (preferred: reuse if present).
  if (sources.hasDevKey) {
    // eslint-disable-next-line no-console
    console.log(`[setup] dev-key: detected (${sources.devKeyPath})`);
    const choice = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title:
          'A dev key is already configured on this machine. Reuse it? (recommended for restoring the UI account)',
        options: [
          { label: 'yes (default) — keep using the existing dev key', value: 'reuse' },
          { label: 'print it now (will display a secret key)', value: 'print' },
          { label: 'skip', value: 'skip' },
        ],
        defaultIndex: 0,
      });
    });
    if (choice === 'print') {
      // eslint-disable-next-line no-console
      console.log('[setup] dev-key: printing (sensitive)');
      await runNodeScript({ rootDir, rel: 'scripts/auth.mjs', args: ['dev-key', '--print'] });
    }
  } else if (profile === 'dev') {
    // No dev key: offer to create a dedicated seed stack, which guides generating/saving one.
    const create = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'No dev key found. Create one now via a dedicated dev-auth seed stack?',
        options: [
          { label: 'yes (recommended)', value: true },
          { label: 'no', value: false },
        ],
        defaultIndex: 0,
      });
    });
    if (create) {
      await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['create-dev-auth-seed', 'dev-auth'] });
    }
  }

  // 2) Default auth seeding source for NEW stacks (ordering requested):
  // - prefer dev-auth if we have a dev key (or dev-auth is already set up)
  // - else prefer main happy-stacks (if authenticated)
  // - else prefer legacy ~/.happy (if present)
  const opts = [];
  if (sources.hasDevKey && sources.hasDevAuthAccessKey) {
    opts.push({ label: 'use dev-auth seed stack (recommended)', value: 'dev-auth' });
  }
  if (!sources.hasDevAuthAccessKey && sources.hasDevKey && existsSync(resolveStackEnvPath('dev-auth').envPath)) {
    opts.push({ label: 'use dev-auth seed stack (exists but not authenticated yet)', value: 'dev-auth' });
  }
  if (sources.hasMainAccessKey) {
    opts.push({ label: 'use Happy Stacks main (copy/symlink from main stack)', value: 'main' });
  }
  if (sources.hasLegacyAccessKey) {
    opts.push({ label: 'use legacy ~/.happy (best-effort)', value: 'legacy' });
  }
  opts.push({ label: 'disable auto-seeding (I will login per stack)', value: 'off' });

  const defaultSeed = opts[0]?.value ?? 'off';
  const seedChoice = await withRl(async (rl) => {
    return await promptSelect(rl, {
      title: 'Default auth source for new stacks (so PR stacks can work without re-login)?',
      options: opts,
      defaultIndex: Math.max(0, opts.findIndex((o) => o.value === defaultSeed)),
    });
  });

  if (seedChoice === 'off') {
    await ensureEnvLocalUpdated({
      rootDir,
      updates: [
        { key: 'HAPPY_STACKS_AUTO_AUTH_SEED', value: '0' },
        { key: 'HAPPY_LOCAL_AUTO_AUTH_SEED', value: '0' },
      ],
    });
    return;
  }

  // Symlink vs copy for seeded stacks (preferred: symlink so credentials stay up to date).
  const linkChoice = await withRl(async (rl) => {
    return await promptSelect(rl, {
      title: 'When seeding auth into stacks, reuse credentials via symlink or copy?',
      options: [
        { label: 'reuse (recommended) — symlink so it stays up to date', value: 'link' },
        { label: 'copy — more isolated per stack', value: 'copy' },
      ],
      defaultIndex: 0,
    });
  });

  await ensureEnvLocalUpdated({
    rootDir,
    updates: [
      { key: 'HAPPY_STACKS_AUTO_AUTH_SEED', value: '1' },
      { key: 'HAPPY_LOCAL_AUTO_AUTH_SEED', value: '1' },
      { key: 'HAPPY_STACKS_AUTH_SEED_FROM', value: String(seedChoice) },
      { key: 'HAPPY_LOCAL_AUTH_SEED_FROM', value: String(seedChoice) },
      { key: 'HAPPY_STACKS_AUTH_LINK', value: linkChoice === 'link' ? '1' : '0' },
      { key: 'HAPPY_LOCAL_AUTH_LINK', value: linkChoice === 'link' ? '1' : '0' },
    ],
  });
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
        '  happys setup pr --happy=<pr-url|number> [--happy-cli=<pr-url|number>]',
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
        title: 'What is your goal?',
        options: [
          { label: 'Use Happy on this machine (self-host)', value: 'selfhost' },
          { label: 'Develop Happy (worktrees/stacks)', value: 'dev' },
        ],
        defaultIndex: 0,
      });
    });
  }
  if (!profile) {
    profile = 'selfhost';
  }

  const platform = process.platform;
  const supportsAutostart = platform === 'darwin' || platform === 'linux';
  const supportsMenubar = platform === 'darwin';

  const serverFromArg = normalizeServerComponent(kv.get('--server'));
  let serverComponent = serverFromArg || normalizeServerComponent(process.env.HAPPY_STACKS_SERVER_COMPONENT) || 'happy-server-light';
  if (profile === 'selfhost' && interactive && !serverFromArg) {
    serverComponent = await withRl(async (rl) => {
      const picked = await promptSelect(rl, {
        title: 'Select server flavor:',
        options: [
          { label: 'happy-server-light (recommended; simplest local install)', value: 'happy-server-light' },
          { label: 'happy-server (full server; managed infra via Docker)', value: 'happy-server' },
        ],
        defaultIndex: serverComponent === 'happy-server' ? 1 : 0,
      });
      return picked;
    });
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
          title: 'Enable remote access with Tailscale Serve (recommended for mobile)?',
          options: [
            { label: 'no (default)', value: false },
            { label: 'yes', value: true },
          ],
          defaultIndex: tailscaleWanted ? 1 : 0,
        });
        return v;
      });

      if (supportsAutostart) {
        autostartWanted = await withRl(async (rl) => {
          const v = await promptSelect(rl, {
            title: 'Enable autostart at login?',
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
            title: 'Install the macOS menubar (SwiftBar) control panel?',
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
          title: 'Start Happy now?',
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
          title: 'Authenticate now? (recommended)',
          options: [
            { label: 'yes (default) — enables Happy UI + mobile access', value: true },
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
      // In dev profile, we don't assume you want to run anything immediately.
      // If you choose to auth now, we’ll also start Happy in the background so login can complete.
      const authNow = await withRl(async (rl) => {
        const v = await promptSelect(rl, {
          title: 'Complete authentication now? (optional)',
          options: [
            { label: 'no (default) — I will do this later', value: false },
            { label: 'yes — start Happy in background and login', value: true },
          ],
          defaultIndex: 0,
        });
        return v;
      });
      authWanted = authNow;
      if (authNow) {
        startNow = true;
      }
    }

    installPath = await withRl(async (rl) => {
      const v = await promptSelect(rl, {
        title: `Add ${join(getCanonicalHomeDir(), 'bin')} to your shell PATH?`,
        options: [
          { label: 'no (default)', value: false },
          { label: 'yes', value: true },
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

  // 1) Ensure plumbing exists (runtime + shims + pointer env). Avoid auto-bootstrap here; setup drives bootstrap explicitly.
  await runNodeScript({
    rootDir,
    rel: 'scripts/init.mjs',
    args: [
      '--no-bootstrap',
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
    await runNodeScript({ rootDir, rel: 'scripts/install.mjs', args: ['--interactive'] });

    // Optional: offer to create a dedicated dev stack (keeps main stable).
    if (interactive) {
      const createStack = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: 'Create an additional isolated stack for development?',
          options: [
            { label: 'no (default)', value: false },
            { label: 'yes', value: true },
          ],
          defaultIndex: 0,
        });
      });
      if (createStack) {
        await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['new', '--interactive'] });
      }

      // Guided maintainer-friendly auth defaults (dev key → main → legacy).
      await maybeConfigureAuthDefaults({ rootDir, profile, interactive });
    }
  } else {
    // Selfhost setup: run non-interactively and keep it simple.
    const repoFlag = serverComponent === 'happy-server-light' ? '--forks' : '--upstream';
    await runNodeScript({
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
      const ctx = profile === 'selfhost' ? 'selfhost' : 'dev';
      const cliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
      const accessKey = join(cliHomeDir, 'access.key');
      if (existsSync(accessKey)) {
        // eslint-disable-next-line no-console
        console.log('[setup] auth: already configured (access.key exists)');
      } else {
        if (interactive) {
          const webappUrl = await resolveMainWebappUrlForAuth({ rootDir, port });
          await guidedStackWebSignupThenLogin({ webappUrl, stackName: 'main' });
        }
        await runNodeScript({
          rootDir,
          rel: 'scripts/auth.mjs',
          args: ['login', `--context=${ctx}`, '--quiet'],
          env: {
            ...process.env,
            HAPPY_STACKS_SERVER_PORT: String(port),
            HAPPY_LOCAL_SERVER_PORT: String(port),
          },
        });

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
  if (authWanted && !startNow) {
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
    console.log('[setup] done. Useful commands:');
    // eslint-disable-next-line no-console
    console.log('  happys start');
    // eslint-disable-next-line no-console
    console.log('  happys tailscale enable');
    // eslint-disable-next-line no-console
    console.log('  happys service install   # macOS/Linux autostart');
  } else {
    // eslint-disable-next-line no-console
    console.log('[setup] done. Useful commands:');
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

