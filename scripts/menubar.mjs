import './utils/env.mjs';
import { cp, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { getHappyStacksHomeDir, getRootDir } from './utils/paths.mjs';
import { parseArgs } from './utils/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli.mjs';
import { ensureEnvLocalUpdated } from './utils/env_local.mjs';

async function ensureSwiftbarAssets({ cliRootDir }) {
  const homeDir = getHappyStacksHomeDir();
  const destDir = join(homeDir, 'extras', 'swiftbar');
  const srcDir = join(cliRootDir, 'extras', 'swiftbar');

  if (!existsSync(srcDir)) {
    throw new Error(`[menubar] missing assets at: ${srcDir}`);
  }

  await mkdir(destDir, { recursive: true });
  await cp(srcDir, destDir, {
    recursive: true,
    force: true,
    filter: (p) => !p.includes('.DS_Store'),
  });

  return { homeDir, destDir };
}

function openSwiftbarPluginsDir() {
  const s = 'DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; if [[ -z "$DIR" ]]; then DIR="$HOME/Library/Application Support/SwiftBar/Plugins"; fi; open "$DIR"';
  const res = spawnSync('bash', ['-lc', s], { stdio: 'inherit' });
  if (res.status !== 0) {
    process.exit(res.status ?? 1);
  }
}

function removeSwiftbarPlugins() {
  const s =
    'DIR="$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null)"; if [[ -z "$DIR" ]]; then DIR="$HOME/Library/Application Support/SwiftBar/Plugins"; fi; if [[ -d "$DIR" ]]; then rm -f "$DIR"/happy-stacks.*.sh "$DIR"/happy-local.*.sh 2>/dev/null || true; echo "$DIR"; else echo ""; fi';
  const res = spawnSync('bash', ['-lc', s], { encoding: 'utf-8' });
  if (res.status !== 0) {
    return null;
  }
  const out = String(res.stdout ?? '').trim();
  return out || null;
}

function normalizeMenubarMode(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  if (!v) return '';
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host' || v === 'host') return 'selfhost';
  if (v === 'dev' || v === 'developer') return 'dev';
  return '';
}

async function main() {
  const rawArgv = process.argv.slice(2);
  const argv = rawArgv[0] === 'menubar' ? rawArgv.slice(1) : rawArgv;
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  const cmd = argv.find((a) => !a.startsWith('--')) || 'help';
  if (wantsHelp(argv, { flags }) || cmd === 'help') {
    printResult({
      json,
      data: { commands: ['install', 'uninstall', 'open', 'mode', 'status'] },
      text: [
        '[menubar] usage:',
        '  happys menubar install [--json]',
        '  happys menubar uninstall [--json]',
        '  happys menubar open [--json]',
        '  happys menubar mode <selfhost|dev> [--json]',
        '  happys menubar status [--json]',
        '',
        'notes:',
        '  - installs SwiftBar plugin into the active SwiftBar plugin folder',
        '  - keeps plugin source under ~/.happy-stacks/extras/swiftbar for stability',
      ].join('\n'),
    });
    return;
  }

  const cliRootDir = getRootDir(import.meta.url);

  if (cmd === 'menubar:open' || cmd === 'open') {
    if (json) {
      printResult({ json, data: { ok: true } });
      return;
    }
    openSwiftbarPluginsDir();
    return;
  }

  if (cmd === 'menubar:uninstall' || cmd === 'uninstall') {
    const dir = removeSwiftbarPlugins();
    printResult({ json, data: { ok: true, pluginsDir: dir }, text: dir ? `[menubar] removed plugins from ${dir}` : '[menubar] no plugins dir found' });
    return;
  }

  if (cmd === 'status') {
    const mode = (process.env.HAPPY_STACKS_MENUBAR_MODE ?? process.env.HAPPY_LOCAL_MENUBAR_MODE ?? 'dev').trim() || 'dev';
    printResult({ json, data: { ok: true, mode }, text: `[menubar] mode: ${mode}` });
    return;
  }

  if (cmd === 'mode') {
    const positionals = argv.filter((a) => !a.startsWith('--'));
    const raw = positionals[1] ?? '';
    const mode = normalizeMenubarMode(raw);
    if (!mode) {
      throw new Error('[menubar] usage: happys menubar mode <selfhost|dev> [--json]');
    }
    await ensureEnvLocalUpdated({
      rootDir: cliRootDir,
      updates: [
        { key: 'HAPPY_STACKS_MENUBAR_MODE', value: mode },
        { key: 'HAPPY_LOCAL_MENUBAR_MODE', value: mode },
      ],
    });
    printResult({ json, data: { ok: true, mode }, text: `[menubar] mode set: ${mode}` });
    return;
  }

  if (cmd === 'menubar:install' || cmd === 'install') {
    const { destDir } = await ensureSwiftbarAssets({ cliRootDir });
    const installer = join(destDir, 'install.sh');
    const res = spawnSync('bash', [installer, '--force'], { stdio: 'inherit', env: { ...process.env, HAPPY_STACKS_HOME_DIR: getHappyStacksHomeDir() } });
    if (res.status !== 0) {
      process.exit(res.status ?? 1);
    }
    printResult({ json, data: { ok: true }, text: '[menubar] installed' });
    return;
  }

  throw new Error(`[menubar] unknown command: ${cmd}`);
}

main().catch((err) => {
  console.error('[menubar] failed:', err);
  process.exit(1);
});
