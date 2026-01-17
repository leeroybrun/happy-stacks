# Mobile app development (iOS)

This is optional. Most people can use the served web UI on mobile via Tailscale:
see the “Using Happy from your phone” section in the main README.

## Prereqs (one-time)

- Xcode installed
- CocoaPods installed (`brew install cocoapods`)

## Two supported modes

- **Shared dev-client app** (recommended for development):
  - Install *one* “Happy Stacks Dev” app on your phone.
  - Run any stack with `--mobile`; scan the QR to open that stack inside the dev-client.
  - Per-stack auth/storage is isolated via `EXPO_PUBLIC_HAPPY_STORAGE_SCOPE` (set automatically in stack mode).

- **Per-stack “release” app** (recommended for demos / strict isolation):
  - Install a separate iOS app per stack (unique bundle id + scheme).
  - Each stack app is isolated by iOS app container (no token collisions).

## Shared dev-client app (install once)

Install the dedicated Happy Stacks dev-client app on your iPhone (USB).

This command **runs a prebuild** (generates `ios/` + runs CocoaPods) and then installs a Debug build
without starting Metro:

```bash
happys mobile-dev-client --install
```

If you want to ensure the dev-client is built from a specific stack’s active `happy` worktree
(e.g. to include upstream changes that aren’t merged into your default checkout yet), run:

```bash
happys stack mobile-dev-client <stack> --install
```

Optional:

```bash
happys mobile-dev-client --install --device="Your iPhone"
happys mobile-dev-client --install --clean
```

Then run any stack with mobile enabled:

```bash
happys stack dev <stack> --mobile
# or:
happys dev --mobile
```

Notes:

- **LAN requirement**: for physical iPhones, Metro must be reachable over LAN.
  - Happy Stacks defaults to `lan` for mobile, and will print a QR code + deep link.
  - For simulators you can usually use `localhost` (see `HAPPY_STACKS_MOBILE_HOST` below).
- **If Expo is already running in web-only mode**: re-run with `--restart` and include `--mobile`.

## Per-stack app install (isolated)

Install an isolated app for a specific stack (unique bundle id + scheme, Release config, no Metro):

```bash
happys stack mobile:install <stack> --name="Happy (<stack>)"
happys stack mobile:install <stack> --name="Happy PR 272" --device="Your iPhone"
```

The chosen app name is persisted in the stack env so you can re-run installs without re-typing it.

## Native iOS regeneration / “prebuild” (critical)

You’ll need to regenerate the iOS native project + Pods when:

- you pull changes that affect native deps / Expo config
- `components/happy/ios/` was deleted
- you hit CocoaPods / deployment-target mismatches after a dependency bump

Run:

```bash
happys mobile --prebuild
# (optional) fully regenerate ios/:
happys mobile --prebuild --clean
```

What this does today:

- runs `expo prebuild --no-install` (so we can patch before CocoaPods runs)
- patches `ios/Podfile.properties.json` to:
  - set `ios.deploymentTarget` to `16.0`
  - set `ios.buildReactNativeFromSource` to `true`
- patches the generated Xcode project deployment target (where applicable)
- runs `pod install`

Notes:

- **You usually don’t need to run this manually** because both:
  - `happys mobile-dev-client --install`
  - `happys stack mobile:install <stack>`
  already include `--prebuild`.
- Legacy alias: `happys mobile:prebuild` exists (hidden), but prefer `happys mobile --prebuild`.

## Manual `happys mobile` usage (advanced)

If you want to work on the embedded Expo app directly (outside `happys dev --mobile`), `happys mobile` supports:

```bash
# Start Metro (keeps running):
happys mobile --host=lan

# Build + install on iOS (and exit). If you omit --device, it will try to auto-pick a connected iPhone over USB:
happys mobile --prebuild --run-ios --device="Your iPhone"
happys mobile --prebuild --run-ios --configuration=Release --no-metro
```

## Notes / troubleshooting

- **QR opens the wrong app**:
  - The dev-client QR uses the `HAPPY_STACKS_DEV_CLIENT_SCHEME` (default: `happystacks-dev`).
  - Per-stack installs use a different per-stack scheme, so they should not intercept dev-client QR scans.

- **List connected devices** (for `--device=`):

```bash
happys mobile:devices
```

- **Code signing weirdness on a real iPhone**:
  - Happy Stacks will try to “un-pin” signing fields in the generated `.pbxproj` so Expo/Xcode can reconfigure signing
    (this avoids failures where automatic signing is disabled because `DEVELOPMENT_TEAM`/profiles were pinned).
  - If you want to manage signing manually, pass `--no-signing-fix` to `happys mobile ...` / `happys stack mobile <stack> ...`.

## Bake the default server URL into the app (optional)

If you want the built app to default to your happy-stacks server URL, set this **when building**:

```bash
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net" happys mobile-dev-client --install
```

Note: changing `HAPPY_STACKS_SERVER_URL` requires rebuilding/reinstalling the app you care about.

Important:

- For **non-main stacks**, `HAPPY_STACKS_SERVER_URL` is only respected if it’s set **in that stack’s env file**
  (safety: we ignore “global” URLs for non-main stacks to avoid accidentally repointing other stacks).

## Customizing the app identity (optional / advanced)

Happy Stacks uses these identities:

- **Dev-client**: defaults to `Happy Stacks Dev` + bundle id `com.happystacks.dev.<user>`
- **Per-stack release**: defaults to `Happy (<stack>)` + bundle id `com.happystacks.stack.<user>.<stack>`

If you want to build/install *manually* (instead of `mobile-dev-client` / `stack mobile:install`), you can override:

- **Bundle identifier (recommended for real iPhones)**:
  - You may need this if the bundle id you’re using isn’t available/owned by your Apple team.

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" happys mobile --prebuild --run-ios --no-metro
```

- **App name (what shows on the home screen)**:

```bash
HAPPY_STACKS_IOS_APP_NAME="Happy Local" happys mobile --prebuild --run-ios --no-metro
```

## Suggested env (recommended)

Add these to your main stack env file (`~/.happy/stacks/main/env`) (or `~/.happy-stacks/env.local` for global overrides) so you don’t have to prefix every command:

```bash
# How the phone reaches Metro:
# - lan: recommended for real devices
# - localhost: OK for simulators
HAPPY_STACKS_MOBILE_HOST="lan"

# (optional) default scheme used in the dev-client QR / deep link
# (must match your installed dev-client app):
HAPPY_STACKS_DEV_CLIENT_SCHEME="happystacks-dev"

# Default public server URL for the stack (baked into the Expo app config):
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net"

# Optional: home screen name:
HAPPY_STACKS_IOS_APP_NAME="Happy Local"
```
