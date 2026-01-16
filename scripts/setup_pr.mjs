import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { isTty } from './utils/cli/wizard.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { runCommandLogged } from './utils/cli/progress.mjs';
import { decidePrAuthPlan } from './utils/auth/guided_pr_auth.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { run } from './utils/proc/proc.mjs';
import { isSandboxed } from './utils/env/sandbox.mjs';
import { parseGithubPullRequest } from './utils/git/refs.mjs';
import { sanitizeStackName } from './utils/stack/names.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

function inferStackNameFromPrArgs({ happy, happyCli, server, serverLight }) {
  const parts = [];
  const hn = parseGithubPullRequest(happy)?.number ?? null;
  const cn = parseGithubPullRequest(happyCli)?.number ?? null;
  const sn = parseGithubPullRequest(server)?.number ?? null;
  const sln = parseGithubPullRequest(serverLight)?.number ?? null;
  if (hn) parts.push(`happy${hn}`);
  if (cn) parts.push(`cli${cn}`);
  if (sn) parts.push(`server${sn}`);
  if (sln) parts.push(`light${sln}`);
  return sanitizeStackName(parts.length ? `pr-${parts.join('-')}` : 'pr', { fallback: 'pr', maxLen: 64 });
}

function detectBestAuthSource() {
  const devAuthEnvExists = existsSync(resolveStackEnvPath('dev-auth').envPath);
  const devAuthAccessKey = join(resolveStackEnvPath('dev-auth').baseDir, 'cli', 'access.key');
  const mainAccessKey = join(resolveStackEnvPath('main').baseDir, 'cli', 'access.key');

  const hasDevAuth = devAuthEnvExists && existsSync(devAuthAccessKey);
  const hasMain = existsSync(mainAccessKey);

  if (hasDevAuth) return { from: 'dev-auth', hasAny: true };
  if (hasMain) return { from: 'main', hasAny: true };
  return { from: 'main', hasAny: false };
}

function detectLinkDefault() {
  const rawLink = (process.env.HAPPY_STACKS_AUTH_LINK ?? process.env.HAPPY_LOCAL_AUTH_LINK ?? '').toString().trim();
  if (rawLink) return rawLink !== '0';
  const rawMode = (process.env.HAPPY_STACKS_AUTH_MODE ?? process.env.HAPPY_LOCAL_AUTH_MODE ?? '').toString().trim().toLowerCase();
  if (rawMode) return rawMode === 'link';
  // Default for setup-pr: prefer reuse/symlink to avoid stale creds and reduce re-login friction.
  return true;
}

