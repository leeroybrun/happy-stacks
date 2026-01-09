# Happy Stacks

Run the Happy stack locally with a single launcher, and access it remotely using Tailscale.

`happy-stack` itself is a set of Node scripts (`scripts/*.mjs`). The Happy repos are cloned into `./components/*` by the `pnpm bootstrap` script.

## Quickstart

### Step 1: Install

```bash
git clone https://github.com/leeroybrun/happy-local.git
cd happy-local

pnpm bootstrap
```

### Step 2: Run the stack

Starts the local server, CLI daemon, and serves the pre-built UI.

```bash
pnpm start
```

### Step 3: Enable Tailscale Serve

Make sure Tailscale is [installed and running](https://tailscale.com/kb/1347/installation) on your computer, then:

```bash
pnpm tailscale:enable
pnpm tailscale:url
```

### Step 4: Mobile access

Make sure Tailscale is [installed and running](https://tailscale.com/kb/1347/installation) on your phone, then either:

Open the URL from `pnpm tailscale:url` on your phone & add it to your home screen (prefered, always up-to-date).

or

[Download the Happy mobile app](https://happy.engineering/) and [configure it to use your local server](#using-happy-local-from-your-phone).

## Table of contents

- [Why this exists](#why-this-exists)
- [How it works](#how-it-works)
- [Commands (cheat sheet)](#commands-cheat-sheet)
- [Tailscale HTTPS (recommended for remote devices)](#tailscale-https-recommended-for-remote-devices)
- [Using Happy Local from your phone](#using-happy-local-from-your-phone)
- [Components + cloning (default behavior)](#components--cloning-default-behavior)
- [Autostart (macOS)](#autostart-macos)
- [Tauri desktop app](#tauri-desktop-app-optional)
- [Configuration](#configuration)
- [Troubleshooting](#troubleshooting)

## Why this exists

- **Automated setup**: `pnpm bootstrap` + `pnpm start` gets the whole stack up and running.
- **No hosted dependency**: you can run the full stack on your own computer and not depend on any external server.
- **Lower latency**: local loopback/LAN typically has lower latency than a remote hosted server.
- **Custom forks**: you can easily use custom forks of the Happy UI + CLI (e.g. our `leeroybrun/*` forks).
- **Optional autostart**: `happy-local` can be configured to automatically start on login (via a macOS LaunchAgent).
  - This makes your local Happy server always running (minimal footprint: just `happy-server-light` serving the built UI & API + `happy` CLI daemon).
- **Tailscale integration**: `happy-local` can automatically configure Tailscale Serve for you. This gives you a public HTTPS URL for the local server, which you can use on mobile to connect to the local UI + API.
- **Isolated CLI home**: the daemon/CLI use `HAPPY_HOME_DIR=~/.happy/local/cli` by default so you don’t overwrite/contaminate your normal Happy credentials.

## How it works

- **`happy-server-light`**: the local API + websocket relay. Can also **serve a prebuilt web UI** at `/`.
- **`happy`**: the UI. Pre-built once and served by server-light. In “dev” mode, it runs as an Expo web dev server.
- **`happy-cli`**: provides the `happy` CLI and the happy background **daemon** used for machine presence + remote session spawning.
- **`happy-cli-local` (wrapper)**: `happy-local` links a small wrapper into your PATH so `happy` CLI automatically points at the local server and uses an isolated home dir.

### Local wiring (how everything points at “local”)

When `happy-local` starts the daemon, it sets:

- `HAPPY_SERVER_URL` → the internal loopback URL (e.g. `http://127.0.0.1:3005`)
- `HAPPY_WEBAPP_URL` / `PUBLIC_URL` → the “public” URL you might open on another device (often a Tailscale HTTPS URL)

## Commands (cheat sheet)

- **Setup**
  - `pnpm bootstrap`: clone missing components, install deps, link `happy` wrapper, build UI (optionally Tauri), optionally install LaunchAgent
  - `pnpm bootstrap -- --upstream`: use `slopus/*` forks instead of `leeroybrun/*`
  - `pnpm bootstrap -- --tauri`: build Tauri desktop app (plus the Tauri-specific UI export)
  - `pnpm bootstrap -- --autostart`: install LaunchAgent to automatically start on login
  - `pnpm bootstrap -- --no-build`: skip building the UI (useful if you just want to update deps)
  - `pnpm bootstrap -- --no-link`: skip linking the `happy` wrapper into PATH
- **Run**
  - `pnpm start`: production-like (server + daemon + serve built UI)
  - `pnpm dev`: dev mode (server + daemon + Expo web dev server)
- **Build**
  - `pnpm build`: build the static web UI bundle (no Tauri unless enabled)
  - `pnpm build -- --tauri`: build the Tauri desktop app (plus the Tauri-specific UI export)
- **CLI wrapper**
  - `pnpm cli:link`: re-link `happy` wrapper into PATH
- **Tailscale**
  - `pnpm tailscale:enable` / `pnpm tailscale:disable` / `pnpm tailscale:status` / `pnpm tailscale:url`
- **Autostart (macOS)**
  - `pnpm service:install` / `pnpm service:uninstall`
  - `pnpm service:start` / `pnpm service:stop` / `pnpm service:restart` / `pnpm service:status`
  - `pnpm logs` / `pnpm logs:tail`
- **Diagnostics**
  - `pnpm stack:doctor`
  - `pnpm stack:fix`

## Tailscale HTTPS (recommended for remote devices)

Browsers treat `http://localhost` as a secure context, but **not** `http://<tailscale-ip>:3005`. Some Happy features rely on WebCrypto, so remote access works ONLY over HTTPS.

[Tailscale Serve](https://tailscale.com/kb/1312/serve) provides a public HTTPS URL for your local server, only accessible from within your Tailscale network.

Make sure Tailscale is [installed and running](https://tailscale.com/kb/1347/installation) on your computer, then:

```bash
pnpm tailscale:enable
pnpm tailscale:url
```

Automation:

- If Serve is already configured, `pnpm start` will automatically prefer the `https://*.ts.net` URL for “public” links (unless you explicitly set `HAPPY_LOCAL_SERVER_URL`).
- Set `HAPPY_LOCAL_TAILSCALE_SERVE=1` in `.env` to have `pnpm start` enable Serve automatically on boot (and optionally wait; see `HAPPY_LOCAL_TAILSCALE_WAIT_MS`).

## Using Happy Local from your phone

You have two good options:

### Option A: use the served web UI on mobile (no app updates required)

This is the simplest way to use the latest UI changes from our fork without updating the native app:

- Run `pnpm start` on your computer
- Open the **public URL** on your phone (see Tailscale section above)
  - You’ll get the UI served directly by `happy-server-light` at `/`
  - Because it’s built from your `components/happy`, it includes our latest fork changes

When you pull new UI changes and want your phone to see them:

```bash
pnpm build
```

### Option B: point the upstream Happy mobile app at your local server

The upstream Happy mobile app includes a hidden “API Endpoint” setting. Point it at the **same public URL** you’re using for the local stack (recommended: Tailscale HTTPS).

Recommended setup:

- Enable Tailscale Serve so the phone loads the UI/API over **HTTPS** (secure context)
- Use the HTTPS `*.ts.net` URL as your “server URL” inside the app

Where the setting lives (upstream `slopus/happy`):

- Open **Settings**
- Tap **Version** 10 times (enables Developer Mode)
- Go to **Developer Tools**
- In **Network**, tap **API Endpoint**
- Paste your `https://<machine>.<tailnet>.ts.net` URL
- Restart the app (the dev screen explicitly asks for a restart to apply)

Notes:

- A phone can’t use `http://localhost:3005` (that would refer to the phone itself).
- `http://<tailscale-ip>:3005` is **not** a secure context; prefer HTTPS via Tailscale Serve.
- `happy-local` tries to keep the “public URL” consistent so QR/login links generated by the server/daemon work on other devices.

## What `pnpm bootstrap` does

- Ensures `components/*` exists ([`happy-server-light`](https://github.com/leeroybrun/happy-server-light), [`happy`](https://github.com/leeroybrun/happy), [`happy-cli`](https://github.com/leeroybrun/happy-cli))
  - Auto-clone from `leeroybrun/*` forks otherwise (use `pnpm bootstrap -- --upstream` to use `slopus/*` instead)
- Installs dependencies inside each component (Yarn when `yarn.lock` exists)
- Builds `components/happy-cli` and links `packages/happy-cli-local` into your PATH (so `happy` CLI uses local server)
- Builds the static UI bundle (under `~/.happy/local/ui`), so `pnpm start` & `happy-server-light` can serve it
- Optionally builds the Tauri desktop app (opt-in: `pnpm bootstrap -- --tauri`)
- Optionally install auto-start service if `--autostart` is provided (macOS only)

## Components + cloning (default behavior)

The launcher expects component repos under:

- `components/happy-server-light`
- `components/happy`
- `components/happy-cli`

On a fresh checkout, `pnpm bootstrap` will **auto-clone any missing components**.

- **Default clone source**: our forks (`leeroybrun/*`)
- **Upstream clone source**: `slopus/*`

Pick the source explicitly:

```bash
pnpm bootstrap -- --forks
pnpm bootstrap -- --upstream
```

Disable cloning (and manage `components/*` yourself):

```bash
pnpm bootstrap -- --no-clone
```

Override any repo URL (works with either source):

- `HAPPY_LOCAL_UI_REPO_URL`
- `HAPPY_LOCAL_CLI_REPO_URL`
- `HAPPY_LOCAL_SERVER_REPO_URL`

Or set the default in `.env`:

- `HAPPY_LOCAL_REPO_SOURCE=upstream` (or `forks`)

## The `happy` CLI wrapper (important)

`pnpm bootstrap` makes `happy` point at `packages/happy-cli-local`, which sets the right env vars for the local stack.

If you ever need to re-link:

```bash
pnpm cli:link
```

## Autostart (macOS)

Enable start-on-boot:

```bash
pnpm bootstrap -- --autostart
```

Manage the service:

```bash
pnpm service:status
pnpm service:restart
pnpm logs:tail
```

Disable:

```bash
pnpm bootstrap -- --no-autostart
```

## Tauri desktop app

The Tauri app is a native desktop wrapper around the web UI. It’s useful when you want:

- A native desktop window (instead of a browser tab)
- Separate storage from the “regular” Happy desktop app (so it doesn’t reuse old server URLs/auth)

Important behavior:

- The Tauri app must embed an explicit API base URL
- By default, `happy-local` will embed:
  - a **Tailscale Serve** `https://*.ts.net` URL if it detects one on this machine (generate a portable app for all devices on the same tailnet), otherwise
  - the local loopback URL `http://127.0.0.1:<HAPPY_LOCAL_SERVER_PORT>` (same-machine only).
- If you change what URL you want embedded, rebuild the Tauri app.

### Prereqs

- Rust toolchain installed
- Tauri build dependencies installed for your OS

### Build it

Build (one-off):

```bash
pnpm build -- --tauri
```

Or during bootstrap:

```bash
pnpm bootstrap -- --tauri
```

### Run it

1) Start the local server (or install the service):

```bash
pnpm start
```

2) Launch the built app bundle (location is under `~/.happy/local/tauri-target/`).

### “Portable” Tauri builds (send to another computer)

If you build the Tauri app while Tailscale Serve is enabled on the server machine, the app will embed the `https://*.ts.net` URL and can be copied to another computer.

Requirements:

- The server machine is running `pnpm start` and Tailscale Serve is enabled
- The other computer is on the same tailnet and can access the `https://*.ts.net` URL

Notes:

- By default we build Tauri in **debug** mode so devtools are enabled (controlled by `HAPPY_LOCAL_TAURI_DEBUG=1`).
- The build script generates a temporary Tauri config at `~/.happy/local/tauri.conf.happy-local.json`.

### Configuration (most useful)

- `HAPPY_LOCAL_TAURI_IDENTIFIER` (default `com.happy.local`)
- `HAPPY_LOCAL_TAURI_PRODUCT_NAME` (default `Happy Local`)
- `HAPPY_LOCAL_TAURI_DEBUG=0` (build release-like without devtools)
- `HAPPY_LOCAL_TAURI_SERVER_URL` (force the embedded API URL)
- `HAPPY_LOCAL_TAURI_PREFER_TAILSCALE=0` (disable Tailscale detection; always embed `127.0.0.1`)

## Configuration

### `.env` / `env.local`

All `happy-local` scripts auto-load configuration from:

- `.env` (recommended for persistent local overrides; ignored by git)
- `env.local` (optional)

Quick tip:

```bash
cp .env.example .env
```

### Environment variables (high-signal)

- **Server**: `HAPPY_LOCAL_SERVER_PORT`, `HAPPY_LOCAL_SERVER_URL`
- **What to run**: `HAPPY_LOCAL_UI=0`, `HAPPY_LOCAL_DAEMON=0`, `HAPPY_LOCAL_SERVE_UI=0`
- **Paths**: `HAPPY_LOCAL_CLI_HOME_DIR`, `HAPPY_LOCAL_UI_BUILD_DIR`
- **Cloning**: `HAPPY_LOCAL_REPO_SOURCE`, `HAPPY_LOCAL_*_REPO_URL`, `HAPPY_LOCAL_CLONE_MISSING=0`
- **Tauri build** (optional): `pnpm bootstrap -- --tauri` / `pnpm build -- --tauri` (or set `HAPPY_LOCAL_BUILD_TAURI=1`; override with `--no-tauri`)

## Development

Starts the local server, CLI daemon, and Expo web dev server for UI.

```bash
pnpm dev
```

## Troubleshooting

- `pnpm stack:doctor`
- `pnpm stack:fix`
- `pnpm logs:tail` (if using the macOS service)

