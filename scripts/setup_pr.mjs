import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths/paths.mjs';
import { run } from './utils/proc/proc.mjs';
import { isSandboxed, sandboxAllowsGlobalSideEffects } from './utils/env/sandbox.mjs';
import { parseGithubPullRequest } from './utils/git/refs.mjs';
import { sanitizeStackName } from './utils/stack/names.mjs';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
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
  const allowGlobal = sandboxAllowsGlobalSideEffects();
  const legacyAccessKey = join(homedir(), '.happy', 'cli', 'access.key');

  const hasDevAuth = devAuthEnvExists && existsSync(devAuthAccessKey);
  const hasMain = existsSync(mainAccessKey);
  const hasLegacy = (!isSandboxed() || allowGlobal) && existsSync(legacyAccessKey);

  if (hasDevAuth) return { from: 'dev-auth', hasAny: true };
  if (hasMain) return { from: 'main', hasAny: true };
  if (hasLegacy) return { from: 'legacy', hasAny: true };
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

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: {
        usage:
          'happys setup-pr --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--happy-server=<pr-url|number>|--happy-server-light=<pr-url|number>] [--name=<stack>] [--dev|--start] [--seed-auth|--no-seed-auth] [--copy-auth-from=<stack|legacy>] [--link-auth|--copy-auth] [--update] [--force] [--json] [-- <stack dev/start args...>]',
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
        '- optionally seeds auth (best available source: dev-auth → main → legacy)',
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

  const stackNameRaw = (kv.get('--name') ?? '').trim();
  const stackName = stackNameRaw ? sanitizeStackName(stackNameRaw) : inferStackNameFromPrArgs({ happy: prHappy, happyCli: prCli, server: prServer, serverLight: prServerLight });

  // Determine server flavor for bootstrap and stack creation.
  const serverComponent = (kv.get('--server') ?? '').trim() || (prServer ? 'happy-server' : 'happy-server-light');
  const bootstrapServer = prServer || serverComponent === 'happy-server' ? 'both' : 'happy-server-light';

  // Auth defaults (avoid prompts; setup-pr should be low-friction).
  const seedAuthFlag = flags.has('--seed-auth') ? true : flags.has('--no-seed-auth') ? false : null;
  const authFrom = (kv.get('--copy-auth-from') ?? '').trim();
  const linkAuth = flags.has('--link-auth') ? true : flags.has('--copy-auth') ? false : null;

  const best = detectBestAuthSource();
  const effectiveSeedAuth = seedAuthFlag != null ? seedAuthFlag : best.hasAny;
  const effectiveAuthFrom = authFrom || best.from;
  const effectiveLinkAuth = linkAuth != null ? linkAuth : detectLinkDefault();

  // 1) Ensure happy-stacks home is initialized (idempotent).
  await runNodeScript({ rootDir, rel: 'scripts/init.mjs', args: ['--no-bootstrap'] });

  // 2) Bootstrap component repos and deps (idempotent; clones only if missing).
  await runNodeScript({ rootDir, rel: 'scripts/install.mjs', args: ['--upstream', '--clone', `--server=${bootstrapServer}`] });

  // 3) Create/reuse the PR stack and wire worktrees.
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
    ...(json ? ['--json'] : []),
  ];
  if (forwarded.length) {
    stackArgs.push('--', ...forwarded);
  }
  await runNodeScript({ rootDir, rel: 'scripts/stack.mjs', args: stackArgs });
}

main().catch((err) => {
  console.error('[setup-pr] failed:', err);
  process.exit(1);
});