async function runNodeScript({ rootDir, rel, args = [], env = process.env }) {
  await run(process.execPath, [join(rootDir, rel), ...args], { cwd: rootDir, env });
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argvRaw = process.argv.slice(2);
  const sep = argvRaw.indexOf('--');
  const argv = sep >= 0 ? argvRaw.slice(0, sep) : argvRaw;
  const forwarded = sep >= 0 ? argvRaw.slice(sep + 1) : [];

  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const interactive = isTty() && !json;
  const verbosity = getVerbosityLevel(process.env);
  const quietUi = interactive && verbosity === 0;

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'happys setup-pr --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--happy-server=<pr-url|number>|--happy-server-light=<pr-url|number>] [--name=<stack>] [--dev|--start] [--mobile] [--seed-auth|--no-seed-auth] [--copy-auth-from=<stack>] [--link-auth|--copy-auth] [--update] [--force] [--json] [-- <stack dev/start args...>]',
      },
      text: [
        '[setup-pr] usage:',
        '  happys setup-pr --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--dev]',
        '  happys setup pr --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--dev]   # alias',
        '',
        'What it does (idempotent):',
        '- ensures happy-stacks home exists (init)',
        '- bootstraps/clones missing components (upstream by default)',
        '- creates or reuses a PR stack and checks out PR worktrees',
        '- optionally seeds auth (best available source: dev-auth → main)',
        '- starts the stack (dev by default)',
        '',
        'Updating when the PR changes:',
        '- re-run the same command; it will fast-forward PR worktrees when possible',
        '- if the PR was force-pushed, add --force',
        '',
        'example:',
        '  happys setup-pr \\',
        '    --happy=https://github.com/slopus/happy/pull/123 \\',
        '    --happy-cli=https://github.com/slopus/happy-cli/pull/456',
      ].join('\n'),
    });
    return;
  }

  const prHappy = (kv.get('--happy') ?? '').trim();
  const prCli = (kv.get('--happy-cli') ?? '').trim();
  const prServer = (kv.get('--happy-server') ?? '').trim();
  const prServerLight = (kv.get('--happy-server-light') ?? '').trim();
  if (!prHappy && !prCli && !prServer && !prServerLight) {
    throw new Error('[setup-pr] missing PR inputs. Provide at least one of: --happy, --happy-cli, --happy-server, --happy-server-light');
  }
  if (prServer && prServerLight) {
    throw new Error('[setup-pr] cannot specify both --happy-server and --happy-server-light');
  }

  const wantsDev = flags.has('--dev') || (!flags.has('--start') && !flags.has('--prod'));
  const wantsStart = flags.has('--start') || flags.has('--prod');
  if (wantsDev && wantsStart) {
    throw new Error('[setup-pr] choose either --dev or --start (not both)');
  }
  const wantsMobile = flags.has('--mobile') || flags.has('--with-mobile');

  const stackNameRaw = (kv.get('--name') ?? '').trim();
  const stackName = stackNameRaw ? sanitizeStackName(stackNameRaw) : inferStackNameFromPrArgs({ happy: prHappy, happyCli: prCli, server: prServer, serverLight: prServerLight });

  // Determine server flavor for bootstrap and stack creation.
  const serverComponent = (kv.get('--server') ?? '').trim() || (prServer ? 'happy-server' : 'happy-server-light');
  const bootstrapServer = prServer || serverComponent === 'happy-server' ? 'both' : 'happy-server-light';

  // Auth defaults (avoid prompts; setup-pr should be low-friction).
  // Note: these may be updated below (sandbox prompt), so keep them mutable.
  let seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  let authFrom = (kv.get('--copy-auth-from') ?? '').trim();
  let linkAuth = flags.has('--link-auth') ? true : flags.has('--copy-auth') ? false : null;

  // Disallow "legacy" auth seeding in setup-pr flows:
  // We can't reliably seed local DB Account rows from a remote/production Happy install,
  // so this leads to broken stacks. Use guided login instead.
  if (authFrom && authFrom.toLowerCase() === 'legacy') {
    throw new Error('[setup-pr] --copy-auth-from=legacy is not supported. Use guided login (no seeding) instead.');
  }

  // Re-read flags after optional prompt mutation.
  seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  authFrom = (kv.get('--copy-auth-from') ?? '').trim();
  linkAuth = flags.has('--link-auth') ? true : flags.has('--copy-auth') ? false : null;

  // If this PR stack already has credentials, do not prompt or override it.
  const stackAlreadyAuthed = (() => {
    try {
      const { baseDir, envPath } = resolveStackEnvPath(stackName);
      if (!existsSync(envPath)) return false;
      return existsSync(join(baseDir, 'cli', 'access.key'));
    } catch {
      return false;
    }
  })();

  // Centralized guided auth decision (prompt early, before noisy install logs).
  // In non-sandbox mode we still guide: offer reusing dev-auth/main first, otherwise guided login.
  const plan = stackAlreadyAuthed
    ? { mode: 'existing' }
    : await decidePrAuthPlan({
        interactive,
        seedAuthFlag,
        explicitFrom: authFrom,
        defaultLoginNow: true,
      });

  const best = detectBestAuthSource();
  const effectiveSeedAuth =
    plan.mode === 'existing'
      ? false
      : plan.mode === 'seed'
        ? true
        : plan.mode === 'login'
          ? false
          : seedAuthFlag != null
            ? seedAuthFlag
            : best.hasAny;
  const effectiveAuthFrom = plan.mode === 'seed' ? plan.from : authFrom || best.from;
  const effectiveLinkAuth = plan.mode === 'seed' ? Boolean(plan.link) : linkAuth != null ? linkAuth : detectLinkDefault();

  // If we're going to guide the user through login, start in background first (even in verbose mode)
  // so auth prompts aren't buried in runner logs.
  const needsAuthFlow = interactive && !stackAlreadyAuthed && !effectiveSeedAuth && plan.mode === 'login' && plan.loginNow;

  // 1) Ensure happy-stacks home is initialized (idempotent).
  // 2) Bootstrap component repos and deps (idempotent; clones only if missing).
  if (quietUi) {
    const baseLogDir = join(process.env.HAPPY_STACKS_HOME_DIR ?? join(homedir(), '.happy-stacks'), 'logs', 'setup-pr');
    const initLog = join(baseLogDir, `init.${Date.now()}.log`);
    const installLog = join(baseLogDir, `install.${Date.now()}.log`);
    try {
      await runCommandLogged({
        label: 'init happy-stacks home',
        cmd: process.execPath,
        args: [join(rootDir, 'scripts', 'init.mjs'), '--no-bootstrap'],
        cwd: rootDir,
        env: process.env,
        logPath: initLog,
        quiet: true,
        showSteps: true,
      });
      await runCommandLogged({
        label: 'install/clone components',
        cmd: process.execPath,
        args: [join(rootDir, 'scripts', 'install.mjs'), '--upstream', '--clone', `--server=${bootstrapServer}`],
        cwd: rootDir,
        env: process.env,
        logPath: installLog,
        quiet: true,
        showSteps: true,
      });
    } catch (e) {
      const logPath = e?.logPath ? String(e.logPath) : null;
      console.error('[setup-pr] failed during setup.');
      if (logPath) {
        console.error(`[setup-pr] log: ${logPath}`);
      }
      if (e?.stderr) {
        console.error(String(e.stderr).trim());
      } else if (e instanceof Error) {
        console.error(e.message);
      } else {
        console.error(String(e));
      }
      process.exit(1);
    }
  } else {
    await runNodeScript({ rootDir, rel: 'scripts/init.mjs', args: ['--no-bootstrap'] });
    await runNodeScript({ rootDir, rel: 'scripts/install.mjs', args: ['--upstream', '--clone', `--server=${bootstrapServer}`] });
  }

  // 3) Create/reuse the PR stack and wire worktrees.
  if (quietUi) {
    // eslint-disable-next-line no-console
    console.log('- [..] start PR stack (logs follow)');
  }
  const stackArgs = [
    'stack',
    'pr',
    stackName,
    ...(prHappy ? [`--happy=${prHappy}`] : []),
    ...(prCli ? [`--happy-cli=${prCli}`] : []),
    ...(prServer ? [`--happy-server=${prServer}`] : []),
    ...(prServerLight ? [`--happy-server-light=${prServerLight}`] : []),
    `--server=${serverComponent}`,
    '--reuse',
    ...(flags.has('--update') ? ['--update'] : []),
    ...(flags.has('--force') ? ['--force'] : []),
    ...(effectiveSeedAuth ? ['--seed-auth', `--copy-auth-from=${effectiveAuthFrom}`, ...(effectiveLinkAuth ? ['--link-auth'] : [])] : ['--no-seed-auth']),
    ...(wantsDev ? ['--dev'] : ['--start']),
    ...(wantsMobile ? ['--mobile'] : []),
    ...(((quietUi && !json) || needsAuthFlow) ? ['--background'] : []),
    ...(json ? ['--json'] : []),
  ];
  if (forwarded.length) {
    stackArgs.push('--', ...forwarded);
  }
  await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: stackArgs });

  // Guided auth flow:
  // If the user chose "login now", we start in background (quiet mode) then perform login in the foreground.
  // Sandbox: keep this process alive so review-pr can clean up on exit.
  // Non-sandbox: after login, restart dev/start in the foreground so logs follow as usual.
  if (needsAuthFlow) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`[setup-pr] auth: starting guided login for stack "${stackName}"...`);
    await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: ['auth', stackName, '--', 'login'] });

    if (isSandboxed()) {
      // Fall through to sandbox keepalive below.
    }

    // Re-attach logs in the foreground for the chosen mode.
    const restartArgs = [
      wantsDev ? 'dev' : 'start',
      stackName,
      '--restart',
      ...(wantsMobile ? ['--mobile'] : []),
      ...(forwarded.length ? ['--', ...forwarded] : []),
    ];
    // If the user explicitly asked for verbose, reattach; otherwise keep things quiet.
    if (verbosity > 0) {
      await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: restartArgs });
    }
  }

  // Sandbox: keep this process alive so review-pr stays running and can clean up on exit.
  // The stack runner continues in the background; `review-pr` will stop it on Ctrl+C.
  if (isSandboxed() && interactive && !json) {
    await new Promise((resolvePromise) => {
      const onSig = () => resolvePromise();
      process.on('SIGINT', onSig);
      process.on('SIGTERM', onSig);
    });
  }
}

main().catch((err) => {
  console.error('[setup-pr] failed:', err);
  process.exit(1);
});

