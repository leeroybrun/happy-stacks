#!/usr/bin/env node

// Thin wrapper around `happys happy`.
//
// This exists primarily for backwards convenience (a `happy` binary) while keeping
// the behavior centralized in the main happy-stacks CLI.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function getRootDir() {
  // packages/happy-cli-local/bin/happy.mjs -> happy-stacks/
  return dirname(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
}

function stripOpt(argv, { name, aliases = [] }) {
  const names = [name, ...aliases];
  for (const n of names) {
    const eq = `${n}=`;
    const iEq = argv.findIndex((a) => a.startsWith(eq));
    if (iEq >= 0) {
      const value = argv[iEq].slice(eq.length);
      const next = [...argv.slice(0, iEq), ...argv.slice(iEq + 1)];
      return { value, argv: next };
    }
    const i = argv.indexOf(n);
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('-')) {
      const value = argv[i + 1];
      const next = [...argv.slice(0, i), ...argv.slice(i + 2)];
      return { value, argv: next };
    }
  }
  return { value: '', argv };
}

function main() {
  const rootDir = getRootDir();
  let argv = process.argv.slice(2);

  // Support wrapper-only stack selection (not forwarded to happy-cli).
  const s1 = stripOpt(argv, { name: '--stack' });
  let stackName = (s1.value ?? '').trim();
  argv = s1.argv;
  if (!stackName) {
    stackName = (process.env.HAPPY_STACKS_STACK ?? process.env.HAPPY_LOCAL_STACK ?? '').trim();
  }

  // Support sandboxing when invoking the wrapper directly.
  const sb = stripOpt(argv, { name: '--sandbox-dir', aliases: ['--sandbox'] });
  const sandboxDir = (sb.value ?? '').trim();
  argv = sb.argv;

  const env = { ...process.env };
  if (stackName) {
    env.HAPPY_STACKS_STACK = stackName;
    env.HAPPY_LOCAL_STACK = stackName;
    // Ensure stack selection wins even if user exported an env file already.
    delete env.HAPPY_STACKS_ENV_FILE;
    delete env.HAPPY_LOCAL_ENV_FILE;
  }

  const happysEntry = join(rootDir, 'bin', 'happys.mjs');
  const happysArgv = [
    ...(sandboxDir ? ['--sandbox-dir', sandboxDir] : []),
    'happy',
    ...argv,
  ];

  execFileSync(process.execPath, [happysEntry, ...happysArgv], { stdio: 'inherit', env });
}

try {
  main();
} catch (e) {
  process.exit(e?.status || 1);
}

