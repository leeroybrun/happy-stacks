export function normalizeAuthLoginContext(raw) {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase();
  if (v === 'selfhost' || v === 'self-host' || v === 'self_host') return 'selfhost';
  if (v === 'dev' || v === 'developer' || v === 'development') return 'dev';
  if (v === 'stack') return 'stack';
  return 'generic';
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
  const title =
    ctx === 'selfhost'
      ? '[auth] login (self-host)'
      : ctx === 'dev'
        ? '[auth] login (dev)'
        : ctx === 'stack'
          ? `[auth] login (stack=${stackName || 'unknown'})`
          : '[auth] login';

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log(title);
  // eslint-disable-next-line no-console
  console.log('[auth] steps:');
  // eslint-disable-next-line no-console
  console.log('  1) A browser window will open for authentication');
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
    console.log(`[auth] webapp:   ${webappUrl}${webappUrlSource ? ` (${webappUrlSource})` : ''}`);
  }
  if (internalServerUrl) {
    // eslint-disable-next-line no-console
    console.log(`[auth] internal: ${internalServerUrl}`);
  }
  if (publicServerUrl) {
    // eslint-disable-next-line no-console
    console.log(`[auth] public:   ${publicServerUrl}`);
  }

  if (ctx === 'selfhost') {
    // eslint-disable-next-line no-console
    console.log('');
    // eslint-disable-next-line no-console
    console.log('[auth] note: this is required so the daemon can register this machine and sync sessions across devices.');
  }

  // eslint-disable-next-line no-console
  console.log('');
  // eslint-disable-next-line no-console
  console.log('[auth] tips:');
  // eslint-disable-next-line no-console
  console.log('- If the browser page does not load, make sure Happy is running and reachable.');
  // eslint-disable-next-line no-console
  console.log(`- Re-run anytime: ${rerunCmd || 'happys auth login'}`);
}

