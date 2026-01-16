function sanitizeBundleIdSegment(s) {
  return (
    (s ?? '')
      .toString()
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'user'
  );
}

export function resolveMobileExpoConfig({ env = process.env } = {}) {
  const user = sanitizeBundleIdSegment(env.USER ?? env.USERNAME ?? 'user');
  const defaultLocalBundleId = `com.happy.local.${user}.dev`;

  const appEnv = env.APP_ENV ?? env.HAPPY_STACKS_APP_ENV ?? env.HAPPY_LOCAL_APP_ENV ?? 'development';
  const iosAppName = (env.HAPPY_STACKS_IOS_APP_NAME ?? env.HAPPY_LOCAL_IOS_APP_NAME ?? '').toString();
  const iosBundleId = (env.HAPPY_STACKS_IOS_BUNDLE_ID ?? env.HAPPY_LOCAL_IOS_BUNDLE_ID ?? defaultLocalBundleId).toString();
  const scheme = (env.HAPPY_STACKS_MOBILE_SCHEME ?? env.HAPPY_LOCAL_MOBILE_SCHEME ?? iosBundleId).toString();
  const host = (env.HAPPY_STACKS_MOBILE_HOST ?? env.HAPPY_LOCAL_MOBILE_HOST ?? 'lan').toString();

  return {
    appEnv,
    iosAppName,
    iosBundleId,
    scheme,
    host,
  };
}

