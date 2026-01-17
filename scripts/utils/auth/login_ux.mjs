export function normalizeAuthLoginContext(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host') return 'selfhost';
  if (v === 'dev' || v === 'developer' || v === 'development') return 'dev';
  if (v === 'stack') return 'stack';
  return 'generic';
}

function supportsAnsi() {
  if (!process.stdout.isTTY) return false;
  if (process.env.NO_COLOR) return false;
  if ((process.env.TERM ?? '').toLowerCase() === 'dumb') return false;
  return true;
}

function bold(s) {
  return supportsAnsi() ? `\x1b[1m${s}\x1b[0m` : String(s);
}

function dim(s) {
  return supportsAnsi() ? `\x1b[2m${s}\x1b[0m` : String(s);
}

export function printAuthLoginInstructions({
  stackName,
  context = 'generic',
  webappUrl,
  webappUrlSource,
  internalServerUrl,
  publicServerUrl,
  rerunCmd,
}) {
  const ctx = normalizeAuthLoginContext(context);
  const subtitle =
    ctx === 'selfhost'
      ? 'Self-host'
      : ctx === 'dev'
        ? 'Dev'
        : ctx === 'stack'
          ? `Stack: ${stackName || 'unknown'}`
          : '';

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(bold('Happy login'));
  if (subtitle) {
    // eslint-disable-next-line no-console
    console.log(dim(subtitle));
  }
  // eslint-disable-next-line no-console
  console.log('Steps:');
  // eslint-disable-next-line no-console
  console.log('  1) A browser window will open');
  // eslint-disable-next-line no-console
  console.log('  2) Sign in (or create an account if this is your first time)');
  // eslint-disable-next-line no-console
  console.log('  3) Approve this terminal/machine connection');
  // eslint-disable-next-line no-console
  console.log('  4) Return here — the CLI will finish automatically');

  if (webappUrl) {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(`Web app:   ${webappUrl}${webappUrlSource ? ` (${webappUrlSource})` : ''}`);
  }
  if (internalServerUrl) {
    // eslint-disable-next-line no-console
    console.log(`Internal:  ${internalServerUrl}`);
  }
  if (publicServerUrl) {
    // eslint-disable-next-line no-console
    console.log(`Public:    ${publicServerUrl}`);
  }

  if (ctx === 'selfhost') {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log(dim('Note: this is required so the daemon can register this machine and sync sessions across devices.'));
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('Tips:');
  // eslint-disable-next-line no-console
  console.log('- If the browser page does not load, make sure Happy is running and reachable.');
  // eslint-disable-next-line no-console
  console.log(`- Re-run anytime: ${rerunCmd || 'happys auth login'}`);
}

