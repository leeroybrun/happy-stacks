import './utils/env/env.mjs';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { getRootDir } from './utils/paths/paths.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { getVerbosityLevel } from './utils/cli/verbosity.mjs';
import { createStepPrinter } from './utils/cli/progress.mjs';
 
function usage() {
  return [
    '[review-pr] usage:',
    '  happys review-pr --happy=<pr-url|number> [--happy-cli=<pr-url|number>] [--happy-server=<pr-url|number>|--happy-server-light=<pr-url|number>] [--name=<stack>] [--dev|--start] [--seed-auth|--no-seed-auth] [--copy-auth-from=<stack>] [--link-auth|--copy-auth] [--update] [--force] [--json] [-- <stack dev/start args...>]',
    '',
    'What it does:',
    '- creates a temporary sandbox dir',
    '- runs `happys setup-pr ...` inside that sandbox (fully isolated state)',
    '- on exit (including Ctrl+C): stops sandbox processes and deletes the sandbox dir',
  ].join('\n');
}
 
function waitForExit(child) {
  return new Promise((resolvePromise, rejectPromise) => {
    child.on('error', rejectPromise);
    child.on('close', (code, signal) => resolvePromise({ code: code ?? 1, signal: signal ?? null }));
  });
}
 
async function tryStopSandbox({ rootDir, sandboxDir }) {
  const bin = join(rootDir, 'bin', 'happys.mjs');
  const child = spawn(process.execPath, [bin, '--sandbox-dir', sandboxDir, 'stop', '--yes', '--aggressive', '--sweep-owned', '--no-service'], {
    cwd: rootDir,
    env: process.env,
    stdio: 'ignore',
  });
  await waitForExit(child);
}
 
async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });
  const verbosity = getVerbosityLevel(process.env);
  const steps = createStepPrinter({ enabled: Boolean(process.stdout.isTTY && !json && verbosity === 0) });
 
  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { usage: usage() }, text: usage() });
    return;
  }
 
  steps.start('create temporary sandbox');
  const prefix = join(tmpdir(), 'happy-stacks-review-pr-');
  const sandboxDir = resolve(await mkdtemp(prefix));
  steps.stop('✓', 'create temporary sandbox');
 
  // Safety marker to ensure we only delete what we created.
  const markerPath = join(sandboxDir, '.happy-stacks-sandbox-marker');
  await writeFile(markerPath, 'review-pr\n', 'utf-8');
 
  const bin = join(rootDir, 'bin', 'happys.mjs');
 
  let child = null;
  let gotSignal = null;
 
  const forwardSignal = (sig) => {
    gotSignal = gotSignal ?? sig;
    try {
      child?.kill(sig);
    } catch {
      // ignore
    }
  };
 
  const onSigInt = () => forwardSignal('SIGINT');
  const onSigTerm = () => forwardSignal('SIGTERM');
  process.on('SIGINT', onSigInt);
  process.on('SIGTERM', onSigTerm);
 
  try {
    child = spawn(process.execPath, [bin, '--sandbox-dir', sandboxDir, 'setup-pr', ...argv], {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    });
 
    const { code } = await waitForExit(child);
    process.exitCode = code;
  } finally {
    process.off('SIGINT', onSigInt);
    process.off('SIGTERM', onSigTerm);

    steps.start('stop sandbox processes (best-effort)');
    // Best-effort stop before deleting the sandbox.
    await tryStopSandbox({ rootDir, sandboxDir }).catch(() => {});
    steps.stop('✓', 'stop sandbox processes (best-effort)');
 
    steps.start('delete sandbox directory');
    // Only delete if marker exists (paranoia guard).
    // Note: if marker is missing, we intentionally leave the sandbox dir on disk.
    try {
      await rm(markerPath, { force: false });
      await rm(sandboxDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    steps.stop('✓', 'delete sandbox directory');
 
    // Preserve conventional exit codes on signals.
    if (gotSignal) {
      const code = gotSignal === 'SIGINT' ? 130 : gotSignal === 'SIGTERM' ? 143 : 1;
      process.exitCode = process.exitCode ?? code;
    }
  }
}
 
main().catch((err) => {
  console.error('[review-pr] failed:', err);
  process.exit(1);
});
 
