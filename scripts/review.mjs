import './utils/env/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { getInvokedCwd, inferComponentFromCwd } from './utils/cli/cwd_scope.mjs';
import { assertCliPrereqs } from './utils/cli/prereqs.mjs';
import { resolveBaseRef } from './utils/review/base_ref.mjs';
import { isStackMode, resolveDefaultStackReviewComponents } from './utils/review/targets.mjs';
import { runWithConcurrencyLimit } from './utils/proc/parallel.mjs';
import { runCodeRabbitReview } from './utils/review/runners/coderabbit.mjs';
import { extractCodexReviewFromJsonl, runCodexReview } from './utils/review/runners/codex.mjs';

const DEFAULT_COMPONENTS = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];
const VALID_COMPONENTS = DEFAULT_COMPONENTS;
const VALID_REVIEWERS = ['coderabbit', 'codex'];

function parseCsv(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function normalizeReviewers(list) {
  const raw = Array.isArray(list) ? list : [];
  const lower = raw.map((r) => String(r).trim().toLowerCase()).filter(Boolean);
  const uniq = Array.from(new Set(lower));
  return uniq.length ? uniq : ['coderabbit'];
}

function usage() {
  return [
    '[review] usage:',
    '  happys review [component...] [--reviewers=coderabbit,codex] [--base-remote=<remote>] [--base-branch=<branch>] [--base-ref=<ref>] [--concurrency=N] [--json]',
    '',
    'components:',
    `  ${VALID_COMPONENTS.join(' | ')}`,
    '',
    'reviewers:',
    `  ${VALID_REVIEWERS.join(' | ')}`,
    '',
    'notes:',
    '- If run from inside a component checkout/worktree and no components are provided, defaults to that component.',
    '- In stack mode (invoked via `happys stack review <stack>`), if no components are provided, defaults to stack-pinned non-default components only.',
    '',
    'examples:',
    '  happys review',
    '  happys review happy-cli --reviewers=coderabbit,codex',
    '  happys stack review exp1 --reviewers=codex',
    '  happys review happy --base-remote=upstream --base-branch=main',
  ].join('\n');
}

function resolveComponentFromCwdOrNull({ rootDir, invokedCwd }) {
  return inferComponentFromCwd({ rootDir, invokedCwd, components: DEFAULT_COMPONENTS });
}

function stackRemoteFallbackFromEnv(env) {
  return String(env.HAPPY_STACKS_STACK_REMOTE ?? env.HAPPY_LOCAL_STACK_REMOTE ?? '').trim();
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usage() }, text: usage() });
    return;
  }

  const rootDir = getRootDir(import.meta.url);
  const invokedCwd = getInvokedCwd(process.env);
  const positionals = argv.filter((a) => !a.startsWith('--'));

  const reviewers = normalizeReviewers(parseCsv(kv.get('--reviewers') ?? ''));
  for (const r of reviewers) {
    if (!VALID_REVIEWERS.includes(r)) {
      throw new Error(`[review] unknown reviewer: ${r} (expected one of: ${VALID_REVIEWERS.join(', ')})`);
    }
  }

  await assertCliPrereqs({
    git: true,
    coderabbit: reviewers.includes('coderabbit'),
    codex: reviewers.includes('codex'),
  });

  const inferred = positionals.length === 0 ? resolveComponentFromCwdOrNull({ rootDir, invokedCwd }) : null;
  if (inferred) {
    // Make downstream getComponentDir() resolve to the inferred repo dir for this run.
    process.env[`HAPPY_STACKS_COMPONENT_DIR_${inferred.component.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`] = inferred.repoDir;
  }

  const inStackMode = isStackMode(process.env);
  const requestedComponents = positionals.length ? positionals : inferred ? [inferred.component] : ['all'];
  const wantAll = requestedComponents.includes('all');

  let components = wantAll ? DEFAULT_COMPONENTS : requestedComponents;
  if (!positionals.length && !inferred && inStackMode) {
    const pinned = resolveDefaultStackReviewComponents({ rootDir, components: DEFAULT_COMPONENTS });
    components = pinned.length ? pinned : [];
  }

  for (const c of components) {
    if (!VALID_COMPONENTS.includes(c)) {
      throw new Error(`[review] unknown component: ${c} (expected one of: ${VALID_COMPONENTS.join(', ')})`);
    }
  }

  if (!components.length) {
    const msg = inStackMode ? '[review] no non-default stack-pinned components to review' : '[review] no components selected';
    printResult({ json, data: { ok: true, skipped: true, reason: msg }, text: msg });
    return;
  }

  const baseRefOverride = (kv.get('--base-ref') ?? '').trim();
  const baseRemoteOverride = (kv.get('--base-remote') ?? '').trim();
  const baseBranchOverride = (kv.get('--base-branch') ?? '').trim();
  const stackRemoteFallback = stackRemoteFallbackFromEnv(process.env);
  const concurrency = (kv.get('--concurrency') ?? '').trim();
  const limit = concurrency ? Number(concurrency) : 4;

  const jobs = [];
  for (const component of components) {
    const repoDir = getComponentDir(rootDir, component);
    jobs.push({ component, repoDir });
  }

  const jobResults = await runWithConcurrencyLimit({
    items: jobs,
    limit,
    fn: async (job) => {
      const { component, repoDir } = job;
      const base = await resolveBaseRef({
        cwd: repoDir,
        baseRefOverride,
        baseRemoteOverride,
        baseBranchOverride,
        stackRemoteFallback,
      });

      const perReviewer = await Promise.all(
        reviewers.map(async (reviewer) => {
          if (reviewer === 'coderabbit') {
            const res = await runCodeRabbitReview({ repoDir, baseRef: base.baseRef, env: process.env });
            return {
              reviewer,
              ok: Boolean(res.ok),
              exitCode: res.exitCode,
              signal: res.signal,
              durationMs: res.durationMs,
              stdout: res.stdout ?? '',
              stderr: res.stderr ?? '',
            };
          }
          if (reviewer === 'codex') {
            const res = await runCodexReview({ repoDir, baseRef: base.baseRef, env: process.env, jsonMode: true });
            const extracted = extractCodexReviewFromJsonl(res.stdout ?? '');
            return {
              reviewer,
              ok: Boolean(res.ok),
              exitCode: res.exitCode,
              signal: res.signal,
              durationMs: res.durationMs,
              stdout: res.stdout ?? '',
              stderr: res.stderr ?? '',
              review_output: extracted,
            };
          }
          return { reviewer, ok: false, exitCode: null, signal: null, durationMs: 0, stdout: '', stderr: 'unknown reviewer\n' };
        })
      );

      return { component, repoDir, base, results: perReviewer };
    },
  });

  const ok = jobResults.every((r) => r.results.every((x) => x.ok));
  if (json) {
    printResult({ json, data: { ok, reviewers, components, results: jobResults } });
    if (!ok) process.exit(1);
    return;
  }

  const lines = [];
  lines.push('[review] results:');
  for (const r of jobResults) {
    lines.push('============================================================================');
    lines.push(`component: ${r.component}`);
    lines.push(`dir: ${r.repoDir}`);
    lines.push(`baseRef: ${r.base.baseRef}`);
    for (const rr of r.results) {
      lines.push('');
      const status = rr.ok ? '✅ ok' : '❌ failed';
      lines.push(`[${rr.reviewer}] ${status} (exit=${rr.exitCode ?? 'null'} durMs=${rr.durationMs ?? '?'})`);
      if (rr.stderr) {
        lines.push('--- stderr ---');
        lines.push(String(rr.stderr).trimEnd());
      }
      if (rr.stdout) {
        lines.push('--- stdout ---');
        lines.push(String(rr.stdout).trimEnd());
      }
    }
    lines.push('');
  }
  lines.push(ok ? '[review] ok' : '[review] failed');
  printResult({ json: false, text: lines.join('\n') });
  if (!ok) process.exit(1);
}

main().catch((err) => {
  console.error('[review] failed:', err);
  process.exit(1);
});
