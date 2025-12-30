import { ensureCliBuilt, ensureHappyCliLocalNpmLinked, getComponentDir, getRootDir, parseArgs } from './shared.mjs';

/**
 * Link the local Happy CLI wrapper into your PATH.
 *
 * This is intentionally extracted so you can re-run linking without doing a full `pnpm bootstrap`.
 *
 * What it does:
 * - optionally builds `components/happy-cli` (controlled by env/flags)
 * - `npm link --force` the `packages/happy-cli-local` wrapper (so `happy` points at happy-local)
 *
 * Env:
 * - HAPPY_LOCAL_CLI_BUILD=0 to skip building happy-cli
 * - HAPPY_LOCAL_NPM_LINK=0 to skip npm link
 *
 * Flags:
 * - --no-build: skip building happy-cli
 * - --no-link: skip npm link
 */

async function main() {
  const { flags } = parseArgs(process.argv.slice(2));

  const rootDir = getRootDir(import.meta.url);
  const cliDir = getComponentDir(rootDir, 'happy-cli');

  const buildCli = !flags.has('--no-build') && (process.env.HAPPY_LOCAL_CLI_BUILD ?? '1') !== '0';
  const npmLinkCli = !flags.has('--no-link') && (process.env.HAPPY_LOCAL_NPM_LINK ?? '1') !== '0';

  await ensureCliBuilt(cliDir, { buildCli });
  await ensureHappyCliLocalNpmLinked(rootDir, { npmLinkCli });

  console.log('[local] cli link complete');
}

main().catch((err) => {
  console.error('[local] cli link failed:', err);
  process.exit(1);
});

