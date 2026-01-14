import './utils/env.mjs';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { run, runCapture } from './utils/proc.mjs';
import { getRootDir, resolveStackEnvPath } from './utils/paths.mjs';

function usage() {
  return [
    '[stop] usage:',
    '  happys stop [--except-stacks=main,exp1] [--yes] [--aggressive] [--sweep-owned] [--no-docker] [--no-service] [--json]',
    '',
    'Stops stacks and related local processes (server, daemon, Expo, managed infra) using stack-scoped commands.',
    '',
    'Examples:',
    '  happys stop --except-stacks=main --yes',
    '  happys stop --yes --no-docker',
    '  happys stop --except-stacks=main --yes --aggressive',
    '  happys stop --except-stacks=main --yes --aggressive --sweep-owned',
  ].join('\n');
}

function parseCsv(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return [];
  return s
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

async function listAllStackNames() {
  try {
    // Reuse stack.mjs for enumeration (avoids duplicating legacy/new stack dir logic).
    // Note: `stack list` intentionally omits `main`, so we add it back.
    const rootDir = getRootDir(import.meta.url);
    const out = await runCapture(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'list', '--json'], { cwd: rootDir });
    const parsed = JSON.parse(out);
    const stacks = Array.isArray(parsed?.stacks) ? parsed.stacks : [];
    const all = ['main', ...stacks.filter((s) => s !== 'main')];
    return all.sort();
  } catch {
    return ['main'];
  }
}

async function main() {
  const rootDir = getRootDir(import.meta.url);
  const argv = process.argv.slice(2);
  const { flags, kv } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({ json, data: { ok: true }, text: usage() });
    return;
  }

  const exceptStacks = new Set(parseCsv(kv.get('--except-stacks')));
  const yes = flags.has('--yes');
  const aggressive = flags.has('--aggressive');
  const sweepOwned = flags.has('--sweep-owned');
  const noDocker = flags.has('--no-docker');
  const noService = flags.has('--no-service');

  const stacks = await listAllStackNames();
  const targets = stacks.filter((n) => !exceptStacks.has(n));

  if (!targets.length) {
    printResult({ json, data: { ok: true, stopped: [], skipped: stacks }, text: '[stop] nothing to do (all stacks excluded)' });
    return;
  }

  if (!yes && !(process.stdin.isTTY && process.stdout.isTTY)) {
    throw new Error('[stop] refusing to stop stacks without --yes in non-interactive mode');
  }

  if (!yes) {
    // Simple confirm prompt (avoid importing wizard/rl here).
    // eslint-disable-next-line no-console
    console.log(`[stop] will stop stacks: ${targets.join(', ')}`);
    // eslint-disable-next-line no-console
    console.log('[stop] re-run with --yes to proceed');
    process.exit(1);
  }

  const results = [];
  const errors = [];
  const skipped = [];

  for (const stackName of targets) {
    if (stackName !== 'main') {
      const { envPath } = resolveStackEnvPath(stackName);
      // Stack name might appear in directory listings, but if it has no env file, treat it as non-existent.
      if (!existsSync(envPath)) {
        skipped.push({ stackName, reason: 'missing_env', envPath });
        continue;
      }
    }
    try {
      if (!noService) {
        // Best-effort: stop autostart service for the stack so it doesn't restart what we just stopped.
        // eslint-disable-next-line no-await-in-loop
        await run(process.execPath, [join(rootDir, 'scripts', 'stack.mjs'), 'service', stackName, 'stop'], { cwd: rootDir }).catch(() => {});
      }

      const args = [
        join(rootDir, 'scripts', 'stack.mjs'),
        'stop',
        stackName,
        ...(aggressive ? ['--aggressive'] : []),
        ...(sweepOwned ? ['--sweep-owned'] : []),
        ...(noDocker ? ['--no-docker'] : []),
      ];
      if (json) {
        // eslint-disable-next-line no-await-in-loop
        const out = await runCapture(process.execPath, [...args, '--json'], { cwd: rootDir });
        results.push({ stackName, out: JSON.parse(out) });
      } else {
        // eslint-disable-next-line no-await-in-loop
        await run(process.execPath, args, { cwd: rootDir });
        results.push({ stackName, ok: true });
      }
    } catch (e) {
      errors.push({ stackName, error: e instanceof Error ? e.message : String(e) });
    }
  }

  if (json) {
    printResult({
      json,
      data: { ok: errors.length === 0, stopped: results, skipped, errors, exceptStacks: Array.from(exceptStacks) },
    });
    return;
  }

  // eslint-disable-next-line no-console
  console.log(
    `[stop] done (stopped=${results.length}${skipped.length ? ` skipped=${skipped.length}` : ''}${errors.length ? ` errors=${errors.length}` : ''})`
  );
  if (skipped.length) {
    for (const s of skipped) {
      // eslint-disable-next-line no-console
      console.log(`[stop] skipped (${s.stackName}): ${s.reason}${s.envPath ? ` (${s.envPath})` : ''}`);
    }
  }
  if (errors.length) {
    for (const e of errors) {
      // eslint-disable-next-line no-console
      console.warn(`[stop] error (${e.stackName}): ${e.error}`);
    }
  }
}

main().catch((err) => {
  console.error('[stop] failed:', err);
  process.exit(1);
});

