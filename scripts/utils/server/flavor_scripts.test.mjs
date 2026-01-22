import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  resolveServerDevScript,
  resolveServerLightPrismaClientImport,
  resolveServerLightPrismaDbPushArgs,
  resolveServerStartScript,
} from './flavor_scripts.mjs';

async function writeJson(path, obj) {
  await writeFile(path, JSON.stringify(obj, null, 2) + '\n', 'utf-8');
}

test('resolveServer*Script uses light scripts when unified light flavor is detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(join(dir, 'prisma', 'schema.sqlite.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');
    await writeJson(join(dir, 'package.json'), { scripts: { 'start:light': 'node x', 'dev:light': 'node y' } });

    assert.equal(resolveServerDevScript({ serverComponentName: 'happy-server-light', serverDir: dir, prismaPush: true }), 'dev:light');
    assert.equal(resolveServerDevScript({ serverComponentName: 'happy-server-light', serverDir: dir, prismaPush: false }), 'start:light');
    assert.equal(resolveServerStartScript({ serverComponentName: 'happy-server-light', serverDir: dir }), 'start:light');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServer*Script falls back to legacy scripts for non-unified happy-server-light', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    await writeJson(join(dir, 'package.json'), { scripts: { start: 'node start', dev: 'node dev' } });

    assert.equal(resolveServerDevScript({ serverComponentName: 'happy-server-light', serverDir: dir, prismaPush: true }), 'dev');
    assert.equal(resolveServerDevScript({ serverComponentName: 'happy-server-light', serverDir: dir, prismaPush: false }), 'start');
    assert.equal(resolveServerStartScript({ serverComponentName: 'happy-server-light', serverDir: dir }), 'start');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServer*Script returns start for happy-server', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    await writeJson(join(dir, 'package.json'), { scripts: { start: 'node start', dev: 'node dev' } });

    assert.equal(resolveServerDevScript({ serverComponentName: 'happy-server', serverDir: dir, prismaPush: true }), 'start');
    assert.equal(resolveServerDevScript({ serverComponentName: 'happy-server', serverDir: dir, prismaPush: false }), 'start');
    assert.equal(resolveServerStartScript({ serverComponentName: 'happy-server', serverDir: dir }), 'start');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServerLightPrismaDbPushArgs adds --schema when unified light flavor is detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(join(dir, 'prisma', 'schema.sqlite.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

    assert.deepEqual(resolveServerLightPrismaDbPushArgs({ serverDir: dir }), ['db', 'push', '--schema', 'prisma/schema.sqlite.prisma']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServerLightPrismaClientImport returns file URL when unified light flavor is detected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    await mkdir(join(dir, 'prisma'), { recursive: true });
    await writeFile(join(dir, 'prisma', 'schema.sqlite.prisma'), 'datasource db { provider = "sqlite" }\n', 'utf-8');

    const spec = resolveServerLightPrismaClientImport({ serverDir: dir });
    assert.equal(typeof spec, 'string');
    assert.ok(spec.startsWith('file:'), `expected file: URL import spec, got: ${spec}`);
    assert.ok(spec.endsWith('/generated/sqlite-client/index.js'), `unexpected import spec: ${spec}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resolveServerLightPrismaClientImport returns @prisma/client for legacy happy-server-light', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hs-flavor-scripts-'));
  try {
    assert.equal(resolveServerLightPrismaClientImport({ serverDir: dir }), '@prisma/client');
    assert.deepEqual(resolveServerLightPrismaDbPushArgs({ serverDir: dir }), ['db', 'push']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
