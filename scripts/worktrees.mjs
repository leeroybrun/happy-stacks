import './utils/env/env.mjs';
import { mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { componentDirEnvKey, getComponentDir, getComponentsDir, getHappyStacksHomeDir, getRootDir, getWorkspaceDir } from './utils/paths/paths.mjs';
import { inferRemoteNameForOwner, parseGithubOwner } from './utils/worktrees.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env/env_local.mjs';
import { ensureEnvFileUpdated } from './utils/env/env_file.mjs';
import { existsSync } from 'node:fs';
import { getHomeEnvLocalPath, getHomeEnvPath, resolveUserConfigEnvPath } from './utils/env/config.mjs';
import { detectServerComponentDirMismatch } from './utils/validate.mjs';

function getActiveStackName() {
  return (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim() || 'main';
}

function isMainStack() {
  return getActiveStackName() === 'main';
}

function getWorktreesRoot(rootDir) {
  return join(getComponentsDir(rootDir), '.worktrees');
}

function resolveComponentWorktreeDir({ rootDir, component, spec }) {
  const worktreesRoot = getWorktreesRoot(rootDir);
  const raw = (spec ?? '').trim();

  if (!raw) {
    // Default: use currently active dir for this component (env override if present, otherwise components/<component>).
    return getComponentDir(rootDir, component);
  }

  if (raw === 'default' || raw === 'main') {
    return join(getComponentsDir(rootDir), component);
  }

  if (raw === 'active') {
    return getComponentDir(rootDir, component);
  }

  if (isAbsolute(raw)) {
    return raw;
  }

  // Interpret as <owner>/<rest...> under components/.worktrees/<component>/.
  return join(worktreesRoot, component, ...raw.split('/'));
}

function parseGithubPullRequest(input) {
  const raw = (input ?? '').trim();
  if (!raw) return null;
  if (/^\d+$/.test(raw)) {
    return { number: Number(raw), owner: null, repo: null };
  }
  // https://github.com/<owner>/<repo>/pull/<num>
  const m = raw.match(/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+)\/pull\/(?<num>\d+)/);
  if (!m?.groups?.num) return null;
  return {
    number: Number(m.groups.num),
    owner: m.groups.owner ?? null,
    repo: m.groups.repo ?? null,
  };
}

function sanitizeSlugPart(s) {
  return (s ?? '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function isWorktreeClean(dir) {
  const dirty = (await git(dir, ['status', '--porcelain'])).trim();
  return !dirty;
}

async function maybeStash({ dir, enabled, keep, message }) {
  if (!enabled && !keep) {
    return { stashed: false, kept: false };
  }
  const clean = await isWorktreeClean(dir);
  if (clean) {
    return { stashed: false, kept: false };
  }
  const msg = message || `happy-stacks auto-stash (${new Date().toISOString()})`;
  // Include untracked files (-u). If stash applies cleanly later, we'll pop.
  await git(dir, ['stash', 'push', '-u', '-m', msg]);
  return { stashed: true, kept: Boolean(keep) };
}

async function maybePopStash({ dir, stashed, keep }) {
  if (!stashed || keep) {
    return { popped: false, popError: null };
  }
  try {
    await git(dir, ['stash', 'pop']);
    return { popped: true, popError: null };
  } catch (e) {
    // On conflicts, `git stash pop` keeps the stash entry.
    return { popped: false, popError: String(e?.message ?? e) };
  }
}

async function hardReset({ dir, target }) {
  await git(dir, ['reset', '--hard', target]);
}

async function git(root, args) {
  return await runCapture('git', args, { cwd: root });
}

async function gitOk(root, args) {
  try {
    await runCapture('git', args, { cwd: root });
    return true;
  } catch {
    return false;
  }
}

function parseDepsMode(raw) {
  const v = (raw ?? '').trim().toLowerCase();
  if (!v) return 'none';
  if (v === 'none') return 'none';
  if (v === 'link' || v === 'symlink') return 'link';
  if (v === 'install') return 'install';
  if (v === 'link-or-install' || v === 'linkorinstall') return 'link-or-install';
  throw new Error(`[wt] invalid --deps value: ${raw}. Expected one of: none | link | install | link-or-install`);
}

async function getWorktreeGitDir(worktreeDir) {
  const gitDir = (await git(worktreeDir, ['rev-parse', '--git-dir'])).trim();
  // rev-parse may return a relative path.
  return isAbsolute(gitDir) ? gitDir : resolve(worktreeDir, gitDir);
}

async function ensureWorktreeExclude(worktreeDir, patterns) {
  const gitDir = await getWorktreeGitDir(worktreeDir);
  const excludePath = join(gitDir, 'info', 'exclude');
  const existing = (await readFile(excludePath, 'utf-8').catch(() => '')).toString();
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()).filter(Boolean));
  const want = patterns.map((p) => p.trim()).filter(Boolean).filter((p) => !existingLines.has(p));
  if (!want.length) return;
  const next = (existing ? existing.replace(/\s*$/, '') + '\n' : '') + want.join('\n') + '\n';
  await mkdir(dirname(excludePath), { recursive: true });
  await writeFile(excludePath, next, 'utf-8');
}

async function detectPackageManager(dir) {
  // Order matters: pnpm > yarn > npm.
  if (await pathExists(join(dir, 'pnpm-lock.yaml'))) return { kind: 'pnpm', lockfile: 'pnpm-lock.yaml' };
  if (await pathExists(join(dir, 'yarn.lock'))) return { kind: 'yarn', lockfile: 'yarn.lock' };
  if (await pathExists(join(dir, 'package-lock.json'))) return { kind: 'npm', lockfile: 'package-lock.json' };
  if (await pathExists(join(dir, 'npm-shrinkwrap.json'))) return { kind: 'npm', lockfile: 'npm-shrinkwrap.json' };
  // Fallback: if package.json exists, assume npm.
  if (await pathExists(join(dir, 'package.json'))) return { kind: 'npm', lockfile: null };
  return { kind: null, lockfile: null };
}

async function linkNodeModules({ fromDir, toDir }) {
  const src = join(fromDir, 'node_modules');
  const dest = join(toDir, 'node_modules');

  if (!(await pathExists(src))) {
    return { linked: false, reason: `source node_modules missing: ${src}` };
  }
  if (await pathExists(dest)) {
    return { linked: false, reason: `dest node_modules already exists: ${dest}` };
  }

  await symlink(src, dest);
  // Worktrees sometimes treat node_modules symlinks oddly; ensure it's excluded even if .gitignore misses it.
  await ensureWorktreeExclude(toDir, ['node_modules']);
  return { linked: true, reason: null };
}

async function installDependencies({ dir }) {
  const pm = await detectPackageManager(dir);
  if (!pm.kind) {
    return { installed: false, reason: 'no package manager detected (no package.json)' };
  }

  if (pm.kind === 'pnpm') {
    await run('pnpm', ['install', '--frozen-lockfile'], { cwd: dir });
    return { installed: true, reason: null };
  }
  if (pm.kind === 'yarn') {
    // Works for yarn classic; yarn berry will ignore/translate flags as needed.
    await run('yarn', ['install', '--frozen-lockfile'], { cwd: dir });
    return { installed: true, reason: null };
  }
  // npm
  if (pm.lockfile && pm.lockfile !== 'package.json') {
    await run('npm', ['ci'], { cwd: dir });
  } else {
    await run('npm', ['install'], { cwd: dir });
  }
  return { installed: true, reason: null };
}

async function maybeSetupDeps({ repoRoot, baseDir, worktreeDir, depsMode }) {
  if (!depsMode || depsMode === 'none') {
    return { mode: 'none', linked: false, installed: false, message: null };
  }

  // Prefer explicit baseDir if provided, otherwise link from the primary checkout (repoRoot).
  const linkFrom = baseDir || repoRoot;

  if (depsMode === 'link' || depsMode === 'link-or-install') {
    const res = await linkNodeModules({ fromDir: linkFrom, toDir: worktreeDir });
    if (res.linked) {
      return { mode: depsMode, linked: true, installed: false, message: null };
    }
    if (depsMode === 'link') {
      return { mode: depsMode, linked: false, installed: false, message: res.reason };
    }
    // fall through to install
  }

  const inst = await installDependencies({ dir: worktreeDir });
  return { mode: depsMode, linked: false, installed: Boolean(inst.installed), message: inst.reason };
}

