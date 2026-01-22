import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

import { run, runCapture } from './utils/proc/proc.mjs';

async function withTempRoot(t) {
  const dir = await mkdtemp(join(tmpdir(), 'happy-stacks-monorepo-port-'));
  t.after(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  return dir;
}

function gitEnv() {
  const clean = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('HAPPY_STACKS_') || k.startsWith('HAPPY_LOCAL_')) continue;
    clean[k] = v;
  }
  return {
    ...clean,
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };
}

test('monorepo port applies split-repo commits into subdirectories', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  // Seed the target with the "base" file so the ported patch has something to apply to.
  await writeFile(join(target, 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run port command
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port --skip-applied skips patches that are already present in the target', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub (already at v2 for cli/hello.txt)
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v2\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run port command with skip-applied
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-skip`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--skip-applied',
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port accepts monorepo sources without double-prefixing paths', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const source = join(root, 'source-mono');

  // Target monorepo stub
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'expo-app', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source monorepo repo with one change commit in expo-app/
  await mkdir(source, { recursive: true });
  await run('git', ['init', '-q'], { cwd: source, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: source, env: gitEnv() });
  await mkdir(join(source, 'expo-app'), { recursive: true });
  await mkdir(join(source, 'cli'), { recursive: true });
  await mkdir(join(source, 'server'), { recursive: true });
  await writeFile(join(source, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(source, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(source, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(source, 'expo-app', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: source, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init source monorepo'], { cwd: source, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: source, env: gitEnv() })).trim();
  await writeFile(join(source, 'expo-app', 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: source, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update expo-app hello'], { cwd: source, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-mono-source`,
      `--from-happy=${source}`,
      `--from-happy-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  const content = (await readFile(join(target, 'expo-app', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port --continue-on-failure completes even when some patches do not apply', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with v3 already (so v1->v2 patch won't apply, and also can't be detected as already-applied).
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run port command: patch should fail to apply, but command succeeds.
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-continue`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--skip-applied',
      '--continue-on-failure',
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, false);
  assert.equal(parsed.results[0].failedPatches, 1);
});

test('monorepo port auto-skips identical "new file" patches when the file already exists in the target', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub already contains cli/newfile.txt with the same content.
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'newfile.txt'), 'same\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo adds newfile.txt in a single commit.
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'newfile.txt'), 'same\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: add newfile'], { cwd: sourceCli, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-identical-newfile`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );

  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.results[0].failedPatches, 0);
  // This commit cannot be applied (it would "create" an existing file), so the port must skip it.
  assert.equal(parsed.results[0].appliedPatches, 0);
  assert.equal(parsed.results[0].skippedAlreadyApplied, 0);
  assert.equal(parsed.results[0].skippedAlreadyExistsIdentical, 1);
});

test('monorepo port --onto-current applies onto the currently checked-out branch', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub on a custom branch (so we can verify it doesn't switch).
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'existing'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2)
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--onto-current',
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const branch = (await runCapture('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: target, env: gitEnv() })).trim();
  assert.equal(branch, 'existing');
  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port branches from target default base (not current HEAD)', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub on main with cli/hello.txt=v1.
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Create a divergent branch and leave it checked out (simulates running port from a non-base branch).
  await run('git', ['checkout', '-q', '-b', 'dev'], { cwd: target, env: gitEnv() });
  await writeFile(join(target, 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: dev drift'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2).
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Port should branch from target main by default (not dev), so the v1->v2 patch applies.
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-target-base`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--json',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'v2\n');
});

