import { existsSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

import { getWorktreesRoot } from '../git/worktrees.mjs';
import { getComponentsDir } from '../paths/paths.mjs';

export function getInvokedCwd(env = process.env) {
  return String(env.HAPPY_STACKS_INVOKED_CWD ?? env.HAPPY_LOCAL_INVOKED_CWD ?? env.PWD ?? '').trim();
}

function hasGitMarker(dir) {
  try {
    // In a worktree, `.git` is typically a file; in the primary checkout it may be a directory.
    return existsSync(join(dir, '.git'));
  } catch {
    return false;
  }
}

function isPathInside(path, parentDir) {
  const p = resolve(path);
  const d = resolve(parentDir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

function findGitRoot(startDir, stopAtDir) {
  let cur = resolve(startDir);
  const stop = stopAtDir ? resolve(stopAtDir) : '';

  while (true) {
    if (hasGitMarker(cur)) {
      return cur;
    }
    if (stop && cur === stop) {
      return null;
    }
    const parent = dirname(cur);
    if (parent === cur) {
      return null;
    }
    if (stop && !isPathInside(parent, stop)) {
      return null;
    }
    cur = parent;
  }
}

export function inferComponentFromCwd({ rootDir, invokedCwd, components }) {
  const cwd = String(invokedCwd ?? '').trim();
  const list = Array.isArray(components) ? components : [];
  if (!rootDir || !cwd || !list.length) {
    return null;
  }

  const abs = resolve(cwd);
  const componentsDir = getComponentsDir(rootDir);
  const worktreesRoot = getWorktreesRoot(rootDir);

  for (const component of list) {
    const c = String(component ?? '').trim();
    if (!c) continue;

    const wtBase = resolve(join(worktreesRoot, c));
    if (isPathInside(abs, wtBase)) {
      const repoDir = findGitRoot(abs, wtBase);
      if (repoDir) {
        return { component: c, repoDir };
      }
    }

    const primaryBase = resolve(join(componentsDir, c));
    if (isPathInside(abs, primaryBase)) {
      const repoDir = findGitRoot(abs, primaryBase);
      if (repoDir) {
        return { component: c, repoDir };
      }
    }
  }

  return null;
}

