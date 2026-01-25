import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCodeRabbitEnv } from './coderabbit.mjs';

test('buildCodeRabbitEnv does not override HOME', () => {
  const env = { HOME: '/Users/example', USERPROFILE: '/Users/example' };
  const out = buildCodeRabbitEnv({ env, homeDir: '/tmp/isolated' });
  assert.equal(out.HOME, '/Users/example');
  assert.equal(out.USERPROFILE, '/Users/example');
});

test('buildCodeRabbitEnv sets CODERABBIT_HOME and XDG dirs under homeDir', () => {
  const out = buildCodeRabbitEnv({ env: { HOME: '/Users/example' }, homeDir: '/tmp/isolated' });
  assert.equal(out.CODERABBIT_HOME, '/tmp/isolated/.coderabbit');
  assert.equal(out.XDG_CONFIG_HOME, '/tmp/isolated/.config');
  assert.equal(out.XDG_CACHE_HOME, '/tmp/isolated/.cache');
  assert.equal(out.XDG_STATE_HOME, '/tmp/isolated/.local/state');
  assert.equal(out.XDG_DATA_HOME, '/tmp/isolated/.local/share');
});