async function normalizeRemoteName(repoRoot, remoteName) {
  const want = (remoteName ?? '').trim();
  if (!want) return want;

  // happy-local historically used `origin`, but some checkouts use `fork` instead.
  // Treat them as interchangeable if one is missing.
  if (await gitOk(repoRoot, ['remote', 'get-url', want])) {
    return want;
  }
  if (want === 'origin' && (await gitOk(repoRoot, ['remote', 'get-url', 'fork']))) {
    return 'fork';
  }
  if (want === 'fork' && (await gitOk(repoRoot, ['remote', 'get-url', 'origin']))) {
    return 'origin';
  }
  return want;
}

function parseWorktreeListPorcelain(out) {
  const blocks = out
    .split('\n\n')
    .map((b) => b.trim())
    .filter(Boolean);

  return blocks
    .map((block) => {
      const lines = block
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
      const wt = { path: null, head: null, branchRef: null, detached: false };
      for (const line of lines) {
        if (line.startsWith('worktree ')) {
          wt.path = line.slice('worktree '.length).trim();
        } else if (line.startsWith('HEAD ')) {
          wt.head = line.slice('HEAD '.length).trim();
        } else if (line.startsWith('branch ')) {
          wt.branchRef = line.slice('branch '.length).trim();
        } else if (line === 'detached') {
          wt.detached = true;
        }
      }
      if (!wt.path) {
        return null;
      }
      return wt;
    })
    .filter(Boolean);
}

function getComponentRepoRoot(rootDir, component) {
  // Respect component dir overrides so repos can live outside components/ (e.g. an existing checkout at ../happy-server).
  return getComponentDir(rootDir, component);
}

async function resolveOwners(repoRoot) {
  const originRemote = await normalizeRemoteName(repoRoot, 'origin') || 'origin';
  const originUrl = (await git(repoRoot, ['remote', 'get-url', originRemote])).trim();
  const upstreamUrl = (await git(repoRoot, ['remote', 'get-url', 'upstream']).catch(() => '')).trim();

  const originOwner = parseGithubOwner(originUrl);
  const upstreamOwner = parseGithubOwner(upstreamUrl);

  if (!originOwner) {
    throw new Error(`[wt] unable to parse origin owner for ${repoRoot} (${originRemote} -> ${originUrl})`);
  }

  return { originOwner, upstreamOwner: upstreamOwner ?? originOwner };
}

async function resolveRemoteOwner(repoRoot, remoteName) {
  const resolvedRemoteName = await normalizeRemoteName(repoRoot, remoteName);
  const remoteUrl = (await git(repoRoot, ['remote', 'get-url', resolvedRemoteName])).trim();
  const owner = parseGithubOwner(remoteUrl);
  if (!owner) {
    throw new Error(`[wt] unable to parse owner for remote '${resolvedRemoteName}' in ${repoRoot} (${remoteUrl})`);
  }
  return { owner, remoteUrl, remoteName: resolvedRemoteName };
}

async function resolveRemoteDefaultBranchName(repoRoot, remoteName, { component } = {}) {
  // Happy-local components sometimes use non-`main` distribution branches on origin
  // (e.g. `happy-server-light`, `happy-server`). Prefer a branch that matches the component name
  // if it exists on that remote, otherwise fall back to the remote's HEAD branch, then `main`.
  if (component) {
    const ref = `refs/remotes/${remoteName}/${component}`;
    if (await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', ref])) {
      return component;
    }
  }

  const remoteHead = (await git(repoRoot, ['symbolic-ref', '-q', '--short', `refs/remotes/${remoteName}/HEAD`]).catch(() => '')).trim();
  if (remoteHead.startsWith(`${remoteName}/`)) {
    return remoteHead.slice(remoteName.length + 1);
  }

  return 'main';
}

function inferTargetOwner({ branchName, branchRemote, originOwner, upstreamOwner }) {
  const lower = branchName.toLowerCase();
  if (branchName.startsWith(`${originOwner}/`)) {
    return originOwner;
  }
  if (branchName.startsWith(`${upstreamOwner}/`)) {
    return upstreamOwner;
  }

  if (branchRemote === 'upstream' || lower.includes('upstream')) {
    return upstreamOwner;
  }

  return originOwner;
}

function branchRest({ branchName, owner }) {
  return branchName.startsWith(`${owner}/`) ? branchName.slice(owner.length + 1) : branchName;
}

