import { readdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { getComponentsDir } from './paths.mjs';
import { pathExists } from './fs.mjs';
import { run, runCapture } from './proc.mjs';

export function parseGithubOwner(remoteUrl) {
  const raw = (remoteUrl ?? '').trim();
  if (!raw) {
    return null;
  }
  // https://github.com/<owner>/<repo>.git
  // git@github.com:<owner>/<repo>.git
  const m = raw.match(/github\.com[:/](?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/);
  return m?.groups?.owner ?? null;
}

export function getWorktreesRoot(rootDir) {
  return join(getComponentsDir(rootDir), '.worktrees');
}

export function componentRepoDir(rootDir, component) {
  return join(getComponentsDir(rootDir), component);
}

export function isComponentWorktreePath({ rootDir, component, dir }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return false;
  const abs = resolve(raw);
  const root = resolve(join(getWorktreesRoot(rootDir), component)) + '/';
  return abs.startsWith(root);
}

export function worktreeSpecFromDir({ rootDir, component, dir }) {
  const raw = String(dir ?? '').trim();
  if (!raw) return null;
  if (!isComponentWorktreePath({ rootDir, component, dir: raw })) return null;
  const abs = resolve(raw);
  const root = resolve(join(getWorktreesRoot(rootDir), component)) + '/';
  const rel = abs.slice(root.length).split('/').filter(Boolean);
  if (rel.length < 2) return null;
  // rel = [owner, ...branchParts]
  return rel.join('/');
}

export async function inferRemoteNameForOwner({ repoDir, owner }) {
  const want = String(owner ?? '').trim();
  if (!want) return 'upstream';

  const candidates = ['upstream', 'origin', 'fork'];
  for (const remoteName of candidates) {
    try {
      const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
      const o = parseGithubOwner(url);
      if (o && o === want) {
        return remoteName;
      }
    } catch {
      // ignore missing remote
    }
  }
  return 'upstream';
}

export async function createWorktreeFromBaseWorktree({
  rootDir,
  component,
  slug,
  baseWorktreeSpec,
  remoteName = 'upstream',
  depsMode = '',
}) {
  const args = ['wt', 'new', component, slug, `--remote=${remoteName}`, `--base-worktree=${baseWorktreeSpec}`];
  if (depsMode) args.push(`--deps=${depsMode}`);
  await run(process.execPath, [join(rootDir, 'bin', 'happys.mjs'), ...args], { cwd: rootDir });

  const repoDir = componentRepoDir(rootDir, component);
  const owner = await getRemoteOwner({ repoDir, remoteName });
  return join(getWorktreesRoot(rootDir), component, owner, ...slug.split('/'));
}

export function resolveComponentSpecToDir({ rootDir, component, spec }) {
  const raw = (spec ?? '').trim();
  if (!raw || raw === 'default') {
    return null;
  }
  if (isAbsolute(raw)) {
    return raw;
  }
  // Treat as <owner>/<branch...> under components/.worktrees/<component>/...
  return join(getWorktreesRoot(rootDir), component, ...raw.split('/'));
}

export async function listWorktreeSpecs({ rootDir, component }) {
  const dir = join(getWorktreesRoot(rootDir), component);
  const specs = [];
  try {
    const walk = async (d, prefixParts) => {
      const entries = await readdir(d, { withFileTypes: true });
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const p = join(d, e.name);
        const nextPrefix = [...prefixParts, e.name];
        if (await pathExists(join(p, '.git'))) {
          specs.push(nextPrefix.join('/'));
        }
        await walk(p, nextPrefix);
      }
    };
    if (await pathExists(dir)) {
      await walk(dir, []);
    }
  } catch {
    // ignore
  }
  return specs.sort();
}

export async function getRemoteOwner({ repoDir, remoteName = 'upstream' }) {
  const url = (await runCapture('git', ['remote', 'get-url', remoteName], { cwd: repoDir })).trim();
  const owner = parseGithubOwner(url);
  if (!owner) {
    throw new Error(`[worktrees] unable to parse owner for ${repoDir} remote ${remoteName} (${url})`);
  }
  return owner;
}

export async function createWorktree({ rootDir, component, slug, remoteName = 'upstream' }) {
  // Create without modifying env.local (unless caller passes --use elsewhere).
  await run(process.execPath, [join(rootDir, 'bin', 'happys.mjs'), 'wt', 'new', component, slug, `--remote=${remoteName}`], { cwd: rootDir });
  const repoDir = componentRepoDir(rootDir, component);
  const owner = await getRemoteOwner({ repoDir, remoteName });
  return join(getWorktreesRoot(rootDir), component, owner, ...slug.split('/'));
}
