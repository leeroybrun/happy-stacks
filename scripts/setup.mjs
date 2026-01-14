import './utils/env.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths.mjs';
import { isTty, promptSelect, withRl } from './utils/wizard.mjs';
import { ensureEnvLocalUpdated } from './utils/env_local.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { fetchHappyHealth } from './utils/server.mjs';
import { tailscaleServeEnable, tailscaleServeHttpsUrlForInternalServerUrl } from './tailscale.mjs';
import { getRuntimeDir } from './utils/runtime.mjs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { parseDotenv } from './utils/dotenv.mjs';
import { installService } from './service.mjs';

function boolFromFlagsOrKv({ flags, kv, onFlag, offFlag, key, defaultValue }) {
  if (flags.has(offFlag)) return false;
  if (flags.has(onFlag)) return true;
  if (key && kv.has(key)) {
    const raw = String(kv.get(key) ?? '').trim().toLowerCase();
    if (raw === '1' || raw === 'true' || raw === 'yes' || raw === 'y') return true;
    if (raw === '0' || raw === 'false' || raw === 'no' || raw === 'n') return false;
  }
  return defaultValue;
}

function normalizeProfile(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host' || v === 'host') return 'selfhost';
  if (v === 'dev' || v === 'developer' || v === 'develop') return 'dev';
  return '';
}

function normalizeServer(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'light' || v === 'server-light' || v === 'happy-server-light') return 'happy-server-light';
  if (v === 'server' || v === 'full' || v === 'happy-server') return 'happy-server';
  return '';
}

function boolFromFlags({ flags, onFlag, offFlag, defaultValue }) {
  if (flags.has(offFlag)) return false;
  if (flags.has(onFlag)) return true;
  return defaultValue;
}

async function commandExists(cmd) {
  try {
    const out = (await runCapture('sh', ['-lc', `command -v ${cmd} >/dev/null 2>&1 && echo yes || echo no`])).trim();
    return out === 'yes';
  } catch {
    return false;
  }
}

async function openUrl(url) {
  const u = String(url ?? '').trim();
  if (!u) return false;
  if (process.platform === 'darwin') {
    await run('open', [u]).catch(() => {});
    return true;
  }
  if (process.platform === 'linux') {
    if (await commandExists('xdg-open')) {
      await run('xdg-open', [u]).catch(() => {});
      return true;
    }
    return false;
  }
  return false;
}

