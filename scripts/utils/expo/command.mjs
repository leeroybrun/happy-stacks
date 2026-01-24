import { ensureDepsInstalled, pmExecBin, pmSpawnBin } from '../proc/pm.mjs';
import { ensureExpoIsolationEnv, getExpoStatePaths, wantsExpoClearCache } from './expo.mjs';

export async function prepareExpoCommandEnv({
  baseDir,
  kind,
  projectDir,
  baseEnv,
  stateFileName,
}) {
  const env = { ...(baseEnv ?? process.env) };
  const paths = getExpoStatePaths({ baseDir, kind, projectDir, stateFileName });
  await ensureExpoIsolationEnv({ env, stateDir: paths.stateDir, expoHomeDir: paths.expoHomeDir, tmpDir: paths.tmpDir });
  return { env, paths };
}

export function maybeAddExpoClear({ args, env }) {
  const next = [...(args ?? [])];
  if (wantsExpoClearCache({ env: env ?? process.env })) {
    // Expo supports `--clear` for start, and `-c` for export.
    // Callers should pass the right flag for their subcommand; we only add when missing.
    if (!next.includes('--clear') && !next.includes('-c')) {
      // Prefer `--clear` as a safe default; callers can override per-command.
      next.push('--clear');
    }
  }
  return next;
}

export async function expoExec({
  dir,
  args,
  env,
  ensureDepsLabel = 'happy',
  quiet = false,
}) {
  await ensureDepsInstalled(dir, ensureDepsLabel, { quiet });
  await pmExecBin({ dir, bin: 'expo', args, env, quiet });
}

export async function expoSpawn({
  label,
  dir,
  args,
  env,
  ensureDepsLabel = 'happy',
  quiet = false,
  options,
}) {
  await ensureDepsInstalled(dir, ensureDepsLabel, { quiet });
  return await pmSpawnBin({ label, dir, bin: 'expo', args, env, options, quiet });
}