async function migrateComponentWorktrees({ rootDir, component }) {
  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    return { moved: 0, renamed: 0 };
  }

  // Ensure it looks like a git repo.
  if (!(await gitOk(repoRoot, ['rev-parse', '--is-inside-work-tree']))) {
    return { moved: 0, renamed: 0 };
  }

  const { originOwner, upstreamOwner } = await resolveOwners(repoRoot);
  const wtRoot = getWorktreesRoot(rootDir);

  const worktreesRaw = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const worktrees = parseWorktreeListPorcelain(worktreesRaw);

  let moved = 0;
  let renamed = 0;

  const componentsDir = getComponentsDir(rootDir);
  // NOTE: getWorkspaceDir() is influenced by HAPPY_STACKS_WORKSPACE_DIR, which for this repo
  // points at the current workspace. For migration we specifically want to consider the
  // historical home workspace at: <home>/workspace/components
  const legacyHomeWorkspaceComponentsDir = join(getHappyStacksHomeDir(), 'workspace', 'components');
  const allowedComponentRoots = [componentsDir];
  try {
    if (
      existsSync(legacyHomeWorkspaceComponentsDir) &&
      resolve(legacyHomeWorkspaceComponentsDir) !== resolve(componentsDir)
    ) {
      allowedComponentRoots.push(legacyHomeWorkspaceComponentsDir);
    }
  } catch {
    // ignore
  }

  for (const wt of worktrees) {
    const wtPath = wt.path;
    if (!wtPath) {
      continue;
    }

    // Skip the primary checkout (repo root).
    if (resolve(wtPath) === resolve(repoRoot)) {
      continue;
    }

    // Only migrate worktrees living under either:
    // - current workspace components folder, or
    // - legacy home workspace components folder (~/.happy-stacks/workspace/components)
    // This is necessary when users switch HAPPY_STACKS_WORKSPACE_DIR, otherwise git will keep
    // worktrees "stuck" in the old workspace and branches can't be re-used in the new workspace.
    const resolvedWt = resolve(wtPath);
    const okRoot = allowedComponentRoots.some((d) => resolvedWt.startsWith(resolve(d) + '/'));
    if (!okRoot) {
      continue;
    }

    const branchName = (await git(wtPath, ['branch', '--show-current'])).trim();
    if (!branchName) {
      // Detached HEAD (skip).
      continue;
    }

    const branchRemote = (await git(repoRoot, ['config', '--get', `branch.${branchName}.remote`]).catch(() => '')).trim();
    const owner = inferTargetOwner({ branchName, branchRemote, originOwner, upstreamOwner });
    const desiredBranchName = branchName.startsWith(`${owner}/`) ? branchName : `${owner}/${branchName}`;
    const rest = branchRest({ branchName: desiredBranchName, owner });

    // Rename branch (in the worktree where it is checked out).
    if (desiredBranchName !== branchName) {
      await run('git', ['branch', '-m', desiredBranchName], { cwd: wtPath });
      renamed += 1;
    }

    const destPath = join(wtRoot, component, owner, ...rest.split('/'));
    await mkdir(dirname(destPath), { recursive: true });

    if (resolve(destPath) !== resolve(wtPath)) {
      await run('git', ['worktree', 'move', wtPath, destPath], { cwd: repoRoot });
      moved += 1;
    }
  }

  // Best-effort cleanup of old worktree folders under components/.
  const legacyDirs = [
    join(componentsDir, `${component}-worktrees`),
    join(componentsDir, `${component}-resume-upstream-clean`),
  ];
  for (const d of legacyDirs) {
    if (!(await pathExists(d))) {
      continue;
    }
    try {
      const entries = await readdir(d);
      if (!entries.length) {
        await rm(d, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }

  return { moved, renamed };
}

async function cmdMigrate({ rootDir }) {
  const components = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

  let totalMoved = 0;
  let totalRenamed = 0;
  for (const component of components) {
    const res = await migrateComponentWorktrees({ rootDir, component });
    totalMoved += res.moved;
    totalRenamed += res.renamed;
  }

  // If the persisted config pins any component dir to a legacy location, attempt to rewrite it.
  const envUpdates = [];

  // Keep in sync with scripts/utils/env/env_local.mjs selection logic.
  const explicitEnv = (process.env.HAPPY_STACKS_ENV_FILE ?? process.env.HAPPY_LOCAL_ENV_FILE ?? '').trim();
  const hasHomeConfig = existsSync(getHomeEnvPath()) || existsSync(getHomeEnvLocalPath());
  const envPath = explicitEnv ? explicitEnv : hasHomeConfig ? resolveUserConfigEnvPath({ cliRootDir: rootDir }) : join(rootDir, 'env.local');

  if (await pathExists(envPath)) {
    const raw = await readFile(envPath, 'utf-8');
    const rewrite = (v) => {
      if (!v.includes('/components/')) {
        return v;
      }
      return v
        .replace('/components/happy-worktrees/', '/components/.worktrees/happy/')
        .replace('/components/happy-cli-worktrees/', '/components/.worktrees/happy-cli/')
        .replace('/components/happy-resume-upstream-clean', '/components/.worktrees/happy/')
        .replace('/components/happy-cli-resume-upstream-clean', '/components/.worktrees/happy-cli/');
    };

    for (const component of ['happy', 'happy-cli', 'happy-server-light', 'happy-server']) {
      const key = componentDirEnvKey(component);
      const m = raw.match(new RegExp(`^\\s*${key}=(.*)$`, 'm'));
      if (m?.[1]) {
        const current = m[1].trim();
        const next = rewrite(current);
        if (next !== current) {
          envUpdates.push({ key, value: next });
        }
      }
    }
  }
  // Write to the same file we inspected.
  await ensureEnvFileUpdated({ envPath, updates: envUpdates });

  return { moved: totalMoved, branchesRenamed: totalRenamed };
}

async function cmdUse({ rootDir, args, flags }) {
  const component = args[0];
  const spec = args[1];
  if (!component || !spec) {
    throw new Error('[wt] usage: happys wt use <component> <owner/branch|path|default>');
  }

  // Safety: main stack should not be repointed to arbitrary worktrees by default.
  // This is the most common “oops, the main stack now runs my PR checkout” footgun (especially for agents).
  const force = Boolean(flags?.has('--force'));
  if (!force && isMainStack() && spec !== 'default' && spec !== 'main') {
    throw new Error(
      `[wt] refusing to change main stack component override by default.\n` +
        `- stack: main\n` +
        `- component: ${component}\n` +
        `- requested: ${spec}\n` +
        `\n` +
        `Recommendation:\n` +
        `- Create a new isolated stack and switch that stack instead:\n` +
        `  happys stack new exp1 --interactive\n` +
        `  happys stack wt exp1 -- use ${component} ${spec}\n` +
        `\n` +
        `If you really intend to repoint the main stack, re-run with --force:\n` +
        `  happys wt use ${component} ${spec} --force\n`
    );
  }

  const key = componentDirEnvKey(component);
  const worktreesRoot = getWorktreesRoot(rootDir);
  const envPath = process.env.HAPPY_STACKS_ENV_FILE?.trim()
    ? process.env.HAPPY_STACKS_ENV_FILE.trim()
    : process.env.HAPPY_LOCAL_ENV_FILE?.trim()
      ? process.env.HAPPY_LOCAL_ENV_FILE.trim()
      : null;

  if (spec === 'default' || spec === 'main') {
    // Clear override by setting it to empty (env.local keeps a record of last use, but override becomes inactive).
    await (envPath
      ? ensureEnvFileUpdated({ envPath, updates: [{ key, value: '' }] })
      : ensureEnvLocalUpdated({ rootDir, updates: [{ key, value: '' }] }));
    return { component, activeDir: join(getComponentsDir(rootDir), component), mode: 'default' };
  }

  let dir = spec;
  if (!isAbsolute(dir)) {
    // Allow passing a repo-relative path (e.g. "components/happy-cli") as an escape hatch.
    const rel = resolve(getWorkspaceDir(rootDir), dir);
    if (await pathExists(rel)) {
      dir = rel;
    } else {
      // Interpret as <owner>/<rest...> under components/.worktrees/<component>/.
      dir = join(worktreesRoot, component, ...spec.split('/'));
    }
  } else {
    dir = resolve(dir);
  }

  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  if (component === 'happy-server-light' || component === 'happy-server') {
    const mismatch = detectServerComponentDirMismatch({ rootDir, serverComponentName: component, serverDir: dir });
    if (mismatch) {
      throw new Error(
        `[wt] invalid target for ${component}:\n` +
          `- expected a checkout of: ${mismatch.expected}\n` +
          `- but the path points inside: ${mismatch.actual}\n` +
          `- path: ${mismatch.serverDir}\n` +
          `Fix: pick a worktree under components/.worktrees/${mismatch.expected}/ (or run: happys wt use ${mismatch.actual} <spec>).`
      );
    }
  }

  await (envPath
    ? ensureEnvFileUpdated({ envPath, updates: [{ key, value: dir }] })
    : ensureEnvLocalUpdated({ rootDir, updates: [{ key, value: dir }] }));
  return { component, activeDir: dir, mode: 'override' };
}

async function cmdUseInteractive({ rootDir }) {
  await withRl(async (rl) => {
    const component = await prompt(rl, 'Component [happy|happy-cli|happy-server-light|happy-server]: ', { defaultValue: '' });
    if (!component) {
      throw new Error('[wt] component is required');
    }

    const wtRoot = getWorktreesRoot(rootDir);
    const base = join(wtRoot, component);
    const specs = [];
    const walk = async (d, prefix) => {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(d, e.name);
        const nextPrefix = prefix ? `${prefix}/${e.name}` : e.name;
        if (await pathExists(join(p, '.git'))) {
          specs.push(nextPrefix);
        }
        await walk(p, nextPrefix);
      }
    };
    if (await pathExists(base)) {
      await walk(base, '');
    }
    specs.sort();

    const kindOptions = [{ label: 'default', value: 'default' }];
    if (specs.length) {
      kindOptions.push({ label: 'pick existing worktree', value: 'pick' });
    }
    const choice = await promptSelect(rl, {
      title: `Active choices for ${component}:`,
      options: kindOptions,
      defaultIndex: 0,
    });
    if (choice === 'pick') {
      const picked = await promptSelect(rl, {
        title: `Available ${component} worktrees:`,
        options: specs.map((s) => ({ label: s, value: s })),
        defaultIndex: 0,
      });
      await cmdUse({ rootDir, args: [component, picked], flags: new Set(['--force']) });
      return;
    }
    await cmdUse({ rootDir, args: [component, 'default'], flags: new Set(['--force']) });
  });
}

async function cmdNew({ rootDir, argv }) {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const slug = positionals[2];
  if (!component || !slug) {
    throw new Error(
      '[wt] usage: happys wt new <component> <slug> [--from=upstream|origin] [--remote=<name>] [--base=<ref>|--base-worktree=<spec>] [--deps=none|link|install|link-or-install] [--use]'
    );
  }

  const { flags, kv } = parseArgs(argv.slice(1));
  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing component repo at ${repoRoot}`);
  }

  const remoteOverride = (kv.get('--remote') ?? '').trim();
  const from = (kv.get('--from') ?? '').trim().toLowerCase() || 'upstream';
  let remoteName = remoteOverride || (from === 'origin' ? 'origin' : 'upstream');

  const remote = await resolveRemoteOwner(repoRoot, remoteName);
  remoteName = remote.remoteName;
  const { owner } = remote;
  const defaultBranch = await resolveRemoteDefaultBranchName(repoRoot, remoteName, { component });

  const baseOverride = (kv.get('--base') ?? '').trim();
  const baseWorktreeSpec = (kv.get('--base-worktree') ?? kv.get('--from-worktree') ?? '').trim();
  let baseFromWorktree = '';
  let baseWorktreeDir = '';
  if (!baseOverride && baseWorktreeSpec) {
    baseWorktreeDir = resolveComponentWorktreeDir({ rootDir, component, spec: baseWorktreeSpec });
    if (!(await pathExists(baseWorktreeDir))) {
      throw new Error(`[wt] --base-worktree does not exist: ${baseWorktreeDir}`);
    }
    const branch = (await git(baseWorktreeDir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    if (branch && branch !== 'HEAD') {
      baseFromWorktree = branch;
    } else {
      baseFromWorktree = (await git(baseWorktreeDir, ['rev-parse', 'HEAD'])).trim();
    }
  }

  // Default: base worktrees on a local mirror branch like `slopus/main` (or `leeroybrun/happy-server-light`).
  // This scales to multiple upstream remotes without relying on a generic "upstream-main".
  const mirrorBranch = `${owner}/${defaultBranch}`;
  const base = baseOverride || baseFromWorktree || mirrorBranch;
  const branchName = `${owner}/${slug}`;

  const worktreesRoot = getWorktreesRoot(rootDir);
  const destPath = join(worktreesRoot, component, owner, ...slug.split('/'));
  await mkdir(dirname(destPath), { recursive: true });

  // Ensure remotes are present.
  await git(repoRoot, ['fetch', '--all', '--prune', '--quiet']);

  // Keep the mirror branch up to date when using the default base.
  if (!baseOverride && !baseFromWorktree) {
    await git(repoRoot, ['fetch', '--quiet', remoteName, defaultBranch]);
    await git(repoRoot, ['branch', '-f', mirrorBranch, `${remoteName}/${defaultBranch}`]);
    await git(repoRoot, ['branch', '--set-upstream-to', `${remoteName}/${defaultBranch}`, mirrorBranch]).catch(() => {});
  }

  // If the branch already exists (common when migrating between workspaces),
  // attach a new worktree to that branch instead of failing.
  if (await gitOk(repoRoot, ['show-ref', '--verify', `refs/heads/${branchName}`])) {
    await git(repoRoot, ['worktree', 'add', destPath, branchName]);
  } else {
    await git(repoRoot, ['worktree', 'add', '-b', branchName, destPath, base]);
  }

  const depsMode = parseDepsMode(kv.get('--deps'));
  const deps = await maybeSetupDeps({ repoRoot, baseDir: baseWorktreeDir || '', worktreeDir: destPath, depsMode });

  const shouldUse = flags.has('--use');
  const force = flags.has('--force');
  if (shouldUse) {
    if (isMainStack() && !force) {
      throw new Error(
        `[wt] refusing to set main stack component override via --use by default.\n` +
          `- stack: main\n` +
          `- component: ${component}\n` +
          `- new worktree: ${destPath}\n` +
          `\n` +
          `Recommendation:\n` +
          `- Use an isolated stack instead:\n` +
          `  happys stack new exp1 --interactive\n` +
          `  happys stack wt exp1 -- use ${component} ${owner}/${slug}\n` +
          `\n` +
          `If you really intend to repoint the main stack, re-run with --force:\n` +
          `  happys wt new ${component} ${slug} --use --force\n`
      );
    }
    const key = componentDirEnvKey(component);
    await ensureEnvLocalUpdated({ rootDir, updates: [{ key, value: destPath }] });
  }
  return { component, branch: branchName, path: destPath, base, used: shouldUse, deps };
}

async function cmdDuplicate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const fromSpec = positionals[2];
  const slug = positionals[3];
  if (!component || !fromSpec || !slug) {
    throw new Error(
      '[wt] usage: happys wt duplicate <component> <fromWorktreeSpec|path|active|default> <newSlug> [--remote=<name>] [--deps=none|link|install|link-or-install] [--use] [--json]'
    );
  }

  // Prefer inferring the remote from the source spec's owner when possible (owner/<branch...>).
  const remoteOverride = (kv.get('--remote') ?? '').trim();
  let remoteName = remoteOverride;
  if (!remoteName && !isAbsolute(fromSpec)) {
    const owner = String(fromSpec).trim().split('/')[0];
    if (owner && owner !== 'active' && owner !== 'default' && owner !== 'main') {
      const repoRoot = getComponentRepoRoot(rootDir, component);
      remoteName = await normalizeRemoteName(repoRoot, await inferRemoteNameForOwner({ repoDir: repoRoot, owner }));
    }
  }

  const depsMode = (kv.get('--deps') ?? '').trim();
  const forwarded = ['new', component, slug, `--base-worktree=${fromSpec}`];
  if (remoteName) forwarded.push(`--remote=${remoteName}`);
  if (depsMode) forwarded.push(`--deps=${depsMode}`);
  if (flags.has('--use')) forwarded.push('--use');
  if (flags.has('--force')) forwarded.push('--force');
  if (json) forwarded.push('--json');

  // Delegate to cmdNew for the actual implementation (single source of truth).
  return await cmdNew({ rootDir, argv: forwarded });
}

async function cmdPr({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const prInput = positionals[2];
  if (!component || !prInput) {
    throw new Error(
      '[wt] usage: happys wt pr <component> <pr-url|number> [--remote=upstream] [--slug=<name>] [--deps=none|link|install|link-or-install] [--use] [--update] [--force] [--json]'
    );
  }

  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing component repo at ${repoRoot}`);
  }

  const pr = parseGithubPullRequest(prInput);
  if (!pr?.number || !Number.isFinite(pr.number)) {
    throw new Error(`[wt] unable to parse PR: ${prInput}`);
  }

  const remoteName = (kv.get('--remote') ?? '').trim() || 'upstream';
  const { owner } = await resolveRemoteOwner(repoRoot, remoteName);

  const slugExtra = sanitizeSlugPart(kv.get('--slug') ?? '');
  const slug = slugExtra ? `pr/${pr.number}-${slugExtra}` : `pr/${pr.number}`;
  const branchName = `${owner}/${slug}`;

  const worktreesRoot = getWorktreesRoot(rootDir);
  const destPath = join(worktreesRoot, component, owner, ...slug.split('/'));
  await mkdir(dirname(destPath), { recursive: true });

  const exists = await pathExists(destPath);
  const doUpdate = flags.has('--update');
  if (exists && !doUpdate) {
    throw new Error(`[wt] destination already exists: ${destPath}\n[wt] re-run with --update to refresh it`);
  }

  // Fetch PR head ref (GitHub convention). Use + to allow force-updated PR branches when --force is set.
  const force = flags.has('--force');
  let oldHead = null;
  const prRef = `refs/pull/${pr.number}/head`;
  if (exists) {
    // Update existing worktree.
    const stash = await maybeStash({
      dir: destPath,
      enabled: flags.has('--stash'),
      keep: flags.has('--stash-keep'),
      message: `[happy-stacks] wt pr ${component} ${pr.number}`,
    });
    if (!(await isWorktreeClean(destPath)) && !stash.stashed) {
      throw new Error(`[wt] worktree is not clean (${destPath}). Re-run with --stash to auto-stash changes.`);
    }

    oldHead = (await git(destPath, ['rev-parse', 'HEAD'])).trim();
    await git(repoRoot, ['fetch', '--quiet', remoteName, prRef]);
    const newTip = (await git(repoRoot, ['rev-parse', 'FETCH_HEAD'])).trim();

    const isAncestor = await gitOk(repoRoot, ['merge-base', '--is-ancestor', oldHead, newTip]);
    if (!isAncestor && !force) {
      throw new Error(
        `[wt] PR update is not a fast-forward (likely force-push) for ${branchName}\n` +
          `[wt] re-run with: happys wt pr ${component} ${pr.number} --remote=${remoteName} --update --force`
      );
    }

    // Update working tree to the fetched tip.
    if (isAncestor) {
      await git(destPath, ['merge', '--ff-only', newTip]);
    } else {
      await git(destPath, ['reset', '--hard', newTip]);
    }

    // Only attempt to restore stash if update succeeded without forcing a conflict state.
    const stashPop = await maybePopStash({ dir: destPath, stashed: stash.stashed, keep: stash.kept });
    if (stashPop.popError) {
      if (!force && oldHead) {
        await hardReset({ dir: destPath, target: oldHead });
        throw new Error(
          `[wt] PR updated, but restoring stashed changes conflicted.\n` +
            `[wt] Reverted update to keep your working tree clean.\n` +
            `[wt] Worktree: ${destPath}\n` +
            `[wt] Re-run with --update --stash --force to keep the conflict state for manual resolution.`
        );
      }
      // Keep conflict state in place (or if we can't revert).
      throw new Error(
        `[wt] PR updated, but restoring stashed changes conflicted.\n` +
          `[wt] Worktree: ${destPath}\n` +
          `[wt] Conflicts are left in place for manual resolution (--force).`
      );
    }
  } else {
    await git(repoRoot, ['fetch', '--quiet', remoteName, prRef]);
    const newTip = (await git(repoRoot, ['rev-parse', 'FETCH_HEAD'])).trim();

    const branchExists = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]);
    if (branchExists) {
      if (!force) {
        throw new Error(`[wt] branch already exists: ${branchName}\n[wt] re-run with --force to reset it to the PR head`);
      }
      await git(repoRoot, ['branch', '-f', branchName, newTip]);
      await git(repoRoot, ['worktree', 'add', destPath, branchName]);
    } else {
      // Create worktree at PR head (new local branch).
      await git(repoRoot, ['worktree', 'add', '-b', branchName, destPath, newTip]);
    }
  }

  // Optional deps handling (useful when PR branches add/change dependencies).
  const depsMode = parseDepsMode(kv.get('--deps'));
  const deps = await maybeSetupDeps({ repoRoot, baseDir: repoRoot, worktreeDir: destPath, depsMode });

  const shouldUse = flags.has('--use');
  if (shouldUse) {
    // Reuse cmdUse so it writes to env.local or stack env file depending on context.
    await cmdUse({ rootDir, args: [component, destPath], flags });
  }

  const newHead = (await git(destPath, ['rev-parse', 'HEAD'])).trim();
  const res = {
    component,
    pr: pr.number,
    remote: remoteName,
    branch: branchName,
    path: destPath,
    used: shouldUse,
    updated: exists,
    oldHead,
    newHead,
    deps,
  };
  if (json) {
    return res;
  }
  return res;
}

