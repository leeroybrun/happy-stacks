import './utils/env/env.mjs';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './utils/cli/args.mjs';
import { printResult, wantsHelp, wantsJson } from './utils/cli/cli.mjs';
import { getComponentDir, getRootDir } from './utils/paths/paths.mjs';
import { resolveCliHomeDir } from './utils/stack/dirs.mjs';

async function main() {
  const argv = process.argv.slice(2);
  const { flags } = parseArgs(argv);
  const json = wantsJson(argv, { flags });

  if (wantsHelp(argv, { flags })) {
    printResult({
      json,
      data: { passthrough: true },
      text: [
        '[happy] usage:',
        '  happys happy <happy-cli args...>',
        '',
        'notes:',
        '  - This runs the `happy-cli` component from your configured workspace/components.',
        '  - It auto-fills HAPPY_HOME_DIR / HAPPY_SERVER_URL / HAPPY_WEBAPP_URL when missing.',
      ].join('\n'),
    });
    return;
  }

  const rootDir = getRootDir(import.meta.url);

  const portRaw = (process.env.HAPPY_STACKS_SERVER_PORT ?? process.env.HAPPY_LOCAL_SERVER_PORT ?? '').trim();
  const port = portRaw ? Number(portRaw) : 3005;
  const serverPort = Number.isFinite(port) ? port : 3005;

  const internalServerUrl = `http://127.0.0.1:${serverPort}`;
  const publicServerUrl = (process.env.HAPPY_STACKS_SERVER_URL ?? process.env.HAPPY_LOCAL_SERVER_URL ?? '').trim() || `http://localhost:${serverPort}`;

  const cliHomeDir = resolveCliHomeDir();

  const cliDir = getComponentDir(rootDir, 'happy-cli');
  const entrypoint = join(cliDir, 'dist', 'index.mjs');
  if (!existsSync(entrypoint)) {
    throw new Error(`[happy] missing happy-cli build at: ${entrypoint}\nRun: happys bootstrap`);
  }

  const env = { ...process.env };
  env.HAPPY_HOME_DIR = env.HAPPY_HOME_DIR || cliHomeDir;
  env.HAPPY_SERVER_URL = env.HAPPY_SERVER_URL || internalServerUrl;
  env.HAPPY_WEBAPP_URL = env.HAPPY_WEBAPP_URL || publicServerUrl;

  execFileSync(process.execPath, ['--no-warnings', '--no-deprecation', entrypoint, ...argv], {
    stdio: 'inherit',
    env,
  });
}

main().catch((err) => {
  console.error('[happy] failed:', err);
  process.exit(1);
});

