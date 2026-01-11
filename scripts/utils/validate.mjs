import { resolve, sep } from 'node:path';
import { getComponentsDir } from './paths.mjs';

function isInside(path, dir) {
  const p = resolve(path);
  const d = resolve(dir);
  return p === d || p.startsWith(d.endsWith(sep) ? d : d + sep);
}

export function detectServerComponentDirMismatch({ rootDir, serverComponentName, serverDir }) {
  const componentsDir = getComponentsDir(rootDir);

  const other = serverComponentName === 'happy-server-light' ? 'happy-server' : serverComponentName === 'happy-server' ? 'happy-server-light' : null;
  if (!other) {
    return null;
  }

  const otherRepo = resolve(componentsDir, other);
  const otherWts = resolve(componentsDir, '.worktrees', other);

  if (isInside(serverDir, otherRepo) || isInside(serverDir, otherWts)) {
    return { expected: serverComponentName, actual: other, serverDir };
  }

  return null;
}

export function assertServerComponentDirMatches({ rootDir, serverComponentName, serverDir }) {
  const mismatch = detectServerComponentDirMismatch({ rootDir, serverComponentName, serverDir });
  if (!mismatch) {
    return;
  }

  const hint =
    mismatch.expected === 'happy-server-light'
      ? 'Fix: either switch flavor (`happys srv use happy-server`) or switch the active checkout for happy-server-light (`happys wt use happy-server-light default` or a worktree under .worktrees/happy-server-light/).'
      : 'Fix: either switch flavor (`happys srv use happy-server-light`) or switch the active checkout for happy-server (`happys wt use happy-server default` or a worktree under .worktrees/happy-server/).';

  throw new Error(
    `[server] server component dir mismatch:\n` +
      `- selected flavor: ${mismatch.expected}\n` +
      `- but HAPPY_STACKS_COMPONENT_DIR_* points inside: ${mismatch.actual}\n` +
      `- path: ${mismatch.serverDir}\n` +
      `${hint}`
  );
}

