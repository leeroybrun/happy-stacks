import { runCaptureResult } from '../../proc/proc.mjs';
import { join } from 'node:path';

function normalizeType(raw) {
  const t = String(raw ?? '').trim().toLowerCase();
  if (!t) return 'committed';
  if (t === 'all' || t === 'committed' || t === 'uncommitted') return t;
  throw new Error(`[review] invalid coderabbit type: ${raw} (expected: all|committed|uncommitted)`);
}

export function buildCodeRabbitReviewArgs({ repoDir, baseRef, baseCommit, type, configFiles }) {
  const args = ['review', '--plain', '--no-color', '--type', normalizeType(type), '--cwd', repoDir];
  const base = String(baseRef ?? '').trim();
  const bc = String(baseCommit ?? '').trim();
  if (base && bc) {
    throw new Error('[review] coderabbit: baseRef and baseCommit are mutually exclusive');
  }
  if (base) args.push('--base', base);
  if (bc) args.push('--base-commit', bc);
  const files = Array.isArray(configFiles) ? configFiles.filter(Boolean) : [];
  if (files.length) args.push('--config', ...files);
  return args;
}

export function buildCodeRabbitEnv({ env, homeDir }) {
  const merged = { ...(env ?? {}) };
  const dir = String(homeDir ?? '').trim();
  if (!dir) return merged;

  merged.HOME = dir;
  merged.USERPROFILE = dir;
  merged.CODERABBIT_HOME = join(dir, '.coderabbit');
  merged.XDG_CONFIG_HOME = join(dir, '.config');
  merged.XDG_CACHE_HOME = join(dir, '.cache');
  merged.XDG_STATE_HOME = join(dir, '.local', 'state');
  merged.XDG_DATA_HOME = join(dir, '.local', 'share');
  return merged;
}

export async function runCodeRabbitReview({
  repoDir,
  baseRef,
  baseCommit,
  env,
  type = 'committed',
  configFiles = [],
  streamLabel,
  teeFile,
  teeLabel,
}) {
  const homeDir = (env?.HAPPY_STACKS_CODERABBIT_HOME_DIR ?? env?.HAPPY_LOCAL_CODERABBIT_HOME_DIR ?? '').toString().trim();
  const args = buildCodeRabbitReviewArgs({ repoDir, baseRef, baseCommit, type, configFiles });
  const res = await runCaptureResult('coderabbit', args, {
    cwd: repoDir,
    env: buildCodeRabbitEnv({ env, homeDir }),
    streamLabel,
    teeFile,
    teeLabel,
  });
  return { ...res, stdout: res.out, stderr: res.err };
}
