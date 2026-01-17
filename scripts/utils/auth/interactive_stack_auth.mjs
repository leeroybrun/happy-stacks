import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { isTty, prompt, withRl } from '../cli/wizard.mjs';
import { detectSeedableAuthSources } from './sources.mjs';
import { guidedStackAuthLoginNow, stackAuthCopyFrom } from './stack_guided_login.mjs';

export function needsAuthSeed({ cliHomeDir, accountCount }) {
  const accessKeyPath = join(cliHomeDir, 'access.key');
  const hasAccessKey = existsSync(accessKeyPath);
  const hasAccounts = typeof accountCount === 'number' ? accountCount > 0 : null;
  return !hasAccessKey || hasAccounts === false;
}

function normalizeChoice(raw) {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return '';
  return s[0];
}

export async function maybeRunInteractiveStackAuthSetup({
  rootDir,
  env = process.env,
  stackName,
  cliHomeDir,
  accountCount,
  isInteractive = isTty(),
  autoSeedEnabled = false,
  beforeLogin = null,
} = {}) {
  if (!isInteractive) return { ok: true, skipped: true, reason: 'non_interactive' };
  if (autoSeedEnabled) return { ok: true, skipped: true, reason: 'auto_seed_enabled' };
  if (!needsAuthSeed({ cliHomeDir, accountCount })) return { ok: true, skipped: true, reason: 'already_initialized' };

  const sources = detectSeedableAuthSources().filter((s) => s && s !== stackName);
  const hasDevAuth = sources.includes('dev-auth');
  const hasMain = sources.includes('main');

  let choice = 'login';
  if (hasDevAuth || hasMain) {
    const defaultLetter = hasDevAuth ? 'Y' : hasMain ? 'M' : 'N';
    const promptLine =
      `[local] auth: stack "${stackName}" needs authentication.\n` +
      `[local] Choose one:\n` +
      (hasDevAuth ? `  - Y: copy from dev-auth\n` : '') +
      (hasMain ? `  - M: copy from main\n` : '') +
      `  - N: login now\n`;

    // eslint-disable-next-line no-console
    console.log(promptLine);
    const answer = await withRl(async (rl) => {
      return await prompt(rl, `Pick [Y/M/N] (default: ${defaultLetter}): `, { defaultValue: defaultLetter });
    });
    const c = normalizeChoice(answer);
    if (c === 'y' && hasDevAuth) choice = 'dev-auth';
    else if (c === 'm' && hasMain) choice = 'main';
    else if (c === 'n') choice = 'login';
    else choice = hasDevAuth ? 'dev-auth' : hasMain ? 'main' : 'login';
  }

  if (choice === 'login') {
    if (beforeLogin && typeof beforeLogin === 'function') {
      await beforeLogin();
    }
    await guidedStackAuthLoginNow({ rootDir, stackName, env });
    return { ok: true, skipped: false, mode: 'login' };
  }

  await stackAuthCopyFrom({ rootDir, stackName, fromStackName: String(choice), env, link: true });
  return { ok: true, skipped: false, mode: 'seed', from: String(choice), link: true };
}

