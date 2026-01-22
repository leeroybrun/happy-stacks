import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

function readScripts(serverDir) {
  try {
    const pkgPath = join(serverDir, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return scripts;
  } catch {
    return {};
  }
}

function hasScript(scripts, name) {
  return typeof scripts?.[name] === 'string' && scripts[name].trim().length > 0;
}

export function isUnifiedHappyServerLight({ serverDir }) {
  return existsSync(join(serverDir, 'prisma', 'schema.sqlite.prisma'));
}

export function resolveServerLightPrismaDbPushArgs({ serverDir }) {
  if (isUnifiedHappyServerLight({ serverDir })) {
    return ['db', 'push', '--schema', 'prisma/schema.sqlite.prisma'];
  }
  return ['db', 'push'];
}

export function resolveServerLightPrismaClientImport({ serverDir }) {
  if (!isUnifiedHappyServerLight({ serverDir })) {
    return '@prisma/client';
  }
  const clientPath = join(serverDir, 'generated', 'sqlite-client', 'index.js');
  return pathToFileURL(clientPath).href;
}

export function resolveServerDevScript({ serverComponentName, serverDir, prismaPush }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happy-server') {
    return 'start';
  }

  if (serverComponentName === 'happy-server-light') {
    const unified = isUnifiedHappyServerLight({ serverDir });
    if (unified) {
      if (prismaPush) {
        return hasScript(scripts, 'dev:light') ? 'dev:light' : 'dev';
      }
      return hasScript(scripts, 'start:light') ? 'start:light' : 'start';
    }

    // Legacy behavior: happy-server-light uses `dev` by default for the upstream db push loop.
    if (prismaPush) {
      return hasScript(scripts, 'dev') ? 'dev' : 'start';
    }
    return hasScript(scripts, 'start') ? 'start' : 'dev';
  }

  // Unknown: be conservative.
  return 'start';
}

export function resolveServerStartScript({ serverComponentName, serverDir }) {
  const scripts = readScripts(serverDir);

  if (serverComponentName === 'happy-server-light') {
    const unified = isUnifiedHappyServerLight({ serverDir });
    if (unified && hasScript(scripts, 'start:light')) {
      return 'start:light';
    }
  }

  return 'start';
}
