import './utils/env/env.mjs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { pathExists } from './utils/fs/fs.mjs';
import { run, runCapture } from './utils/proc/proc.mjs';
import { isHappyMonorepoRoot } from './utils/paths/paths.mjs';
import { isTty, prompt, promptSelect, withRl } from './utils/cli/wizard.mjs';
import { bold, cyan, dim, green, red, yellow } from './utils/ui/ansi.mjs';
import { clipboardAvailable, copyTextToClipboard } from './utils/ui/clipboard.mjs';
import { detectInstalledLlmTools } from './utils/llm/tools.mjs';

function usage() {
  return [
    '[monorepo] usage:',
    '  happys monorepo port --target=/abs/path/to/monorepo [--branch=port/<name>] [--base=<ref>] [--onto-current] [--dry-run] [--3way] [--skip-applied] [--continue-on-failure] [--json]',
    '  happys monorepo port guide [--target=/abs/path/to/monorepo] [--json]',
    '  happys monorepo port status [--target=/abs/path/to/monorepo] [--json]',
    '  happys monorepo port continue [--target=/abs/path/to/monorepo] [--json]',
    '  happys monorepo port llm --target=/abs/path/to/monorepo [--copy] [--json]',
    '    [--from-happy=/abs/path/to/old-happy --from-happy-base=<ref> --from-happy-ref=<ref>]',
    '    [--from-happy-cli=/abs/path/to/old-happy-cli --from-happy-cli-base=<ref> --from-happy-cli-ref=<ref>]',
    '    [--from-happy-server=/abs/path/to/old-happy-server --from-happy-server-base=<ref> --from-happy-server-ref=<ref>]',
    '',
    'what it does:',
    '- Best-effort ports commits from split repos into the slopus/happy monorepo layout by applying patches into:',
    '  - old happy (UI)        -> expo-app/',
    '  - old happy-cli (CLI)   -> cli/',
    '  - old happy-server      -> server/',
    '',
    'notes:',
    '- This preserves commit messages/authors (via `git format-patch` + `git am`).',
    '- The target monorepo should already contain the "base" version of each subtree (typically a clean checkout of upstream/main).',
    '- Already-applied patches are auto-skipped when detected (exact-match via reverse apply-check).',
    '- Identical \"new file\" patches are auto-skipped when the target already contains the same file content.',
    '- Conflicts may require manual resolution. If `git am` stops, fix conflicts then run:',
    '    git am --continue',
    '  or abort with:',
    '    git am --abort',
    '',
    'LLM tip:',
    '- If you want an LLM to help resolve conflicts, run:',
    '    happys monorepo port llm --target=/abs/path/to/monorepo --copy',
    '  then paste the copied prompt into your LLM.',
  ].join('\n');
}

async function git(cwd, args, options = {}) {
  return await runCapture('git', args, { cwd, ...options });
}

async function gitOk(cwd, args) {
  try {
    await git(cwd, args);
    return true;
  } catch {
    return false;
  }
}

