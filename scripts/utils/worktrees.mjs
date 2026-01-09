import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
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
  // Use pnpm wt new but do not set env.local.
  await run('pnpm', ['-s', 'wt', 'new', component, slug, `--remote=${remoteName}`], { cwd: rootDir });
  const repoDir = componentRepoDir(rootDir, component);
  const owner = await getRemoteOwner({ repoDir, remoteName });
  return join(getWorktreesRoot(rootDir), component, owner, ...slug.split('/'));
}