async function cmdStatus({ rootDir, argv }) {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error('[wt] usage: happys wt status <component> [worktreeSpec|default|path]');
  }

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  const head = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const dirty = (await git(dir, ['status', '--porcelain'])).trim();
  const isClean = !dirty;

  let upstream = null;
  try {
    upstream = (await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
  } catch {
    upstream = null;
  }

  let ahead = null;
  let behind = null;
  if (upstream) {
    try {
      const counts = (await git(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`])).trim();
      const [left, right] = counts.split(/\s+/g).map((n) => Number(n));
      behind = Number.isFinite(left) ? left : null;
      ahead = Number.isFinite(right) ? right : null;
    } catch {
      ahead = null;
      behind = null;
    }
  }

  const conflicts = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim().split('\n').filter(Boolean);

  return { component, dir, branch, head, upstream, ahead, behind, isClean, conflicts };
}

async function cmdPush({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error('[wt] usage: happys wt push <component> [worktreeSpec|default|path] [--remote=origin] [--dry-run]');
  }

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const branch = (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  if (!branch || branch === 'HEAD') {
    throw new Error('[wt] cannot push detached HEAD (checkout a branch first)');
  }

  let remote = (kv.get('--remote') ?? '').trim() || 'origin';
  remote = (await normalizeRemoteName(dir, remote)) || remote;
  const args = ['push', '-u', remote, 'HEAD'];
  if (flags.has('--dry-run')) {
    args.push('--dry-run');
  }
  await git(dir, args);
  return { component, dir, remote, branch, dryRun: flags.has('--dry-run') };
}

async function cmdUpdate({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error(
      '[wt] usage: happys wt update <component> [worktreeSpec|default|path] [--remote=upstream] [--base=<ref>] [--rebase|--merge] [--dry-run] [--force]'
    );
  }

  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing component repo at ${repoRoot}`);
  }

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const statusBefore = await cmdStatus({ rootDir, argv: ['status', component, dir] });
  if (!statusBefore.isClean && !flags.has('--stash') && !flags.has('--stash-keep')) {
    throw new Error(`[wt] working tree is not clean (${dir}). Re-run with --stash to auto-stash changes.`);
  }

  let remoteName = (kv.get('--remote') ?? '').trim() || 'upstream';
  const remote = await resolveRemoteOwner(repoRoot, remoteName);
  remoteName = remote.remoteName;
  const { owner } = remote;
  const defaultBranch = await resolveRemoteDefaultBranchName(repoRoot, remoteName, { component });
  const mirrorBranch = `${owner}/${defaultBranch}`;

  const baseOverride = (kv.get('--base') ?? '').trim();
  const base = baseOverride || mirrorBranch;

  // Keep the mirror branch updated when using the default base.
  if (!baseOverride) {
    await cmdSync({ rootDir, argv: ['sync', component, `--remote=${remoteName}`] });
  }

  const mode = flags.has('--merge') ? 'merge' : 'rebase';
  const dryRun = flags.has('--dry-run');
  const force = flags.has('--force');
  const stashRequested = flags.has('--stash') || flags.has('--stash-keep');
  const stashKeep = flags.has('--stash-keep');

  if (dryRun && stashRequested) {
    throw new Error('[wt] --dry-run cannot be combined with --stash/--stash-keep (it would modify your working tree)');
  }

  const conflictFiles = async () => {
    const out = (await git(dir, ['diff', '--name-only', '--diff-filter=U']).catch(() => '')).trim();
    return out ? out.split('\n').filter(Boolean) : [];
  };

  const abortMerge = async () => {
    await git(dir, ['merge', '--abort']).catch(() => {});
  };
  const abortRebase = async () => {
    await git(dir, ['rebase', '--abort']).catch(() => {});
  };

  // Dry-run: try a merge and abort to see if it would conflict.
  if (dryRun) {
    const status = await cmdStatus({ rootDir, argv: ['status', component, dir] });
    if (!status.isClean) {
      throw new Error(`[wt] working tree is not clean (${dir}). Commit/stash first.`);
    }
    let ok = true;
    let conflicts = [];
    try {
      await git(dir, ['merge', '--no-commit', '--no-ff', '--no-stat', base]);
      conflicts = await conflictFiles();
      ok = conflicts.length === 0;
    } catch {
      conflicts = await conflictFiles();
      ok = conflicts.length === 0 ? false : false;
    } finally {
      await abortMerge();
    }
    return { component, dir, mode, base, dryRun: true, ok, conflicts };
  }

  // Optionally stash before applying.
  const oldHead = (await git(dir, ['rev-parse', 'HEAD'])).trim();
  const stash = await maybeStash({
    dir,
    enabled: flags.has('--stash'),
    keep: stashKeep,
    message: `[happy-stacks] wt update ${component}`,
  });
  if (!(await isWorktreeClean(dir)) && !stash.stashed) {
    throw new Error(`[wt] working tree is not clean (${dir}). Re-run with --stash to auto-stash changes.`);
  }

  // Apply update.
  if (mode === 'merge') {
    try {
      await git(dir, ['merge', '--no-edit', base]);
      const stashPop = await maybePopStash({ dir, stashed: stash.stashed, keep: stash.kept });
      if (stashPop.popError) {
        if (!force) {
          await hardReset({ dir, target: oldHead });
          return {
            component,
            dir,
            mode,
            base,
            ok: false,
            conflicts: [],
            error: 'stash-pop-conflict',
            message:
              `[wt] update succeeded, but restoring stashed changes conflicted.\n` +
              `[wt] Reverted update. Worktree: ${dir}\n` +
              `[wt] Re-run with --stash --force to keep the conflict state for manual resolution.`,
            stash,
            stashPop,
          };
        }
        return {
          component,
          dir,
          mode,
          base,
          ok: false,
          conflicts: await conflictFiles(),
          forceApplied: true,
          error: 'stash-pop-conflict',
          message: `[wt] update succeeded, but restoring stashed changes conflicted (kept for manual resolution). Worktree: ${dir}`,
          stash,
          stashPop,
        };
      }
      return { component, dir, mode, base, ok: true, conflicts: [], stash, stashPop };
    } catch {
      const conflicts = await conflictFiles();
      if (!force) {
        await abortMerge();
      }
      return { component, dir, mode, base, ok: false, conflicts, forceApplied: force, stash, stashPop: { popped: false } };
    }
  }

  // Default: rebase (preferred for clean PR branches).
  try {
    await git(dir, ['rebase', base]);
    const stashPop = await maybePopStash({ dir, stashed: stash.stashed, keep: stash.kept });
    if (stashPop.popError) {
      if (!force) {
        await hardReset({ dir, target: oldHead });
        return {
          component,
          dir,
          mode,
          base,
          ok: false,
          conflicts: [],
          error: 'stash-pop-conflict',
          message:
            `[wt] update succeeded, but restoring stashed changes conflicted.\n` +
            `[wt] Reverted update. Worktree: ${dir}\n` +
            `[wt] Re-run with --stash --force to keep the conflict state for manual resolution.`,
          stash,
          stashPop,
        };
      }
      return {
        component,
        dir,
        mode,
        base,
        ok: false,
        conflicts: await conflictFiles(),
        forceApplied: true,
        error: 'stash-pop-conflict',
        message: `[wt] update succeeded, but restoring stashed changes conflicted (kept for manual resolution). Worktree: ${dir}`,
        stash,
        stashPop,
      };
    }
    return { component, dir, mode, base, ok: true, conflicts: [], stash, stashPop };
  } catch {
    const conflicts = await conflictFiles();
    if (!force) {
      await abortRebase();
    }
    return { component, dir, mode, base, ok: false, conflicts, forceApplied: force, stash, stashPop: { popped: false } };
  }
}

function splitDoubleDash(argv) {
  const idx = argv.indexOf('--');
  if (idx < 0) {
    return { before: argv, after: [] };
  }
  return { before: argv.slice(0, idx), after: argv.slice(idx + 1) };
}

async function cmdGit({ rootDir, argv }) {
  const { before, after } = splitDoubleDash(argv);
  const { flags, kv } = parseArgs(before);
  const json = wantsJson(before, { flags });

  const positionals = before.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error('[wt] usage: happys wt git <component> [worktreeSpec|active|main|default|path] -- <git args...>');
  }
  if (!after.length) {
    throw new Error('[wt] git requires args after `--` (example: happys wt git happy main -- status)');
  }

  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const remote = (kv.get('--remote') ?? '').trim();
  // Convenience: allow `--remote=<name>` to imply `git fetch <name> ...` etc by user choice.
  const args = [...after];
  if (remote && (args[0] === 'fetch' || args[0] === 'pull' || args[0] === 'push') && !args.includes(remote)) {
    // leave untouched; user should pass remote explicitly for correctness
  }

  if (json) {
    const stdout = await git(dir, args);
    return { component, dir, args, stdout };
  }

  await run('git', args, { cwd: dir });
  return { component, dir, args };
}

async function cmdSync({ rootDir, argv }) {
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  if (!component) {
    throw new Error('[wt] usage: happys wt sync <component> [--remote=<name>]');
  }

  const { kv } = parseArgs(argv);
  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    throw new Error(`[wt] missing component repo at ${repoRoot}`);
  }

  let remoteName = (kv.get('--remote') ?? '').trim() || 'upstream';
  const remote = await resolveRemoteOwner(repoRoot, remoteName);
  remoteName = remote.remoteName;
  const { owner } = remote;
  const defaultBranch = await resolveRemoteDefaultBranchName(repoRoot, remoteName, { component });

  await git(repoRoot, ['fetch', '--quiet', remoteName, defaultBranch]);

  const mirrorBranch = `${owner}/${defaultBranch}`;
  await git(repoRoot, ['branch', '-f', mirrorBranch, `${remoteName}/${defaultBranch}`]);
  // Best-effort: set upstream (works even if already set).
  await git(repoRoot, ['branch', '--set-upstream-to', `${remoteName}/${defaultBranch}`, mirrorBranch]).catch(() => {});

  return { component, remote: remoteName, mirrorBranch, upstreamRef: `${remoteName}/${defaultBranch}` };
}

