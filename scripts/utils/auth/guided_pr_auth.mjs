import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isTty, promptSelect, withRl } from '../cli/wizard.mjs';
import { resolveStackEnvPath } from '../paths/paths.mjs';

function stackHasAccessKey(stackName) {
  try {
    const { baseDir, envPath } = resolveStackEnvPath(stackName);
    if (!existsSync(envPath)) return false;
    return existsSync(join(baseDir, 'cli', 'access.key'));
  } catch {
    return false;
  }
}

export function detectSeedableAuthSources() {
  const out = [];
  if (stackHasAccessKey('dev-auth')) out.push('dev-auth');
  if (stackHasAccessKey('main')) out.push('main');
  return out;
}

/**
 * Decide how a PR review stack should authenticate.
 *
 * This deliberately does NOT offer "legacy ~/.happy" sources:
 * for production/remote Happy installs we cannot reliably seed local DB Account rows, so it leads to broken stacks.
 */
export async function decidePrAuthPlan({
  interactive = isTty(),
  seedAuthFlag = null,
  explicitFrom = '',
  defaultLoginNow = true,
} = {}) {
  if (seedAuthFlag === false) return { mode: 'login', loginNow: defaultLoginNow };
  if (seedAuthFlag === true) {
    // Caller must supply from; if not, pick best available.
    const sources = detectSeedableAuthSources();
    const from = explicitFrom || sources[0] || 'main';
    return { mode: 'seed', from, link: true };
  }
  if (explicitFrom) {
    return { mode: 'seed', from: explicitFrom, link: true };
  }

  const sources = detectSeedableAuthSources();
  if (!interactive) {
    // Non-interactive default: prefer seeding only if explicitly configured elsewhere.
    // setup-pr will handle its own defaults.
    return { mode: 'auto', sources };
  }

  // Interactive prompt: keep it simple for reviewers.
  const choice = await withRl(async (rl) => {
    const opts = [];
    if (sources.length) {
      opts.push({ label: `reuse existing Happy Stacks auth (${sources.join(' / ')})`, value: 'seed' });
    }
    opts.push({ label: defaultLoginNow ? 'login now (recommended)' : 'login later', value: 'login' });
    return await promptSelect(rl, {
      title: 'Authentication for this PR stack:',
      options: opts,
      defaultIndex: 0,
    });
  });

  if (choice === 'seed' && sources.length) {
    let from = sources[0];
    if (sources.length > 1) {
      from = await withRl(async (rl) => {
        return await promptSelect(rl, {
          title: 'Which existing auth should we reuse?',
          options: sources.map((s) => ({ label: s, value: s })),
          defaultIndex: 0,
        });
      });
    }
    const link = await withRl(async (rl) => {
      return await promptSelect(rl, {
        title: 'When reusing, symlink or copy credentials?',
        options: [
          { label: 'symlink (recommended) — stays up to date', value: true },
          { label: 'copy — more isolated per stack', value: false },
        ],
        defaultIndex: 0,
      });
    });
    return { mode: 'seed', from: String(from), link: Boolean(link) };
  }

  return { mode: 'login', loginNow: defaultLoginNow };
}

