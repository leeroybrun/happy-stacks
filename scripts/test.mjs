import './utils/env.mjs';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths.mjs';
import { ensureDepsInstalled, requirePnpm } from './utils/pm.mjs';
import { pathExists } from './utils/fs.mjs';
import { run } from './utils/proc.mjs';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';

const DEFAULT_COMPONENTS = ['happy', 'happy-cli', 'happy-server-light', 'happy-server'];

async function detectPackageManagerCmd(dir) {
  if (await pathExists(join(dir, 'yarn.lock'))) {
    return { name: 'yarn', cmd: 'yarn', argsForScript: (script) => ['-s', script] };
  }
  await requirePnpm();
  return { name: 'pnpm', cmd: 'pnpm', argsForScript: (script) => ['--silent', script] };
}

async function readScripts(dir) {
  try {
    const raw = await readFile(join(dir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw);
    const scripts = pkg?.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
    return scripts;
  } catch {
    return null;
  }
}

function pickTestScript(scripts) {
  if (!scripts) return null;
  const candidates = [
    'test',
    'tst',
    'test:ci',
    'test:unit',
    'check:test',
  ];
  return candidates.find((k) => typeof scripts[k] === 'string' && scripts[k].trim()) ?? null;
}

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { components: DEFAULT_COMPONENTS, flags: ['--json'] },
      text: [
        '[test] usage:',
        '  happys test [component...] [--json]',
        '',
        'components:',
        `  ${DEFAULT_COMPONENTS.join(' | ')}`,
        '',
        'examples:',
        '  happys test',
        '  happys test happy happy-cli',
      ].join('\n'),
    });
    return;
  }

  const positionals = argv.filter((a) => !a.startsWith('--'));
  const requested = positionals.length ? positionals : ['all'];
  const wantAll = requested.includes('all');
  const components = wantAll ? DEFAULT_COMPONENTS : requested;

  const rootDir = getRootDir(import.meta.url);

  const results = [];
  for (const component of components) {
    if (!DEFAULT_COMPONENTS.includes(component)) {
      results.push({ component, ok: false, skipped: false, error: `unknown component (expected one of: ${DEFAULT_COMPONENTS.join(', ')})` });
      continue;
    }

    const dir = getComponentDir(rootDir, component);
    if (!(await pathExists(dir))) {
      results.push({ component, ok: false, skipped: false, dir, error: `missing component dir: ${dir}` });
      continue;
    }

    const scripts = await readScripts(dir);
    if (!scripts) {
      results.push({ component, ok: true, skipped: true, dir, reason: 'no package.json' });
      continue;
    }

    const script = pickTestScript(scripts);
    if (!script) {
      results.push({ component, ok: true, skipped: true, dir, reason: 'no test script found in package.json' });
      continue;
    }

    await ensureDepsInstalled(dir, component);
    const pm = await detectPackageManagerCmd(dir);

    try {
      // eslint-disable-next-line no-console
      console.log(`[test] ${component}: running ${pm.name} ${script}`);
      await run(pm.cmd, pm.argsForScript(script), { cwd: dir, env: process.env });
      results.push({ component, ok: true, skipped: false, dir, pm: pm.name, script });
    } catch (e) {
      results.push({ component, ok: false, skipped: false, dir, pm: pm.name, script, error: String(e?.message ?? e) });
    }
  }

  const ok = results.every((r) => r.ok);
  if (json) {
    printResult({ json, data: { ok, results } });
    return;
  }

  const lines = ['[test] results:'];
  for (const r of results) {
    if (r.ok && r.skipped) {
      lines.push(`- ↪ ${r.component}: skipped (${r.reason})`);
    } else if (r.ok) {
      lines.push(`- ✅ ${r.component}: ok (${r.pm} ${r.script})`);
    } else {
      lines.push(`- ❌ ${r.component}: failed (${r.pm ?? 'unknown'} ${r.script ?? ''})`);
      if (r.error) lines.push(`  - ${r.error}`);
    }
  }
  if (!ok) {
    lines.push('');
    lines.push('[test] failed');
  }
  printResult({ json: false, text: lines.join('\n') });
  if (!ok) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('[test] failed:', err);
  process.exit(1);
});