async function commandExists(cmd) {
  try {
    const out = (await runCapture('sh', ['-lc', `command -v ${cmd} >/dev/null 2>&1 && echo yes || echo no`])).trim();
    return out === 'yes';
  } catch {
    return false;
  }
}

async function fileExists(path) {
  try {
    return await pathExists(path);
  } catch {
    return false;
  }
}

async function pickBestShell({ kv, prefer = null } = {}) {
  const fromFlag = (kv?.get('--shell') ?? '').trim();
  const fromEnv = (process.env.HAPPY_LOCAL_WT_SHELL ?? '').trim();
  const fromShellEnv = (process.env.SHELL ?? '').trim();
  const want = (fromFlag || fromEnv || prefer || fromShellEnv).trim();
  if (want) {
    return want;
  }

  const candidates =
    process.platform === 'win32'
      ? []
      : ['/bin/zsh', '/usr/bin/zsh', '/bin/bash', '/usr/bin/bash', '/bin/sh', '/usr/bin/sh'];
  for (const c of candidates) {
    // eslint-disable-next-line no-await-in-loop
    if (await fileExists(c)) {
      return c;
    }
  }
  return process.env.SHELL || '/bin/sh';
}

function escapeForShellDoubleQuotes(s) {
  return (s ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function openTerminalAuto({ dir, shell }) {
  const termPref = (process.env.HAPPY_LOCAL_WT_TERMINAL ?? '').trim().toLowerCase();
  const order = termPref ? [termPref] : ['ghostty', 'iterm', 'terminal', 'current'];

  for (const t of order) {
    if (t === 'current') {
      return { kind: 'current' };
    }

    if (t === 'ghostty') {
      if (await commandExists('ghostty')) {
        try {
          // Best-effort. Ghostty supports --working-directory on recent builds.
          await run('ghostty', ['--working-directory', dir], { cwd: dir, env: process.env, stdio: 'inherit' });
          return { kind: 'ghostty' };
        } catch {
          // fall through
        }
      }
    }

    if (t === 'iterm') {
      if (process.platform === 'darwin') {
        try {
          const cmd = `cd "${escapeForShellDoubleQuotes(dir)}"; exec "${escapeForShellDoubleQuotes(shell)}" -i`;
          // Create a new iTerm window and cd into the directory.
          await run('osascript', [
            '-e',
            'tell application "iTerm" to activate',
            '-e',
            'tell application "iTerm" to create window with default profile',
            '-e',
            `tell application "iTerm" to tell current session of current window to write text "${cmd}"`,
          ]);
          return { kind: 'iterm' };
        } catch {
          // fall through
        }
      }
    }

    if (t === 'terminal') {
      if (process.platform === 'darwin') {
        try {
          // Terminal.app: `open -a Terminal <dir>` opens a window in that dir.
          await run('open', ['-a', 'Terminal', dir], { cwd: dir, env: process.env, stdio: 'inherit' });
          return { kind: 'terminal' };
        } catch {
          // fall through
        }
      }
    }
  }

  return { kind: 'current' };
}

async function cmdShell({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error(
      '[wt] usage: happys wt shell <component> [worktreeSpec|active|default|main|path] [--shell=/bin/zsh] [--terminal=auto|current|ghostty|iterm|terminal] [--new-window] [--json]'
    );
  }
  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const shell = await pickBestShell({ kv });
  const args = ['-i'];
  const terminalFlag = (kv.get('--terminal') ?? '').trim().toLowerCase();
  const newWindow = flags.has('--new-window');
  const wantTerminal = terminalFlag || (newWindow ? 'auto' : 'current');

  if (json) {
    return { component, dir, shell, args, terminal: wantTerminal };
  }

  // This launches a new interactive shell with cwd=dir. It can't change the parent shell, but this is a "real" cd.
  if (wantTerminal === 'current') {
    await run(shell, args, { cwd: dir, env: process.env, stdio: 'inherit' });
    return { component, dir, shell, args, terminal: 'current' };
  }

  if (wantTerminal === 'auto') {
    const chosen = await openTerminalAuto({ dir, shell });
    if (chosen.kind === 'current') {
      await run(shell, args, { cwd: dir, env: process.env, stdio: 'inherit' });
    }
    return { component, dir, shell, args, terminal: chosen.kind };
  }

  // Explicit terminal selection (best-effort).
  process.env.HAPPY_LOCAL_WT_TERMINAL = wantTerminal;
  const chosen = await openTerminalAuto({ dir, shell });
  if (chosen.kind === 'current') {
    await run(shell, args, { cwd: dir, env: process.env, stdio: 'inherit' });
  }
  return { component, dir, shell, args, terminal: chosen.kind };
  return { component, dir, shell, args };
}

async function cmdCode({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error('[wt] usage: happys wt code <component> [worktreeSpec|active|default|main|path] [--json]');
  }
  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }
  if (!(await commandExists('code'))) {
    throw new Error("[wt] VS Code CLI 'code' not found on PATH. In VS Code: Cmd+Shift+P → 'Shell Command: Install code command in PATH'.");
  }
  if (json) {
    return { component, dir, cmd: 'code' };
  }
  await run('code', [dir], { cwd: rootDir, env: process.env, stdio: 'inherit' });
  return { component, dir, cmd: 'code' };
}

async function cmdCursor({ rootDir, argv }) {
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const component = positionals[1];
  const spec = positionals[2] ?? '';
  if (!component) {
    throw new Error('[wt] usage: happys wt cursor <component> [worktreeSpec|active|default|main|path] [--json]');
  }
  const dir = resolveComponentWorktreeDir({ rootDir, component, spec });
  if (!(await pathExists(dir))) {
    throw new Error(`[wt] target does not exist: ${dir}`);
  }

  const hasCursorCli = await commandExists('cursor');
  if (json) {
    return { component, dir, cmd: hasCursorCli ? 'cursor' : process.platform === 'darwin' ? 'open -a Cursor' : null };
  }

  if (hasCursorCli) {
    await run('cursor', [dir], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    return { component, dir, cmd: 'cursor' };
  }

  if (process.platform === 'darwin') {
    await run('open', ['-a', 'Cursor', dir], { cwd: rootDir, env: process.env, stdio: 'inherit' });
    return { component, dir, cmd: 'open -a Cursor' };
  }

  throw new Error("[wt] Cursor CLI 'cursor' not found on PATH (and non-macOS fallback is unavailable).");
}

const DEFAULT_COMPONENTS = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

async function cmdSyncAll({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const remote = (kv.get('--remote') ?? '').trim();
  const components = DEFAULT_COMPONENTS;

  const results = [];
  for (const component of components) {
    try {
      const res = await cmdSync({
        rootDir,
        argv: remote ? ['sync', component, `--remote=${remote}`] : ['sync', component],
      });
      results.push({ component, ok: true, ...res });
    } catch (e) {
      results.push({ component, ok: false, error: String(e?.message ?? e) });
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) {
    return { ok, results };
  }

  const lines = ['[wt] sync-all:'];
  for (const r of results) {
    if (r.ok) {
      lines.push(`- ✅ ${r.component}: ${r.mirrorBranch} -> ${r.upstreamRef}`);
    } else {
      lines.push(`- ❌ ${r.component}: ${r.error}`);
    }
  }
  return { ok, results, text: lines.join('\n') };
}

async function listComponentWorktreePaths({ rootDir, component }) {
  const repoRoot = getComponentRepoRoot(rootDir, component);
  if (!(await pathExists(repoRoot))) {
    return [];
  }
  const out = await git(repoRoot, ['worktree', 'list', '--porcelain']);
  const wts = parseWorktreeListPorcelain(out);
  return wts.map((w) => w.path).filter(Boolean);
}

async function cmdUpdateAll({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const maybeComponent = positionals[1]?.trim() ? positionals[1].trim() : '';
  const components = maybeComponent ? [maybeComponent] : DEFAULT_COMPONENTS;

  const json = wantsJson(argv, { flags });

  const remote = (kv.get('--remote') ?? '').trim();
  const base = (kv.get('--base') ?? '').trim();
  const mode = flags.has('--merge') ? 'merge' : 'rebase';
  const dryRun = flags.has('--dry-run');
  const force = flags.has('--force');
  const stash = flags.has('--stash');
  const stashKeep = flags.has('--stash-keep');

  const results = [];
  for (const component of components) {
    const paths = await listComponentWorktreePaths({ rootDir, component });
    for (const dir of paths) {
      try {
        const args = ['update', component, dir];
        if (remote) args.push(`--remote=${remote}`);
        if (base) args.push(`--base=${base}`);
        if (mode === 'merge') args.push('--merge');
        if (dryRun) args.push('--dry-run');
        if (stash) args.push('--stash');
        if (stashKeep) args.push('--stash-keep');
        if (force) args.push('--force');
        const res = await cmdUpdate({ rootDir, argv: args });
        results.push({ component, dir, ...res });
      } catch (e) {
        results.push({ component, dir, ok: false, error: String(e?.message ?? e) });
      }
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) {
    return { ok, mode, dryRun, force, base: base || '(mirror)', remote: remote || '(default)', results };
  }

  const lines = [
    `[wt] update-all (${mode}${dryRun ? ', dry-run' : ''}${force ? ', force' : ''})`,
    base ? `- base: ${base}` : '- base: <mirror owner/<default-branch>>',
    remote ? `- remote: ${remote}` : '- remote: upstream',
  ];
  for (const r of results) {
    if (r.ok) {
      lines.push(`- ✅ ${r.component}: ${r.dir}`);
    } else if (r.conflicts?.length) {
      lines.push(`- ⚠️  ${r.component}: conflicts (${r.dir})`);
      for (const f of r.conflicts) lines.push(`  - ${f}`);
    } else {
      lines.push(`- ❌ ${r.component}: ${r.error} (${r.dir})`);
    }
  }
  return { ok, results, text: lines.join('\n') };
}

async function cmdNewInteractive({ rootDir, argv }) {
  const { flags, kv } = parseArgs(argv);
  await withRl(async (rl) => {
    const component = await prompt(rl, 'Component [happy|happy-cli|happy-server-light|happy-server]: ', { defaultValue: '' });
    if (!component) {
      throw new Error('[wt] component is required');
    }
    const slug = await prompt(rl, 'Branch slug (example: pr/my-feature): ', { defaultValue: '' });
    if (!slug) {
      throw new Error('[wt] slug is required');
    }

    // Default remote is upstream; allow override.
    const remote = await prompt(rl, 'Remote name (default: upstream): ', { defaultValue: 'upstream' });

    const args = ['new', component, slug, `--remote=${remote}`];
    if (kv.get('--base')?.trim()) {
      args.push(`--base=${kv.get('--base').trim()}`);
    }
    if (flags.has('--use')) {
      args.push('--use');
    }
    await cmdNew({ rootDir, argv: args });
  });
}

async function cmdList({ rootDir, args }) {
  const component = args[0];
  if (!component) {
    throw new Error('[wt] usage: happys wt list <component>');
  }

  const wtRoot = getWorktreesRoot(rootDir);
  const dir = join(wtRoot, component);
  if (!(await pathExists(dir))) {
    return { component, activeDir: (process.env[key] ?? '').trim() || join(getComponentsDir(rootDir), component), worktrees: [] };
  }

  const leafs = [];
  const walk = async (d) => {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      if (!e.isDirectory()) {
        continue;
      }
      const p = join(d, e.name);
      leafs.push(p);
      await walk(p);
    }
  };
  await walk(dir);
  leafs.sort();

  const key = componentDirEnvKey(component);
  const active = (process.env[key] ?? '').trim() || join(getComponentsDir(rootDir), component);

  const worktrees = [];
  for (const p of leafs) {
    if (await pathExists(join(p, '.git'))) {
      worktrees.push(p);
    }
  }
  return { component, activeDir: active, worktrees };
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] ?? 'help';
  const interactive = argv.includes('--interactive') || argv.includes('-i');
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: {
        commands: ['migrate', 'sync', 'sync-all', 'list', 'new', 'pr', 'use', 'status', 'update', 'update-all', 'push', 'git', 'shell', 'code', 'cursor'],
        interactive: ['new', 'use'],
      },
      text: [
        '[wt] usage:',
        '  happys wt migrate [--json]',
        '  happys wt sync <component> [--remote=<name>] [--json]',
        '  happys wt sync-all [--remote=<name>] [--json]',
        '  happys wt list <component> [--json]',
        '  happys wt new <component> <slug> [--from=upstream|origin] [--remote=<name>] [--base=<ref>|--base-worktree=<spec>] [--deps=none|link|install|link-or-install] [--use] [--force] [--interactive|-i] [--json]',
        '  happys wt duplicate <component> <fromWorktreeSpec|path|active|default> <newSlug> [--remote=<name>] [--deps=none|link|install|link-or-install] [--use] [--json]',
        '  happys wt pr <component> <pr-url|number> [--remote=upstream] [--slug=<name>] [--deps=none|link|install|link-or-install] [--use] [--update] [--stash|--stash-keep] [--force] [--json]',
        '  happys wt use <component> <owner/branch|path|default|main> [--force] [--interactive|-i] [--json]',
        '  happys wt status <component> [worktreeSpec|default|path] [--json]',
        '  happys wt update <component> [worktreeSpec|default|path] [--remote=upstream] [--base=<ref>] [--rebase|--merge] [--dry-run] [--stash|--stash-keep] [--force] [--json]',
        '  happys wt update-all [component] [--remote=upstream] [--base=<ref>] [--rebase|--merge] [--dry-run] [--stash|--stash-keep] [--force] [--json]',
        '  happys wt push <component> [worktreeSpec|default|path] [--remote=origin] [--dry-run] [--json]',
        '  happys wt git <component> [worktreeSpec|active|default|main|path] -- <git args...> [--json]',
        '  happys wt shell <component> [worktreeSpec|active|default|main|path] [--shell=/bin/zsh] [--json]',
        '  happys wt code <component> [worktreeSpec|active|default|main|path] [--json]',
        '  happys wt cursor <component> [worktreeSpec|active|default|main|path] [--json]',
        '',
        'selectors:',
        '  (omitted) or "active": current active checkout (env override if set; else components/<component>)',
        '  "default" or "main": components/<component>',
        '  "<owner>/<branch...>": components/.worktrees/<component>/<owner>/<branch...>',
        '  "<absolute path>": explicit checkout path',
        '',
        'components:',
        '  happy | happy-cli | happy-server-light | happy-server',
      ].join('\n'),
    });
    return;
  }

  if (cmd === 'migrate') {
    const res = await cmdMigrate({ rootDir });
    printResult({ json, data: res, text: `[wt] migrate complete (moved=${res.moved}, branchesRenamed=${res.branchesRenamed})` });
    return;
  }
  if (cmd === 'use') {
    if (interactive && isTty()) {
      await cmdUseInteractive({ rootDir });
    } else {
      const res = await cmdUse({ rootDir, args: positionals.slice(1), flags });
      printResult({ json, data: res, text: `[wt] ${res.component}: active dir -> ${res.activeDir}` });
    }
    return;
  }
  if (cmd === 'new') {
    if (interactive && isTty()) {
      await cmdNewInteractive({ rootDir, argv: argv.slice(1) });
    } else {
      const res = await cmdNew({ rootDir, argv });
      printResult({
        json,
        data: res,
        text: `[wt] created ${res.component} worktree: ${res.path} (${res.branch} based on ${res.base})`,
      });
    }
    return;
  }
  if (cmd === 'duplicate') {
    const res = await cmdDuplicate({ rootDir, argv });
    printResult({
      json,
      data: res,
      text: `[wt] duplicated ${res.component} worktree: ${res.path} (${res.branch} based on ${res.base})`,
    });
    return;
  }
  if (cmd === 'pr') {
    const res = await cmdPr({ rootDir, argv });
    printResult({
      json,
      data: res,
      text: `[wt] created PR worktree for ${res.component}: ${res.path} (${res.branch})`,
    });
    return;
  }
  if (cmd === 'sync') {
    const res = await cmdSync({ rootDir, argv });
    printResult({ json, data: res, text: `[wt] ${res.component}: synced ${res.mirrorBranch} -> ${res.upstreamRef}` });
    return;
  }
  if (cmd === 'sync-all') {
    const res = await cmdSyncAll({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    } else {
      printResult({ json: false, text: res.text });
    }
    return;
  }
  if (cmd === 'status') {
    const res = await cmdStatus({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    } else {
      const lines = [
        `[wt] ${res.component}: ${res.dir}`,
        `- branch: ${res.branch}`,
        `- upstream: ${res.upstream ?? '(none)'}`,
        `- ahead/behind: ${res.ahead ?? '?'} / ${res.behind ?? '?'}`,
        `- clean: ${res.isClean ? 'yes' : 'no'}`,
        `- conflicts: ${res.conflicts.length ? res.conflicts.join(', ') : '(none)'}`,
      ];
      printResult({ json: false, text: lines.join('\n') });
    }
    return;
  }
  if (cmd === 'update') {
    const res = await cmdUpdate({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    } else if (res.ok) {
      printResult({ json: false, text: `[wt] ${res.component}: updated (${res.mode}) from ${res.base}` });
    } else {
      if (res.message) {
        printResult({ json: false, text: res.message });
        return;
      }
      const text =
        `[wt] ${res.component}: update had conflicts (${res.mode}) from ${res.base}\n` +
        `worktree: ${res.dir}\n` +
        `conflicts:\n` +
        (res.conflicts.length ? res.conflicts.map((f) => `- ${f}`).join('\n') : '- (unknown)') +
        `\n` +
        (res.forceApplied
          ? '[wt] conflicts left in place for manual resolution (--force)'
          : '[wt] update aborted; re-run with --force to keep conflict state for manual resolution');
      printResult({ json: false, text });
    }
    return;
  }
  if (cmd === 'update-all') {
    const res = await cmdUpdateAll({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    } else {
      printResult({ json: false, text: res.text });
    }
    return;
  }
  if (cmd === 'push') {
    const res = await cmdPush({ rootDir, argv });
    printResult({
      json,
      data: res,
      text: res.dryRun
        ? `[wt] ${res.component}: would push ${res.branch} -> ${res.remote} (dry-run)`
        : `[wt] ${res.component}: pushed ${res.branch} -> ${res.remote}`,
    });
    return;
  }
  if (cmd === 'git') {
    const res = await cmdGit({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'shell') {
    const res = await cmdShell({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'code') {
    const res = await cmdCode({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'cursor') {
    const res = await cmdCursor({ rootDir, argv });
    if (json) {
      printResult({ json, data: res });
    }
    return;
  }
  if (cmd === 'list') {
    const res = await cmdList({ rootDir, args: positionals.slice(1) });
    if (json) {
      printResult({ json, data: res });
    } else {
      const lines = [`[wt] ${res.component} worktrees:`, `- active: ${res.activeDir}`];
      for (const p of res.worktrees) {
        lines.push(`- ${p}`);
      }
      printResult({ json: false, text: lines.join('\n') });
    }
    return;
  }
  throw new Error(`[wt] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[wt] failed:', err);
  process.exit(1);
});