async function resolveGitRoot(dir) {
  const d = resolve(String(dir ?? '').trim());
  if (!d) return '';
  try {
    return (await git(d, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return '';
  }
}

async function ensureCleanGitWorktree(repoRoot) {
  const dirty = (await git(repoRoot, ['status', '--porcelain'])).trim();
  if (dirty) {
    throw new Error(`[monorepo] target repo is not clean: ${repoRoot}\n[monorepo] fix: commit/stash changes and re-run`);
  }
}

async function ensureNoGitAmInProgress(repoRoot) {
  try {
    const rel = (await git(repoRoot, ['rev-parse', '--git-path', 'rebase-apply'])).trim();
    if (!rel) return;
    const p = rel.startsWith('/') ? rel : join(repoRoot, rel);
    if (!(await pathExists(p))) return;
    if ((await pathExists(join(p, 'applying'))) || (await pathExists(join(p, 'patch')))) {
      throw new Error(
        [
          '[monorepo] a git am operation is already in progress in the target repo.',
          '[monorepo] fix: resolve it first, then re-run.',
          `- continue: git -C ${repoRoot} am --continue`,
          `- abort:    git -C ${repoRoot} am --abort`,
        ].join('\n')
      );
    }
  } catch (err) {
    // If git isn't happy with --git-path for some reason, fail open; the later git am will fail anyway.
    if (String(err?.message ?? '').includes('a git am operation is already in progress')) throw err;
  }
}

async function isGitAmInProgress(repoRoot) {
  try {
    const rel = (await git(repoRoot, ['rev-parse', '--git-path', 'rebase-apply'])).trim();
    if (!rel) return false;
    const p = rel.startsWith('/') ? rel : join(repoRoot, rel);
    if (!(await pathExists(p))) return false;
    if ((await pathExists(join(p, 'applying'))) || (await pathExists(join(p, 'patch')))) return true;
    return false;
  } catch {
    return false;
  }
}

async function ensureBranch(repoRoot, branch) {
  const b = String(branch ?? '').trim();
  if (!b) return;
  const exists = await gitOk(repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`]);
  if (exists) {
    throw new Error(`[monorepo] target branch already exists: ${b}\n[monorepo] fix: pick a new --branch name`);
  }
  await git(repoRoot, ['checkout', '-b', b]);
}

async function resolveDefaultBaseRef(sourceRepoRoot) {
  const candidates = ['upstream/main', 'origin/main', 'main', 'master'];
  for (const c of candidates) {
    if (await gitOk(sourceRepoRoot, ['rev-parse', '--verify', '--quiet', c])) {
      return c;
    }
  }
  return '';
}

async function resolveDefaultTargetBaseRef(targetRepoRoot) {
  try {
    const sym = (await git(targetRepoRoot, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])).trim();
    const m = /^refs\/remotes\/origin\/(.+)$/.exec(sym);
    if (m?.[1]) {
      const ref = `origin/${m[1]}`;
      if (await gitOk(targetRepoRoot, ['rev-parse', '--verify', '--quiet', ref])) {
        return ref;
      }
    }
  } catch {
    // ignore
  }
  return await resolveDefaultBaseRef(targetRepoRoot);
}

async function resolveTargetRepoRootFromArgs({ kv }) {
  const target = (kv.get('--target') ?? '').trim();
  const targetHint = target || process.cwd();
  const repoRoot = await resolveGitRoot(targetHint);
  if (!repoRoot) {
    throw new Error(`[monorepo] target is not a git repo: ${targetHint}`);
  }
  if (!isHappyMonorepoRoot(repoRoot)) {
    throw new Error(`[monorepo] target does not look like a slopus/happy monorepo root (missing expo-app/cli/server): ${repoRoot}`);
  }
  return repoRoot;
}

async function resolveGitPath(repoRoot, relPath) {
  const rel = (await git(repoRoot, ['rev-parse', '--git-path', relPath])).trim();
  if (!rel) return '';
  return rel.startsWith('/') ? rel : join(repoRoot, rel);
}

function section(title) {
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold(title));
}

function noteLine(s) {
  // eslint-disable-next-line no-console
  console.log(dim(s));
}

async function resolvePortPlanPath(targetRepoRoot) {
  return await resolveGitPath(targetRepoRoot, 'happy-stacks/monorepo-port-plan.json');
}

async function writePortPlan(targetRepoRoot, plan) {
  const p = await resolvePortPlanPath(targetRepoRoot);
  if (!p) return '';
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify(plan ?? null, null, 2) + '\n', 'utf-8');
  return p;
}

async function readPortPlan(targetRepoRoot) {
  const p = await resolvePortPlanPath(targetRepoRoot);
  if (!p) return { path: '', plan: null };
  if (!(await pathExists(p))) return { path: p, plan: null };
  try {
    const raw = await readFile(p, 'utf-8');
    return { path: p, plan: JSON.parse(raw) };
  } catch {
    return { path: p, plan: null };
  }
}

async function deletePortPlan(targetRepoRoot) {
  const p = await resolvePortPlanPath(targetRepoRoot);
  if (!p) return;
  await rm(p, { force: true });
}

async function listConflictedFiles(repoRoot) {
  const out = (await git(repoRoot, ['status', '--porcelain'])).trim();
  if (!out) return [];
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    // Porcelain v1: XY <path>
    // Unmerged states include: UU, AA, DD, AU, UA, DU, UD
    const xy = line.slice(0, 2);
    const isUnmerged = xy.includes('U') || xy === 'AA' || xy === 'DD';
    if (!isUnmerged) continue;
    const path = line.slice(3).trim();
    if (path) files.push(path);
  }
  return Array.from(new Set(files)).sort();
}

async function formatPatchesToDir({ sourceRepoRoot, base, head, outDir }) {
  await run('git', ['format-patch', '--quiet', '--output-directory', outDir, `${base}..${head}`], { cwd: sourceRepoRoot });
  const entries = await readdir(outDir, { withFileTypes: true });
  const patches = entries
    .filter((e) => e.isFile() && e.name.endsWith('.patch'))
    .map((e) => join(outDir, e.name))
    .sort();
  return patches;
}

function parsePatchMeta(patchText) {
  const lines = patchText.split(/\r?\n/);
  let fromSha = '';
  let subject = '';
  for (const line of lines) {
    if (!fromSha && line.startsWith('From ')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length >= 2) fromSha = parts[1];
      continue;
    }
    if (!subject && line.startsWith('Subject:')) {
      subject = line.slice('Subject:'.length).trim();
      continue;
    }
    if (fromSha && subject) break;
  }
  return { fromSha, subject };
}

function parseApplyErrorPaths(errText) {
  const text = String(errText ?? '').trim();
  if (!text) return { kind: 'unknown', paths: [] };
  const paths = new Set();

  for (const m of text.matchAll(/error:\s+(\S+):\s+already exists in working directory/g)) {
    if (m?.[1]) paths.add(m[1]);
  }
  for (const m of text.matchAll(/error:\s+patch failed:\s+(\S+):\d+/g)) {
    if (m?.[1]) paths.add(m[1]);
  }
  for (const m of text.matchAll(/error:\s+(\S+):\s+does not exist in index/g)) {
    if (m?.[1]) paths.add(m[1]);
  }
  for (const m of text.matchAll(/error:\s+(\S+):\s+No such file or directory/g)) {
    if (m?.[1]) paths.add(m[1]);
  }

  const kind = text.includes('already exists in working directory')
    ? 'already_exists'
    : text.includes('patch does not apply') || text.includes('patch failed:')
      ? 'patch_failed'
      : text.includes('does not exist in index') || text.includes('No such file or directory')
        ? 'missing_path'
        : 'unknown';

  return { kind, paths: Array.from(paths) };
}

function extractUnifiedDiffs(patchText) {
  const lines = patchText.split(/\r?\n/);
  const diffs = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.startsWith('diff --git ')) {
      i += 1;
      continue;
    }

    const m = /^diff --git a\/(.+?) b\/(.+?)$/.exec(line.trim());
    const bPath = m?.[2] ?? '';
    const diff = {
      bPath,
      plusPath: '',
      isNewFile: false,
      isDeletedFile: false,
      isBinary: false,
      noTrailingNewline: false,
      addedLines: [],
    };

    i += 1;
    let inHunk = false;
    while (i < lines.length && !lines[i].startsWith('diff --git ')) {
      const l = lines[i];
      if (l.startsWith('new file mode')) diff.isNewFile = true;
      if (l.startsWith('deleted file mode')) diff.isDeletedFile = true;
      if (l.startsWith('GIT binary patch')) diff.isBinary = true;
      if (l.startsWith('--- /dev/null')) diff.isNewFile = true;
      if (l.startsWith('+++ /dev/null')) diff.isDeletedFile = true;
      if (l.startsWith('+++ b/')) diff.plusPath = l.slice('+++ b/'.length).trim();
      if (l.startsWith('@@ ')) inHunk = true;
      if (inHunk) {
        if (l === '\\ No newline at end of file') {
          diff.noTrailingNewline = true;
        } else if (l.startsWith('+') && !l.startsWith('+++ ')) {
          diff.addedLines.push(l.slice(1));
        }
      }
      i += 1;
    }

    diffs.push(diff);
  }
  return diffs;
}

async function checkPureNewFilesAlreadyExistIdentically({ targetRepoRoot, directory, patchText }) {
  const diffs = extractUnifiedDiffs(patchText);
  if (!diffs.length) return { ok: false, paths: [] };

  // Only safe to auto-skip if this patch contains *only* new files.
  if (diffs.some((d) => !d.isNewFile || d.isDeletedFile || d.isBinary)) {
    return { ok: false, paths: [] };
  }

  const prefix = directory ? `${directory}/` : '';
  const paths = [];
  for (const d of diffs) {
    const rel = d.plusPath || d.bPath;
    if (!rel) return { ok: false, paths: [] };

    let expected = '';
    if (d.addedLines.length > 0) {
      expected = d.addedLines.join('\n') + '\n';
      if (d.noTrailingNewline && expected.endsWith('\n')) {
        expected = expected.slice(0, -1);
      }
    }

    const full = join(targetRepoRoot, `${prefix}${rel}`);
    let actual = '';
    try {
      // eslint-disable-next-line no-await-in-loop
      actual = await readFile(full, 'utf-8');
    } catch {
      return { ok: false, paths: [] };
    }
    if (actual !== expected) {
      return { ok: false, paths: [] };
    }
    paths.push(`${prefix}${rel}`);
  }

  return { ok: true, paths };
}

async function applyPatches({ targetRepoRoot, directory, patches, threeWay, skipApplied, continueOnFailure, quietGit }) {
  if (!patches.length) {
    return { applied: [], skippedAlreadyApplied: [], skippedAlreadyExistsIdentical: [], failed: [] };
  }
  const dirArgs = directory ? ['--directory', `${directory}/`] : [];
  const applied = [];
  const skippedAlreadyApplied = [];
  const skippedAlreadyExistsIdentical = [];
  const failed = [];

  for (const patch of patches) {
    const patchFile = basename(patch);
    // eslint-disable-next-line no-await-in-loop
    const patchText = await readFile(patch, 'utf-8');
    const { fromSha, subject } = parsePatchMeta(patchText);
    const entry = { patch: patchFile, fromSha, subject };

    // Preflight check (fast-ish): is this patch clearly already present or a no-op?
    let applyCheckErr = '';
    let appliesCleanly = false;
    try {
      // eslint-disable-next-line no-await-in-loop
      await runCapture('git', ['apply', '--check', ...dirArgs, patch], { cwd: targetRepoRoot });
      appliesCleanly = true;
    } catch (e) {
      appliesCleanly = false;
      applyCheckErr = String(e?.err ?? e?.message ?? e ?? '').trim();
    }

    if (!appliesCleanly) {
      // Auto-skip identical "new file" patches when the target already contains the same content.
      // This commonly happens when a commit was already folded into the monorepo history during migration.
      // eslint-disable-next-line no-await-in-loop
      const identical = await checkPureNewFilesAlreadyExistIdentically({ targetRepoRoot, directory, patchText });
      if (identical.ok) {
        skippedAlreadyExistsIdentical.push({ ...entry, paths: identical.paths });
        continue;
      }

      // If the reverse patch applies, the change is already present.
      //
      // This is safe (it requires an exact match of the patch content) and avoids stopping early
      // when the monorepo already includes some split-repo commits.
      //
      // `--skip-applied` is kept as a compatibility flag (and a hint to users), but the behavior is effectively always-on.
      let reverseApplies = false;
      try {
        // eslint-disable-next-line no-await-in-loop
        await runCapture('git', ['apply', '-R', '--check', ...dirArgs, patch], { cwd: targetRepoRoot });
        reverseApplies = true;
      } catch {
        reverseApplies = false;
      }
      if (reverseApplies) {
        skippedAlreadyApplied.push(entry);
        continue;
      }
    }

    // Apply with full mailinfo/commit metadata. This may succeed even when `git apply --check` fails (e.g. with --3way).
    try {
      const tryAm = async ({ use3way }) => {
        const args = ['am', '--quiet', ...(use3way ? ['--3way'] : []), ...dirArgs, patch];
        if (quietGit) {
          // eslint-disable-next-line no-await-in-loop
          await runCapture('git', args, { cwd: targetRepoRoot });
        } else {
          // eslint-disable-next-line no-await-in-loop
          await run('git', args, { cwd: targetRepoRoot });
        }
      };

      try {
        // eslint-disable-next-line no-await-in-loop
        await tryAm({ use3way: threeWay });
      } catch (amErr) {
        const amText = String(amErr?.err ?? amErr?.message ?? amErr ?? '').trim();
        const ancestorFail =
          threeWay &&
          (amText.includes('could not build fake ancestor') || amText.includes('sha1 information is lacking or useless'));
        if (!ancestorFail) {
          throw amErr;
        }

        // `git am --3way` requires the blob(s) referenced by the patch to exist in the target repo's object database.
        // When porting into a minimal or mismatched target, those blobs may not exist, causing a hard failure.
        // Fall back to non-3way so users can resolve the patch manually.
        // eslint-disable-next-line no-await-in-loop
        await run('git', ['am', '--abort'], { cwd: targetRepoRoot, stdio: 'ignore' }).catch(() => {});
        // eslint-disable-next-line no-await-in-loop
        await tryAm({ use3way: false });
      }
      applied.push(entry);
    } catch (e) {
      const err = String(e?.err ?? e?.message ?? e ?? '').trim();
      const applyMeta = parseApplyErrorPaths(applyCheckErr || '');
      const amMeta = parseApplyErrorPaths(err || '');
      failed.push({
        ...entry,
        applyCheckErr,
        err,
        kind: applyMeta.kind === 'unknown' ? amMeta.kind : applyMeta.kind,
        paths: Array.from(new Set([...(applyMeta.paths ?? []), ...(amMeta.paths ?? [])])),
      });
      if (!continueOnFailure) {
        throw new Error(
          [
            `[monorepo] failed applying patch: ${subject || patchFile}`,
            fromSha ? `[monorepo] from: ${fromSha}` : '',
            applyCheckErr ? `[monorepo] apply --check:\n${applyCheckErr}` : '',
            err ? `[monorepo] git am:\n${err}` : '',
            '[monorepo] fix: resolve conflicts then run `git am --continue` (or abort with `git am --abort`)',
          ]
            .filter(Boolean)
            .join('\n')
        );
      }

      // Best-effort mode: abort and continue.
      // eslint-disable-next-line no-await-in-loop
      await run('git', ['am', '--abort'], { cwd: targetRepoRoot, stdio: 'ignore' }).catch(() => {});
    }
  }

  return {
    applied,
    skippedAlreadyApplied,
    skippedAlreadyExistsIdentical,
    failed,
  };
}

async function portOne({
  label,
  sourcePath,
  sourceRef,
  sourceBase,
  targetRepoRoot,
  targetSubdir,
  dryRun,
  threeWay,
  skipApplied,
  continueOnFailure,
  quietGit,
}) {
  const sourceRepoRoot = await resolveGitRoot(sourcePath);
  if (!sourceRepoRoot) {
    throw new Error(`[monorepo] ${label}: not a git repo: ${sourcePath}`);
  }
  const sourceIsMonorepo = isHappyMonorepoRoot(sourceRepoRoot);
  // If the source is already a monorepo, its patches already contain `expo-app/`, `cli/`, etc.
  // In that case, applying with `--directory <subdir>/` would double-prefix paths.
  const effectiveTargetSubdir = sourceIsMonorepo ? '' : targetSubdir;
  const head = (await git(sourceRepoRoot, ['rev-parse', '--verify', sourceRef || 'HEAD'])).trim();
  const baseRef = sourceBase || (await resolveDefaultBaseRef(sourceRepoRoot));
  if (!baseRef) {
    throw new Error(`[monorepo] ${label}: could not infer a base ref. Pass --${label}-base=<ref>.`);
  }
  const base = (await git(sourceRepoRoot, ['merge-base', baseRef, head])).trim();
  if (!base) {
    throw new Error(`[monorepo] ${label}: failed to compute merge-base for ${baseRef}..${head}`);
  }
  if (base === head) {
    return { label, sourceRepoRoot, baseRef, head, patches: 0, skipped: true, reason: 'no commits to port' };
  }

  const tmp = await mkdtemp(join(tmpdir(), 'happy-stacks-port-'));
  try {
    const patches = await formatPatchesToDir({ sourceRepoRoot, base, head, outDir: tmp });
    if (dryRun) {
      return {
        label,
        sourceRepoRoot,
        sourceIsMonorepo,
        baseRef,
        head,
        patches: patches.length,
        skipped: false,
        dryRun: true,
        targetSubdir: effectiveTargetSubdir || null,
      };
    }
    const res = await applyPatches({
      targetRepoRoot,
      directory: effectiveTargetSubdir,
      patches,
      threeWay,
      skipApplied,
      continueOnFailure,
      quietGit,
    });
    return {
      label,
      sourceRepoRoot,
      sourceIsMonorepo,
      baseRef,
      head,
      patches: patches.length,
      appliedPatches: res.applied.length,
      skippedAlreadyApplied: res.skippedAlreadyApplied.length,
      skippedAlreadyExistsIdentical: res.skippedAlreadyExistsIdentical.length,
      failedPatches: res.failed.length,
      report: res,
      skipped: false,
      targetSubdir: effectiveTargetSubdir || null,
    };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

async function cmdPortRun({ argv, flags, kv, json, silent = false }) {
  const target = (kv.get('--target') ?? '').trim();
  if (!target) {
    throw new Error('[monorepo] missing --target=/abs/path/to/monorepo');
  }

  const targetRepoRoot = await resolveGitRoot(target);
  if (!targetRepoRoot) {
    throw new Error(`[monorepo] target is not a git repo: ${target}`);
  }
  if (!isHappyMonorepoRoot(targetRepoRoot)) {
    throw new Error(
      `[monorepo] target does not look like a slopus/happy monorepo root (missing expo-app/cli/server): ${targetRepoRoot}`
    );
  }
  // Prefer a clearer error message if the user is in the middle of conflict resolution.
  // (A git am session often makes the worktree dirty, which would otherwise trigger a generic "not clean" error.)
  await ensureNoGitAmInProgress(targetRepoRoot);
  await ensureCleanGitWorktree(targetRepoRoot);

  const ontoCurrent = flags.has('--onto-current');
  const branchOverride = (kv.get('--branch') ?? '').trim();
  const baseOverride = (kv.get('--base') ?? '').trim();
  const dryRun = flags.has('--dry-run');
  const threeWay = flags.has('--3way');
  const skipApplied = flags.has('--skip-applied');
  const continueOnFailure = flags.has('--continue-on-failure');
  const quietGit = json;
  let baseRefUsed = null;
  let branchLabel = null;
  if (!dryRun) {
    if (ontoCurrent) {
      if (branchOverride) {
        throw new Error('[monorepo] --onto-current cannot be combined with --branch (it applies onto the currently checked-out branch)');
      }
      if (baseOverride) {
        throw new Error('[monorepo] --onto-current cannot be combined with --base (it does not checkout a base ref)');
      }
      baseRefUsed = null;
      branchLabel = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
    } else {
      const baseRef = baseOverride || (await resolveDefaultTargetBaseRef(targetRepoRoot));
      if (!baseRef) {
        throw new Error('[monorepo] could not infer a target base ref. Pass --base=<ref>.');
      }
      baseRefUsed = baseRef;
      const branch = branchOverride || `port/${Date.now()}`;
      branchLabel = branch;
      // Always start the port branch from a stable base (usually origin/main), rather than whatever is currently checked out.
      await git(targetRepoRoot, ['checkout', '--quiet', baseRef]);
      await ensureBranch(targetRepoRoot, branch);
    }
  } else {
    branchLabel = ontoCurrent ? 'onto-current' : branchOverride || `port/${Date.now()}`;
  }

  const sources = [
    {
      label: 'from-happy',
      path: (kv.get('--from-happy') ?? '').trim(),
      ref: (kv.get('--from-happy-ref') ?? '').trim(),
      base: (kv.get('--from-happy-base') ?? '').trim(),
      subdir: 'expo-app',
    },
    {
      label: 'from-happy-cli',
      path: (kv.get('--from-happy-cli') ?? '').trim(),
      ref: (kv.get('--from-happy-cli-ref') ?? '').trim(),
      base: (kv.get('--from-happy-cli-base') ?? '').trim(),
      subdir: 'cli',
    },
    {
      label: 'from-happy-server',
      path: (kv.get('--from-happy-server') ?? '').trim(),
      ref: (kv.get('--from-happy-server-ref') ?? '').trim(),
      base: (kv.get('--from-happy-server-base') ?? '').trim(),
      subdir: 'server',
    },
  ].filter((s) => s.path);

  if (!sources.length) {
    throw new Error('[monorepo] nothing to port. Provide at least one of: --from-happy, --from-happy-cli, --from-happy-server');
  }

  // Already checked above (keep just one check so errors stay consistent).

  const results = [];
  for (const s of sources) {
    if (!(await pathExists(s.path))) {
      throw new Error(`[monorepo] ${s.label}: source path does not exist: ${s.path}`);
    }
    // eslint-disable-next-line no-await-in-loop
    const r = await portOne({
      label: s.label,
      sourcePath: s.path,
      sourceRef: s.ref,
      sourceBase: s.base,
      targetRepoRoot,
      targetSubdir: s.subdir,
      dryRun,
      threeWay,
      skipApplied,
      continueOnFailure,
      quietGit,
    });
    results.push(r);
  }

  const ok = dryRun || results.every((r) => (r.failedPatches ?? 0) === 0);
  const summary = dryRun
    ? `[monorepo] dry run complete (${branchLabel})`
    : ok
      ? `[monorepo] port complete (${branchLabel})`
      : `[monorepo] port complete with failures (${branchLabel})`;
  const failureDetails = (() => {
    if (json || dryRun || ok) return '';
    const lines = [];
    for (const r of results) {
      const report = r.report;
      const failed = report?.failed ?? [];
      if (!failed.length) continue;
      lines.push('');
      lines.push(`[monorepo] ${r.label}: failed patches (${failed.length})`);
      for (const f of failed.slice(0, 12)) {
        const subj = String(f.subject ?? '').replace(/^\[PATCH \d+\/\d+\]\s*/, '');
        const kind = f.kind ? ` (${f.kind})` : '';
        const paths = (f.paths ?? []).slice(0, 3).join(', ');
        lines.push(`- ${subj || f.patch}${kind}${paths ? ` -> ${paths}` : ''}`);
      }
      if (failed.length > 12) {
        lines.push(`- ...and ${failed.length - 12} more`);
      }
    }
    return lines.join('\n');
  })();

  const hints = ok || json
    ? ''
    : [
        '',
        '[monorepo] next steps:',
        '- for a full machine-readable report: re-run with `--json`.',
        '- to resolve interactively (recommended): re-run without `--continue-on-failure` so it stops at the first conflict, then use `git am --continue`.',
      ].join('\n');

  const data = { ok, targetRepoRoot, branch: branchLabel, ontoCurrent, dryRun, base: baseRefUsed, results };
  if (!silent) {
    printResult({
      json,
      data,
      text: json ? '' : `${summary}${failureDetails}${hints}`,
    });
  }
  return data;
}

async function cmdPortStatus({ kv, json }) {
  const targetRepoRoot = await resolveTargetRepoRootFromArgs({ kv });
  const inProgress = await isGitAmInProgress(targetRepoRoot);
  const branch = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  const conflictedFiles = await listConflictedFiles(targetRepoRoot);

  let currentPatch = null;
  if (inProgress) {
    try {
      const raw = await git(targetRepoRoot, ['am', '--show-current-patch']);
      const meta = parsePatchMeta(raw);
      const diffs = extractUnifiedDiffs(raw);
      const filesRaw = Array.from(new Set(diffs.map((d) => d.plusPath || d.bPath).filter(Boolean))).sort();
      const files = [];
      for (const f of filesRaw) {
        // `git am --directory <subdir>` applies patches under a directory, but `--show-current-patch`
        // still shows the original (unprefixed) paths. Best-effort map them to the monorepo layout.
        // eslint-disable-next-line no-await-in-loop
        if (await pathExists(join(targetRepoRoot, f))) {
          files.push(f);
          continue;
        }
        const candidates = [`expo-app/${f}`, `cli/${f}`, `server/${f}`];
        let mapped = '';
        for (const c of candidates) {
          // eslint-disable-next-line no-await-in-loop
          if (await pathExists(join(targetRepoRoot, c))) {
            mapped = c;
            break;
          }
        }
        files.push(mapped || f);
      }
      currentPatch = { subject: meta.subject || '', fromSha: meta.fromSha || '', files, filesRaw };
    } catch {
      currentPatch = { subject: '', fromSha: '', files: [], filesRaw: [] };
    }
  }

  const text = (() => {
    if (json) return '';
    const lines = [];
    const okMark = inProgress ? yellow('!') : green('✓');
    lines.push(`${bold('[monorepo]')} ${bold('port status')} ${dim(`(${branch})`)} ${okMark}`);
    lines.push(`${dim('target:')} ${targetRepoRoot}`);
    lines.push(`${dim('git am in progress:')} ${inProgress ? yellow('yes') : green('no')}`);
    if (inProgress && currentPatch?.subject) {
      lines.push(`${dim('current patch:')} ${cyan(currentPatch.subject)}`);
    }
    if (inProgress && currentPatch?.files?.length) {
      lines.push(
        `${dim('patch files:')} ${currentPatch.files.slice(0, 6).join(', ')}${currentPatch.files.length > 6 ? dim(', ...') : ''}`
      );
    }
    if (conflictedFiles.length) {
      lines.push(`${yellow('conflicted files:')} ${dim(`(${conflictedFiles.length})`)}`);
      for (const f of conflictedFiles.slice(0, 20)) lines.push(`  - ${f}`);
      if (conflictedFiles.length > 20) lines.push(`  - ...and ${conflictedFiles.length - 20} more`);
    }
    if (inProgress) {
      lines.push('');
      lines.push(bold('[monorepo] next steps:'));
      lines.push(`- ${dim('resolve + stage:')} git -C ${targetRepoRoot} add <files>`);
      lines.push(`- ${dim('continue:')}       git -C ${targetRepoRoot} am --continue`);
      lines.push(`- ${dim('skip patch:')}     git -C ${targetRepoRoot} am --skip`);
      lines.push(`- ${dim('abort:')}          git -C ${targetRepoRoot} am --abort`);
      lines.push(`- ${dim('helper:')}         happys monorepo port continue --target=${targetRepoRoot}`);
    }
    return lines.join('\n');
  })();

  printResult({
    json,
    data: { ok: true, targetRepoRoot, branch, inProgress, currentPatch, conflictedFiles },
    text,
  });
}

async function cmdPortContinue({ kv, json }) {
  const targetRepoRoot = await resolveTargetRepoRootFromArgs({ kv });
  const runAmContinue = async () => {
    const inProgressBefore = await isGitAmInProgress(targetRepoRoot);
    if (!inProgressBefore) return { ok: true, didRun: false };
    try {
      await runCapture('git', ['am', '--continue'], { cwd: targetRepoRoot });
      return { ok: true, didRun: true };
    } catch (err) {
      const conflictedFiles = await listConflictedFiles(targetRepoRoot);
      const stderr = String(err?.err ?? err?.message ?? err ?? '').trim();
      const hint = [
        `${red('[monorepo]')} continue failed (still conflicted).`,
        conflictedFiles.length ? `[monorepo] conflicted files: ${conflictedFiles.join(', ')}` : '',
        stderr ? `[monorepo] git:\n${stderr}` : '',
        `[monorepo] next: resolve, then re-run: happys monorepo port continue --target=${targetRepoRoot}`,
      ]
        .filter(Boolean)
        .join('\n');
      printResult({
        json,
        data: { ok: false, targetRepoRoot, inProgress: true, conflictedFiles },
        text: json ? '' : hint,
      });
      process.exitCode = 1;
      return { ok: false, didRun: true };
    }
  };

  // 1) If an am session is in progress, advance it.
  const amRes = await runAmContinue();
  if (!amRes.ok) return;

  // 2) If we're no longer in an am session, and a guide plan exists, resume the port onto the current branch.
  const inProgressAfter = await isGitAmInProgress(targetRepoRoot);
  const branch = (await git(targetRepoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD';
  if (!inProgressAfter) {
    const { plan } = await readPortPlan(targetRepoRoot);
    if (plan?.resumeArgv && Array.isArray(plan.resumeArgv)) {
      try {
        const resumeArgv = [...plan.resumeArgv];
        const { flags, kv } = parseArgs(resumeArgv);
        const jsonWanted = json || wantsJson(resumeArgv, { flags });
        await cmdPortRun({ argv: resumeArgv, flags, kv, json: jsonWanted, silent: json === true });
        await deletePortPlan(targetRepoRoot);
      } catch {
        // cmdPortRun prints its own conflict context; leave the plan file so the user can retry after resolving.
        process.exitCode = process.exitCode ?? 1;
      }
    }
  }

  const stillInProgress = await isGitAmInProgress(targetRepoRoot);
  printResult({
    json,
    data: { ok: !stillInProgress, targetRepoRoot, branch, inProgress: stillInProgress },
    text: json
      ? ''
      : stillInProgress
        ? `${yellow('[monorepo]')} continue paused (conflicts remain) ${dim(`(${branch})`)}`
        : `${green('[monorepo]')} continue complete ${dim(`(${branch})`)}`,
  });
}

async function cmdPortGuide({ kv, json }) {
  if (!isTty()) {
    throw new Error('[monorepo] port guide requires a TTY. Re-run in an interactive terminal.');
  }

  const targetDefault = (kv.get('--target') ?? '').trim() || process.cwd();
  await withRl(async (rl) => {
    // eslint-disable-next-line no-console
    console.log(
      [
        '',
        bold(`✨ ${cyan('Happy Stacks')} monorepo port ✨`),
        '',
        'This wizard ports commits from split repos into the Happy monorepo layout:',
        `- ${cyan('happy')} → expo-app/`,
        `- ${cyan('happy-cli')} → cli/`,
        `- ${cyan('happy-server')} → server/`,
        '',
        bold('Notes:'),
        `- Uses ${cyan('git format-patch')} + ${cyan('git am')} (preserves author + messages)`,
        `- Stops on conflicts so you can resolve and continue`,
        '',
      ].join('\n')
    );

    const targetInput = (await prompt(rl, 'Target monorepo path: ', { defaultValue: targetDefault })).trim();
    const targetRepoRoot = await resolveGitRoot(targetInput);
    if (!targetRepoRoot || !isHappyMonorepoRoot(targetRepoRoot)) {
      throw new Error(`[monorepo] invalid target (expected slopus/happy monorepo root): ${targetInput}`);
    }
    await ensureCleanGitWorktree(targetRepoRoot);
    await ensureNoGitAmInProgress(targetRepoRoot);

    const baseDefault = await resolveDefaultTargetBaseRef(targetRepoRoot);
    const base = (await prompt(rl, 'Target base ref: ', { defaultValue: baseDefault || 'origin/main' })).trim();
    const branch = (await prompt(rl, 'New branch name: ', { defaultValue: `port/${Date.now()}` })).trim();
    const use3way =
      (await promptSelect(rl, {
        title: 'Use 3-way merge (recommended)?',
        options: [
          { label: 'yes (recommended)', value: true },
          { label: 'no', value: false },
        ],
        defaultIndex: 0,
      })) === true;

    const fromHappy = (await prompt(rl, 'Path to old happy repo (UI) [optional]: ', { defaultValue: '' })).trim();
    const fromHappyBase = fromHappy ? (await prompt(rl, 'old happy base ref: ', { defaultValue: 'upstream/main' })).trim() : '';
    const fromHappyCli = (await prompt(rl, 'Path to old happy-cli repo [optional]: ', { defaultValue: '' })).trim();
    const fromHappyCliBase = fromHappyCli ? (await prompt(rl, 'old happy-cli base ref: ', { defaultValue: 'upstream/main' })).trim() : '';
    const fromHappyServer = (await prompt(rl, 'Path to old happy-server repo [optional]: ', { defaultValue: '' })).trim();
    const fromHappyServerBase = fromHappyServer
      ? (await prompt(rl, 'old happy-server base ref: ', { defaultValue: 'upstream/main' })).trim()
      : '';

    if (!fromHappy && !fromHappyCli && !fromHappyServer) {
      throw new Error('[monorepo] guide: nothing to port. Provide at least one source path.');
    }

    section('Plan');
    noteLine(`${dim('target:')} ${targetRepoRoot}`);
    noteLine(`${dim('base:')}   ${base}`);
    noteLine(`${dim('branch:')} ${branch}`);
    noteLine(`${dim('3-way:')}  ${use3way ? green('enabled') : yellow('disabled')}`);
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(bold('Sources:'));
    if (fromHappy) noteLine(`- ${cyan('happy')}      ${fromHappy} ${dim(`(base=${fromHappyBase})`)}`);
    if (fromHappyCli) noteLine(`- ${cyan('happy-cli')}  ${fromHappyCli} ${dim(`(base=${fromHappyCliBase})`)}`);
    if (fromHappyServer) noteLine(`- ${cyan('happy-server')} ${fromHappyServer} ${dim(`(base=${fromHappyServerBase})`)}`);

    const baseSourceArgs = [
      ...(fromHappy ? [`--from-happy=${fromHappy}`, `--from-happy-base=${fromHappyBase}`] : []),
      ...(fromHappyCli ? [`--from-happy-cli=${fromHappyCli}`, `--from-happy-cli-base=${fromHappyCliBase}`] : []),
      ...(fromHappyServer ? [`--from-happy-server=${fromHappyServer}`, `--from-happy-server-base=${fromHappyServerBase}`] : []),
    ];

    const initialArgv = [
      'port',
      `--target=${targetRepoRoot}`,
      `--branch=${branch}`,
      `--base=${base}`,
      ...(use3way ? ['--3way'] : []),
      ...baseSourceArgs,
      ...(json ? ['--json'] : []),
    ];

    const resumeArgv = [
      'port',
      `--target=${targetRepoRoot}`,
      '--onto-current',
      ...(use3way ? ['--3way'] : []),
      ...baseSourceArgs,
      ...(json ? ['--json'] : []),
    ];

    await writePortPlan(targetRepoRoot, {
      version: 1,
      createdAt: new Date().toISOString(),
      targetRepoRoot,
      base,
      branch,
      use3way,
      resumeArgv,
    });

    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`${bold('[monorepo]')} guide: starting port ${dim(`(${branch})`)}`);

    let first = true;
    while (true) {
      const attemptArgv = first ? initialArgv : resumeArgv;
      first = false;
      const { flags: attemptFlags, kv: attemptKv } = parseArgs(attemptArgv);
      const jsonWanted = wantsJson(attemptArgv, { flags: attemptFlags });
      try {
        // eslint-disable-next-line no-await-in-loop
        await cmdPortRun({ argv: attemptArgv, flags: attemptFlags, kv: attemptKv, json: jsonWanted });
        break;
      } catch (e) {
        // If we stopped because of a git am conflict, drive an interactive resolution loop.
        // Otherwise, rethrow.
        // eslint-disable-next-line no-await-in-loop
        const inProgress = await isGitAmInProgress(targetRepoRoot);
        if (!inProgress) {
          throw e;
        }

        // eslint-disable-next-line no-console
        console.log('');
        // eslint-disable-next-line no-console
        console.log(`${yellow('[monorepo]')} guide: conflict detected`);
        // eslint-disable-next-line no-console
        console.log(dim('[monorepo] guide: waiting for conflict resolution'));

        while (await isGitAmInProgress(targetRepoRoot)) {
          // eslint-disable-next-line no-await-in-loop
          await cmdPortStatus({ kv: attemptKv, json: false });

          const action = await promptSelect(rl, {
            title: bold('Resolve conflicts, then choose an action:'),
            options: [
              { label: `${green('continue')} (git am --continue)`, value: 'continue' },
              { label: `${cyan('show status again')}`, value: 'status' },
              { label: `${cyan('llm prompt')} ${dim('(copy/paste)')}`, value: 'llm' },
              { label: `${yellow('skip current patch')} (git am --skip)`, value: 'skip' },
              { label: `${red('abort')} (git am --abort)`, value: 'abort' },
              { label: `${dim('quit guide (leave state as-is)')}`, value: 'quit' },
            ],
            defaultIndex: 0,
          });

          if (action === 'status') {
            continue;
          }
          if (action === 'llm') {
            const llmFlags = new Set([...(attemptFlags ?? []), '--copy']);
            // eslint-disable-next-line no-await-in-loop
            await cmdPortLlm({ kv: attemptKv, flags: llmFlags, json: false });
            continue;
          }
          if (action === 'abort') {
            await runCapture('git', ['am', '--abort'], { cwd: targetRepoRoot });
            await deletePortPlan(targetRepoRoot);
            throw new Error('[monorepo] guide aborted (git am --abort)');
          }
          if (action === 'skip') {
            await runCapture('git', ['am', '--skip'], { cwd: targetRepoRoot });
            continue;
          }
          if (action === 'quit') {
            throw new Error('[monorepo] guide stopped (git am still in progress). Run `happys monorepo port status` / `... continue` to proceed.');
          }

          // continue
          // eslint-disable-next-line no-await-in-loop
          await cmdPortContinue({ kv: attemptKv, json: false });
        }
      }
    }

    await deletePortPlan(targetRepoRoot);
    // eslint-disable-next-line no-console
    console.log(`${green('[monorepo]')} guide complete`);
  });
}

async function cmdPortLlm({ kv, flags, json }) {
  const targetRepoRoot = await resolveTargetRepoRootFromArgs({ kv });
  const promptText = [
    'You are an assistant helping the user port split-repo commits into the slopus/happy monorepo.',
    '',
    `Target monorepo root: ${targetRepoRoot}`,
    '',
    'How to run the port:',
    `- guided (recommended): happys monorepo port guide --target=${targetRepoRoot}`,
    `- machine-readable report: happys monorepo port --target=${targetRepoRoot} --json`,
    '',
    'If a conflict happens (git am in progress):',
    `- inspect state (JSON): happys monorepo port status --target=${targetRepoRoot} --json`,
    `- inspect state (text): happys monorepo port status --target=${targetRepoRoot}`,
    `- after fixing files:       git -C ${targetRepoRoot} am --continue`,
    `- or via wrapper:           happys monorepo port continue --target=${targetRepoRoot}`,
    `- to skip current patch:    git -C ${targetRepoRoot} am --skip`,
    `- to abort:                git -C ${targetRepoRoot} am --abort`,
    '',
    'Instructions:',
    '- Prefer minimal conflict resolutions that preserve intent.',
    '- Keep changes scoped to expo-app/, cli/, server/.',
    '- After each continue, re-check status until port completes.',
  ].join('\n');
  const tools = await detectInstalledLlmTools();

  if (json) {
    printResult({ json, data: { targetRepoRoot, prompt: promptText, detectedTools: tools.map((t) => t.id) } });
    return;
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('[monorepo] LLM prompt (copy/paste):'));
  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(promptText);
  if (tools.length) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(dim(`[monorepo] detected LLM CLIs: ${tools.map((t) => t.id).join(', ')}`));
  }

  const wantsCopy = flags?.has?.('--copy') || process.argv.includes('--copy');
  if (wantsCopy && (await clipboardAvailable())) {
    const res = await copyTextToClipboard(promptText);
    // eslint-disable-next-line no-console
    console.log(res.ok ? green('✓ Copied to clipboard') : dim(`(Clipboard copy failed: ${res.reason || 'unknown'})`));
  } else if (wantsCopy) {
    // eslint-disable-next-line no-console
    console.log(dim('(Clipboard copy unavailable on this system)'));
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const cmd = positionals[0] || 'help';
  const sub = positionals[1] || '';
  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({ json, data: {}, text: usage() });
    return;
  }

  if (cmd !== 'port') {
    throw new Error(`[monorepo] unknown subcommand: ${cmd} (expected: port)`);
  }

  if (sub === 'status') {
    await cmdPortStatus({ kv, json });
    return;
  }
  if (sub === 'continue') {
    await cmdPortContinue({ kv, json });
    return;
  }
  if (sub === 'guide') {
    await cmdPortGuide({ kv, json });
    return;
  }
  if (sub === 'llm') {
    await cmdPortLlm({ kv, flags, json });
    return;
  }

  await cmdPortRun({ argv, flags, kv, json });
}

main().catch((err) => {
  console.error('[monorepo] failed:', err);
  process.exit(1);
});