async function waitForHealthOk(internalServerUrl, { timeoutMs = 60_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const health = await fetchHappyHealth(internalServerUrl);
    if (health.ok) {
      return true;
    }
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

function parseEnvFileText(text) {
  try {
    return parseDotenv(text ?? '');
  } catch {
    return new Map();
  }
}

async function readEnvValueFromFile(envPath, key) {
  try {
    if (!envPath || !existsSync(envPath)) return '';
    const raw = await readFile(envPath, 'utf-8');
    const parsed = parseEnvFileText(raw);
    return (parsed.get(key) ?? '').trim();
  } catch {
    return '';
  }
}

async function resolveMainServerPort() {
  // Priority:
  // - explicit env var
  // - main stack env file (preferred)
  // - default
  const fromEnv =
    (process.env.HAPPY_LOCAL_SERVER_PORT ?? process.env.HAPPY_STACKS_SERVER_PORT ?? '').toString().trim();
  if (fromEnv) {
    const n = Number(fromEnv);
    return Number.isFinite(n) && n > 0 ? n : 3005;
  }
  const envPath = resolveStackEnvPath('main').envPath;
  const v =
    (await readEnvValueFromFile(envPath, 'HAPPY_LOCAL_SERVER_PORT')) ||
    (await readEnvValueFromFile(envPath, 'HAPPY_STACKS_SERVER_PORT')) ||
    '';
  if (v) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : 3005;
  }
  return 3005;
}

async function ensureSetupConfigPersisted({ rootDir, profile, serverComponent, tailscaleWanted, menubarMode }) {
  const updates = [
    { key: 'HAPPY_STACKS_SERVER_COMPONENT', value: serverComponent },
    { key: 'HAPPY_LOCAL_SERVER_COMPONENT', value: serverComponent },
    // Default for selfhost: upstream.
    ...(profile === 'selfhost'
      ? [
          { key: 'HAPPY_STACKS_REPO_SOURCE', value: 'upstream' },
          { key: 'HAPPY_LOCAL_REPO_SOURCE', value: 'upstream' },
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

async function cmdSetup({ rootDir, argv }) {
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
        '  happys setup --auth',
        '  happys setup --no-auth',
        '',
        'notes:',
        '  - selfhost profile is a guided installer for running Happy locally (optionally with Tailscale + autostart).',
        '  - dev profile prepares a development workspace (bootstrap wizard + optional dev tooling).',
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

  const serverFromArg = normalizeServer(kv.get('--server'));
  let serverComponent = serverFromArg || normalizeServer(process.env.HAPPY_STACKS_SERVER_COMPONENT) || 'happy-server-light';
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
        title: `Add ${join(homedir(), '.happy-stacks', 'bin')} to your shell PATH?`,
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

      // Optional: import existing non-stacks Happy credentials into Happy Stacks main.
      // This helps maintainers who already have a Happy account on their machine avoid a fresh login.
      //
      // Source (legacy): ~/.happy/cli/access.key
      // Target (Happy Stacks main): ~/.happy/stacks/main/cli/access.key (or legacy base dir if not migrated)
      try {
        const legacyAccessKey = join(homedir(), '.happy', 'cli', 'access.key');
        const mainCliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
        const mainAccessKey = join(mainCliHomeDir, 'access.key');

        if (existsSync(legacyAccessKey) && !existsSync(mainAccessKey)) {
          const doImport = await withRl(async (rl) => {
            return await promptSelect(rl, {
              title: 'Found an existing Happy install at ~/.happy. Import its credentials into Happy Stacks main?',
              options: [
                { label: 'yes (recommended)', value: true },
                { label: 'no', value: false },
              ],
              defaultIndex: 0,
            });
          });
          if (doImport) {
            // Best-effort: also tries to seed DB account rows if the legacy local DB exists.
            await runNodeScript({ rootDir, rel: 'scripts/auth.mjs', args: ['copy-from', 'legacy', '--allow-main'] });
          }
        }
      } catch {
        // ignore
      }

      // Optional: set up a dedicated dev auth seed stack.
      // This makes future stacks able to auto-seed auth without re-login.
      const setupDevAuth = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: 'Set up a dedicated auth seed stack (dev-auth) for development stacks?',
          options: [
            { label: 'no (default)', value: false },
            { label: 'yes', value: true },
          ],
          defaultIndex: 0,
        });
      });
      if (setupDevAuth) {
        await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['create-dev-auth-seed', 'dev-auth'] });
      }
    }
  } else {
    // Selfhost setup: run non-interactively and keep it simple.
    await runNodeScript({
      rootDir,
      rel: 'scripts/install.mjs',
      args: [`--server=${serverComponent}`, '--upstream'],
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
        await openUrl(res.enableUrl);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.log('[setup] tailscale not available. Install it from: https://tailscale.com/download');
      await openUrl('https://tailscale.com/download');
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

    const ready = await waitForHealthOk(internalServerUrl, { timeoutMs: 90_000 });
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
      await runNodeScript({ rootDir, rel: 'scripts/auth.mjs', args: ['login', `--context=${ctx}`] });

      const cliHomeDir = mainCliHomeDirForEnvPath(resolveStackEnvPath('main').envPath);
      const accessKey = join(cliHomeDir, 'access.key');
      if (!existsSync(accessKey)) {
        // eslint-disable-next-line no-console
        console.log('[setup] auth: not completed yet (missing access.key). You can retry with: happys auth login');
      } else {
        // eslint-disable-next-line no-console
        console.log('[setup] auth: complete');
      }
    } else {
      // eslint-disable-next-line no-console
      console.log('[setup] tip: when you are ready, authenticate with: happys auth login');
    }

    await openUrl(openTarget);
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

