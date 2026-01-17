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

Install the dedicated Happy Stacks dev-client app on your iPhone (USB):

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

## Per-stack app install (isolated)

Install an isolated app for a specific stack (unique bundle id + scheme, Release config, no Metro):

```bash
happys stack mobile:install <stack> --name="Happy (<stack>)"
happys stack mobile:install <stack> --name="Happy PR 272" --device="Your iPhone"
```

The chosen app name is persisted in the stack env so you can re-run installs without re-typing it.

## Notes / troubleshooting

- **QR opens the wrong app**:
  - The dev-client QR uses the `HAPPY_STACKS_DEV_CLIENT_SCHEME` (default: `happystacks-dev`).
  - Per-stack installs use a different per-stack scheme, so they should not intercept dev-client QR scans.

- **LAN requirement**:
  - Physical iPhones must reach Metro over LAN. Happy Stacks defaults to `lan` for dev-client Metro.

## Bake the default server URL into the app (optional)

If you want the built app to default to your happy-stacks server URL, set this **when building**:

```bash
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net" happys mobile-dev-client --install
```

Note: changing `HAPPY_STACKS_SERVER_URL` requires rebuilding/reinstalling the app you care about.

You can also set a custom bundle id (recommended for real devices):

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net" happys mobile --run-ios
```

## Customizing the app identity (optional)

- **Bundle identifier (recommended for real iPhones)**:
  - You may *need* this if the default isn’t available for your Apple team.

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" happys mobile --run-ios
```

- **App name (what shows on the home screen)**:

```bash
HAPPY_STACKS_IOS_APP_NAME="Happy Local" happys mobile --run-ios
```

## Suggested env (recommended)

Add these to your main stack env file (`~/.happy/stacks/main/env`) (or `~/.happy-stacks/env.local` for global overrides) so you don’t have to prefix every command:

```bash
# Required if you want the Release app to default to your stack server:
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net"

# Optional: default dev-client scheme (must match your installed dev-client app)
HAPPY_STACKS_DEV_CLIENT_SCHEME="happystacks-dev"

# Optional: home screen name:
HAPPY_STACKS_IOS_APP_NAME="Happy Local"
```