test('monorepo port prints an actionable summary in non-json mode when patches fail', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt=v3 (so v1->v2 patch fails).
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'v3\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with one change commit (v1 -> v2).
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'v1\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'v2\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run without --json and ensure it prints a useful failure summary.
  const out = await runCapture(
    process.execPath,
    [
      join(process.cwd(), 'scripts', 'monorepo.mjs'),
      'port',
      `--target=${target}`,
      `--branch=port/test-nonjson`,
      `--from-happy-cli=${sourceCli}`,
      `--from-happy-cli-base=${base}`,
      '--continue-on-failure',
    ],
    { cwd: process.cwd(), env: gitEnv() }
  );

  assert.ok(out.includes('port complete with failures'), `expected failure summary in stdout\n${out}`);
  assert.ok(out.includes('feat: update hello'), `expected failed patch subject in stdout\n${out}`);
});

test('monorepo port status reports the current patch and conflicted files during git am', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with base="value=base" and a commit changing to "value=source".
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Start a port that will stop with an am conflict.
  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [
          join(process.cwd(), 'scripts', 'monorepo.mjs'),
          'port',
          `--target=${target}`,
          `--branch=port/test-status`,
          `--from-happy-cli=${sourceCli}`,
          `--from-happy-cli-base=${base}`,
          '--3way',
        ],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'status', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, true);
  assert.ok(parsed.currentPatch?.subject?.includes('feat: update hello'), `expected subject in status\n${out}`);
  // Depending on git's 3-way behavior, it may stop without creating unmerged entries.
  // In that case, status should still expose the file(s) touched by the current patch.
  assert.ok(
    parsed.conflictedFiles.includes('cli/hello.txt') || parsed.currentPatch?.files?.includes('cli/hello.txt'),
    `expected cli/hello.txt in conflictedFiles or currentPatch.files\n${out}`
  );
});

test('monorepo port continue runs git am --continue after conflicts are resolved', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo with base="value=base" and a commit changing to "value=source".
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  const base = (await runCapture('git', ['rev-parse', 'HEAD'], { cwd: sourceCli, env: gitEnv() })).trim();
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Start a port that will stop with an am conflict.
  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [
          join(process.cwd(), 'scripts', 'monorepo.mjs'),
          'port',
          `--target=${target}`,
          `--branch=port/test-continue-helper`,
          `--from-happy-cli=${sourceCli}`,
          `--from-happy-cli-base=${base}`,
          '--3way',
        ],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );

  // Resolve the conflict by choosing "value=source".
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });

  const out = await runCapture(
    process.execPath,
    [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'continue', `--target=${target}`, '--json'],
    { cwd: process.cwd(), env: gitEnv() }
  );
  const parsed = JSON.parse(out.trim());
  assert.equal(parsed.ok, true);
  assert.equal(parsed.inProgress, false);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});

test('monorepo port guide refuses to run in non-tty mode', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  await assert.rejects(
    async () =>
      await runCapture(
        process.execPath,
        [join(process.cwd(), 'scripts', 'monorepo.mjs'), 'port', 'guide', `--target=${target}`],
        { cwd: process.cwd(), env: gitEnv() }
      )
  );
});

