import { resolve } from 'node:path';

import { ensureCliBuilt, ensureDepsInstalled } from './proc/pm.mjs';
import { watchDebounced } from './watch.mjs';
import { getAccountCountForServerComponent, prepareDaemonAuthSeedIfNeeded } from './stack_startup.mjs';
import { startLocalDaemonWithAuth } from '../daemon.mjs';

export async function ensureDevCliReady({ cliDir, buildCli }) {
  await ensureDepsInstalled(cliDir, 'happy-cli');
  return await ensureCliBuilt(cliDir, { buildCli });
}

export async function prepareDaemonAuthSeed({
  rootDir,
  env,
  stackName,
  cliHomeDir,
  startDaemon,
  isInteractive,
  serverComponentName,
  serverDir,
  serverEnv,
  quiet = false,
}) {
  if (!startDaemon) return { ok: true, skipped: true, reason: 'no_daemon' };
  const acct = await getAccountCountForServerComponent({
    serverComponentName,
    serverDir,
    env: serverEnv,
    bestEffort: serverComponentName === 'happy-server',
  });
  return await prepareDaemonAuthSeedIfNeeded({
    rootDir,
    env,
    stackName,
    cliHomeDir,
    startDaemon,
    isInteractive,
    accountCount: typeof acct.accountCount === 'number' ? acct.accountCount : null,
    quiet,
    // IMPORTANT: run auth seeding under the same env used for server probes (includes DATABASE_URL).
    authEnv: serverEnv,
  });
}

export async function startDevDaemon({
  startDaemon,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  restart,
  isShuttingDown,
}) {
  if (!startDaemon) return;
  await startLocalDaemonWithAuth({
    cliBin,
    cliHomeDir,
    internalServerUrl,
    publicServerUrl,
    isShuttingDown,
    forceRestart: Boolean(restart),
  });
}

export function watchHappyCliAndRestartDaemon({
  enabled,
  startDaemon,
  buildCli,
  cliDir,
  cliBin,
  cliHomeDir,
  internalServerUrl,
  publicServerUrl,
  isShuttingDown,
}) {
  if (!enabled || !startDaemon) return null;

  let inFlight = false;
  return watchDebounced({
    paths: [resolve(cliDir)],
    debounceMs: 500,
    onChange: async () => {
      if (isShuttingDown?.()) return;
      if (inFlight) return;
      inFlight = true;
      try {
        // eslint-disable-next-line no-console
        console.log('[local] watch: happy-cli changed → rebuilding + restarting daemon...');
        await ensureCliBuilt(cliDir, { buildCli });
        await startLocalDaemonWithAuth({
          cliBin,
          cliHomeDir,
          internalServerUrl,
          publicServerUrl,
          isShuttingDown,
          forceRestart: true,
        });
      } finally {
        inFlight = false;
      }
    },
  });
}
