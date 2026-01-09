# Mobile app development (iOS)

This is optional. Most people can use the served web UI on mobile via Tailscale:
see the “Using Happy from your phone” section in the main README.

## Prereqs (one-time)

- Xcode installed
- CocoaPods installed (`brew install cocoapods`)

## Step 1: Generate iOS native project + Pods (run when needed)

Run this after pulling changes that affect native deps/config, or if `ios/` was deleted:

```bash
pnpm mobile:prebuild
```

## Step 2: Install the iOS dev build

- **iOS Simulator**:

```bash
pnpm mobile --run-ios --device="iPhone 16 Pro"
```

- **Real iPhone** (requires code signing in Xcode once):

```bash
pnpm mobile --run-ios --device="Your iPhone"
```

Tip: you can omit `--device` to auto-pick the first connected iPhone over USB:

```bash
pnpm mobile --run-ios
```

To see the exact device names/IDs you can pass:

```bash
pnpm mobile:devices
```

If you hit a bundle identifier error (e.g. `com.slopus.happy.dev` “not available”), set a unique local bundle id:

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" pnpm mobile --run-ios
# legacy: HAPPY_LOCAL_IOS_BUNDLE_ID="com.yourname.happy.local.dev" pnpm mobile --run-ios
```

## Release build (runs without Metro)

Build + install a Release configuration (no Metro required at runtime):

```bash
pnpm mobile:install
```

## Step 3: Start Metro (dev client)

- **iOS Simulator**:

```bash
pnpm mobile --host=localhost
```

- **Real iPhone** (same Wi‑Fi as your Mac):

```bash
pnpm mobile --host=lan
```

Open the dev build and tap Reload. Scanning the QR should open the dev build (not the App Store app).

## Bake the default server URL into the app (optional)

If you want the built app to default to your happy-stacks server URL, set this **when building**:

```bash
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net" pnpm mobile:install
```

Note: changing `HAPPY_STACKS_SERVER_URL` requires rebuilding/reinstalling the Release app (`pnpm mobile:install`).

You can also set a custom bundle id (recommended for real devices):

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net" pnpm mobile:install
```

## Customizing the app identity (optional)

- **Bundle identifier (recommended for real iPhones)**:
  - You may *need* this if the default `com.slopus.happy.dev` can’t be registered on your Apple team.

```bash
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" pnpm mobile --run-ios
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev" pnpm mobile:install
```

- **App name (what shows on the home screen)**:

```bash
HAPPY_STACKS_IOS_APP_NAME="Happy Local" pnpm mobile:install
```

## Suggested `.env` (recommended)

Add these to your `.env` (and `env.example`) so you don’t have to prefix every command:

```bash
# Required if you want the Release app to default to your stack server:
HAPPY_STACKS_SERVER_URL="https://<your-machine>.<tailnet>.ts.net"

# Strongly recommended for real devices (needs to be unique + owned by your Apple team):
HAPPY_STACKS_IOS_BUNDLE_ID="com.yourname.happy.local.dev"

# Optional: home screen name:
HAPPY_STACKS_IOS_APP_NAME="Happy Local"
```

## Personal build on iPhone (EAS internal distribution)

```bash
cd components/happy
eas build --profile development --platform ios
```

Then keep Metro running from `happy-stacks`:

```bash
pnpm mobile --host=lan
```

