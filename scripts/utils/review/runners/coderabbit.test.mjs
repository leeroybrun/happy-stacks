import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

import { buildCodeRabbitEnv, buildCodeRabbitReviewArgs } from './coderabbit.mjs';

test('buildCodeRabbitReviewArgs builds committed review args by default', () => {
  const repoDir = '/tmp/repo';
  const args = buildCodeRabbitReviewArgs({ repoDir, baseRef: 'upstream/main', type: undefined, configFiles: [] });
  assert.deepEqual(args, ['review', '--plain', '--no-color', '--type', 'committed', '--cwd', repoDir, '--base', 'upstream/main']);
});

test('buildCodeRabbitReviewArgs uses --base-commit when provided', () => {
  const repoDir = '/tmp/repo';
  const args = buildCodeRabbitReviewArgs({ repoDir, baseCommit: 'abc123', type: 'committed', configFiles: [] });
  assert.deepEqual(args, ['review', '--plain', '--no-color', '--type', 'committed', '--cwd', repoDir, '--base-commit', 'abc123']);
});

test('buildCodeRabbitReviewArgs rejects providing both baseRef and baseCommit', () => {
  assert.throws(
    () => buildCodeRabbitReviewArgs({ repoDir: '/tmp/repo', baseRef: 'upstream/main', baseCommit: 'abc123', type: 'committed', configFiles: [] }),
    /mutually exclusive/
  );
});

test('buildCodeRabbitReviewArgs includes --config when files are provided', () => {
  const repoDir = '/tmp/repo';
  const args = buildCodeRabbitReviewArgs({
    repoDir,
    baseRef: 'upstream/main',
    type: 'committed',
    configFiles: ['/tmp/a.md', '/tmp/b.md'],
  });
  assert.deepEqual(args, [
    'review',
    '--plain',
    '--no-color',
    '--type',
    'committed',
    '--cwd',
    repoDir,
    '--base',
    'upstream/main',
    '--config',
    '/tmp/a.md',
    '/tmp/b.md',
  ]);
});

test('buildCodeRabbitEnv overrides HOME/XDG paths when a homeDir is provided', () => {
  const env = buildCodeRabbitEnv({ env: { PATH: '/bin' }, homeDir: '/tmp/cr-home' });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.HOME, '/tmp/cr-home');
  assert.equal(env.CODERABBIT_HOME, join('/tmp/cr-home', '.coderabbit'));
  assert.equal(env.XDG_CONFIG_HOME, join('/tmp/cr-home', '.config'));
  assert.equal(env.XDG_CACHE_HOME, join('/tmp/cr-home', '.cache'));
  assert.equal(env.XDG_STATE_HOME, join('/tmp/cr-home', '.local', 'state'));
  assert.equal(env.XDG_DATA_HOME, join('/tmp/cr-home', '.local', 'share'));
});