test('monorepo port guide can wait for conflict resolution and finish the port', async (t) => {
  const root = await withTempRoot(t);
  const target = join(root, 'target-mono');
  const sourceCli = join(root, 'source-cli');

  // Target monorepo stub with cli/hello.txt="value=target".
  await mkdir(target, { recursive: true });
  await run('git', ['init', '-q'], { cwd: target, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: target, env: gitEnv() });
  await mkdir(join(target, 'expo-app'), { recursive: true });
  await mkdir(join(target, 'cli'), { recursive: true });
  await mkdir(join(target, 'server'), { recursive: true });
  await writeFile(join(target, 'expo-app', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'server', 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=target\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: target, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init monorepo'], { cwd: target, env: gitEnv() });

  // Source CLI repo: keep main at base commit, then branch for the change.
  await mkdir(sourceCli, { recursive: true });
  await run('git', ['init', '-q'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'main'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'package.json'), '{}\n', 'utf-8');
  await writeFile(join(sourceCli, 'hello.txt'), 'value=base\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'chore: init cli'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['checkout', '-q', '-b', 'feature'], { cwd: sourceCli, env: gitEnv() });
  await writeFile(join(sourceCli, 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', '.'], { cwd: sourceCli, env: gitEnv() });
  await run('git', ['commit', '-q', '-m', 'feat: update hello'], { cwd: sourceCli, env: gitEnv() });

  // Run guide in "test TTY" mode so it can prompt even under non-interactive test runners.
  const scriptPath = join(process.cwd(), 'scripts', 'monorepo.mjs');
  const inputLines = [
    target, // Target monorepo path
    'main', // Target base ref
    'port/test-guide', // New branch name
    '1', // Use 3-way merge: yes
    '', // Path to old happy (skip)
    sourceCli, // Path to old happy-cli
    'main', // old happy-cli base ref
    '', // Path to old happy-server (skip)
  ];

  const child = spawn(
    process.execPath,
    [scriptPath, 'port', 'guide'],
    { cwd: process.cwd(), env: { ...gitEnv(), HAPPY_STACKS_TEST_TTY: '1' }, stdio: ['pipe', 'pipe', 'pipe'] }
  );

  let out = '';
  let err = '';
  let conflictSeen = false;
  let finished = false;
  let exitCode = null;
  const waitFor = async (predicate, timeoutMs) => {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (predicate()) return;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timeout waiting for condition\nstdout:\n${out}\nstderr:\n${err}`);
  };

  child.stdout?.on('data', (d) => (out += d.toString()));
  child.stderr?.on('data', (d) => (err += d.toString()));
  child.on('exit', (code) => {
    finished = true;
    exitCode = code;
  });

  const sendLine = (line) => child.stdin?.write(String(line) + '\n');

  // Feed the wizard answers step-by-step (readline can be picky under non-tty runners).
  await waitFor(() => out.includes('Target monorepo path:'), 5_000);
  sendLine(inputLines[0]);
  await waitFor(() => out.includes('Target base ref:'), 5_000);
  sendLine(inputLines[1]);
  await waitFor(() => out.includes('New branch name:'), 5_000);
  sendLine(inputLines[2]);
  await waitFor(() => out.includes('Use 3-way merge'), 5_000);
  sendLine(inputLines[3]);
  await waitFor(() => out.includes('Path to old happy repo'), 5_000);
  sendLine(inputLines[4]);
  await waitFor(() => out.includes('Path to old happy-cli repo'), 5_000);
  sendLine(inputLines[5]);
  await waitFor(() => out.includes('old happy-cli base ref'), 5_000);
  sendLine(inputLines[6]);
  await waitFor(() => out.includes('Path to old happy-server repo'), 5_000);
  sendLine(inputLines[7]);

  // Wait for the guide to detect a conflict and start waiting for user action.
  await waitFor(() => out.includes('guide: conflict detected') || out.includes('guide: waiting for conflict resolution'), 10_000);
  conflictSeen = true;

  // Wait until the guide is actually prompting for the action.
  await waitFor(() => out.includes('Pick [1-5] (default: 1):'), 10_000);

  // Resolve conflict in target repo by choosing value=source and staging.
  await writeFile(join(target, 'cli', 'hello.txt'), 'value=source\n', 'utf-8');
  await run('git', ['add', 'cli/hello.txt'], { cwd: target, env: gitEnv() });

  // Tell the guide to continue.
  sendLine('');

  await waitFor(() => finished, 20_000);
  assert.ok(conflictSeen, `expected conflict handling markers\nstdout:\n${out}\nstderr:\n${err}`);
  assert.ok(out.includes('guide complete') || out.includes('port complete'), `expected completion output\nstdout:\n${out}\nstderr:\n${err}`);
  assert.equal(exitCode, 0, `expected guide to exit 0\nstdout:\n${out}\nstderr:\n${err}`);

  const content = (await readFile(join(target, 'cli', 'hello.txt'), 'utf-8')).toString();
  assert.equal(content, 'value=source\n');
});
