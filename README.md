# happy-local

One-command local stack for Happy:

- `happy-server-light` (API + Socket.IO relay, SQLite, no Redis/S3)
- `happy` UI (dev: Expo web server, prod: static build served by server-light)
- `happy-cli` daemon (so machines appear + sessions can be spawned remotely)

This launcher expects the component repos under `./components/`:

- `components/happy-server-light`
- `components/happy`
- `components/happy-cli`

## Usage

```bash
pnpm bootstrap
pnpm dev
```

## Scripts

- `pnpm bootstrap`: installs deps, builds `components/happy-cli`, and `npm link`s **happy-cli-local** (a tiny wrapper that sets local env vars automatically), then builds the static UI bundle (for `pnpm start`)
- `pnpm dev`: starts server + daemon + Expo web dev server (watch/reload)
- `pnpm build`: builds a static web UI bundle into `~/.happy/local/ui` and (by default) also builds the Tauri app
- `pnpm start`: starts server + daemon + serves the static UI at `/` (no Expo dev server)
- `pnpm service:install` / `pnpm service:uninstall`: install/remove the macOS LaunchAgent (autostart)
- `pnpm service:status`: show LaunchAgent status + `/health`
- `pnpm service:start` / `pnpm service:stop` / `pnpm service:restart`: manage the macOS background service
- `pnpm logs` / `pnpm logs:tail`: print or follow LaunchAgent logs
- `pnpm tailscale:status` / `pnpm tailscale:enable` / `pnpm tailscale:disable`: manage Tailscale Serve (HTTPS)
- `pnpm tailscale:url`: print the HTTPS `*.ts.net` URL (if configured)
- `pnpm stack:doctor` / `pnpm stack:fix`: diagnose common issues (and optionally apply safe fixes)

## Environment

You can override defaults with:

- `HAPPY_LOCAL_SERVER_URL` (public URL shown/used by UI; default `http://127.0.0.1:3005`)
- `HAPPY_LOCAL_SERVER_PORT` (default `3005`)
- `HAPPY_LOCAL_UI` (`1` to start UI, default `1`)
- `HAPPY_LOCAL_DAEMON` (`1` to start daemon, default `1`)
- `HAPPY_LOCAL_NPM_LINK` (`1` to `npm link` `happy-cli-local` into your PATH, default `1`)
- `HAPPY_LOCAL_CLI_BUILD` (`1` to run `pnpm build` in happy-cli before linking/daemon, default `1`)
- `HAPPY_LOCAL_CLI_HOME_DIR` (default `~/.happy/local/cli`, isolates local credentials from the hosted server)
- `HAPPY_LOCAL_UI_BUILD_DIR` (default `~/.happy/local/ui`)
- `HAPPY_LOCAL_SERVE_UI` (`1` to serve built UI in `pnpm start`, default `1`)
- `HAPPY_LOCAL_UI_PREFIX` (default `/`)
- `HAPPY_LOCAL_BUILD_TAURI` (`1` to also run Tauri build during `pnpm build`, default `1`)
- `HAPPY_LOCAL_TAURI_UI_DIR` (where to export the Tauri web UI, default `<happy>/dist`)
- `HAPPY_LOCAL_TAURI_DEBUG` (`1` to build Tauri in debug mode + enable devtools, default `1`)
- `HAPPY_LOCAL_TAURI_IDENTIFIER` (default `com.happy.local`, builds a separate “local” app so it doesn’t reuse old storage)
- `HAPPY_LOCAL_TAURI_PRODUCT_NAME` (default `Happy Local`)
- `METRICS_ENABLED` (default `false` in happy-local; set `true` to enable server-light metrics endpoint)
- `METRICS_PORT` (default `9090`)

### .env

You can create a `happy-local/.env` file to persist your local settings. See `env.example` for the available keys.

### Package managers

- `happy-local` commands are run via **pnpm** (you type `pnpm bootstrap`, `pnpm dev`, etc.)
- The embedded component repos are installed/built with **Yarn** (because they ship `yarn.lock` and we keep them upstream-compatible)

### Remote access over Tailscale (important)

When you open the UI from another device, the web UI must use the **current origin** as its server URL (so it talks to the same host you opened).
The web export intentionally does **not** hardcode `EXPO_PUBLIC_HAPPY_SERVER_URL`; it falls back to `window.location.origin`.

Also note: `http://<tailscale-ip>:3005` is **not a secure context** in browsers (unlike `http://localhost`), which can break WebCrypto-backed features (commonly used for secure storage / key handling).
For best results, expose the UI over **HTTPS** via Tailscale (recommended):

```bash
# On the host running happy-local:
tailscale serve --bg http://127.0.0.1:3005
```

Then open the `https://<machine>.<tailnet>.ts.net/` URL on your phone/computer.

Tip: set `HAPPY_LOCAL_SERVER_URL` to that HTTPS URL so the daemon/CLI generate correct “public” links (QR/login URLs) for remote devices.

Automation: by default, if Tailscale Serve is already configured on this machine, `pnpm start` will automatically prefer the `https://*.ts.net` URL for “public” links (unless you explicitly set `HAPPY_LOCAL_SERVER_URL` to something else, or set `HAPPY_LOCAL_TAILSCALE_PREFER_PUBLIC_URL=0`).

If you enable Serve via `HAPPY_LOCAL_TAILSCALE_SERVE=1`, `pnpm start` will also wait briefly for Tailscale to come up on boot (default 15s; override with `HAPPY_LOCAL_TAILSCALE_WAIT_MS`).

You can also have `pnpm start` configure this automatically by setting:

- `HAPPY_LOCAL_TAILSCALE_SERVE=1`
- `HAPPY_LOCAL_TAILSCALE_RESET_ON_EXIT=1` (optional)
 - `HAPPY_LOCAL_TAILSCALE_BIN=/Applications/Tailscale.app/Contents/MacOS/Tailscale` (if `tailscale` is not on PATH)
- `HAPPY_LOCAL_TAILSCALE_PREFER_PUBLIC_URL=1` (default): if Serve is configured, prefer the HTTPS `*.ts.net` URL for “public” links automatically

Or run:

```bash
pnpm tailscale:enable
pnpm tailscale:status
pnpm tailscale:url
```

### Notes on script structure (DRY)

Some logic is intentionally centralized into dedicated scripts:
- `scripts/service.mjs`: macOS LaunchAgent install/uninstall + start/stop/status + log tailing
- `scripts/tailscale.mjs`: Tailscale Serve enable/disable/status + URL extraction

Other areas we could extract next (if you want) are daemon management (start/stop/auth bootstrap) and “stack doctor” diagnostics, but they’re more coupled to `run.mjs`/`dev.mjs`.

## Build process (what `pnpm build` does)

`pnpm build` runs `node ./scripts/build.mjs` and performs:

- **Web UI export (for `pnpm start`)**
  - Runs Expo web export for `components/happy`
  - Output: `HAPPY_LOCAL_UI_BUILD_DIR` (default `~/.happy/local/ui`)
  - Important: `EXPO_PUBLIC_HAPPY_SERVER_URL` is set to empty for web exports so the app uses `window.location.origin` at runtime (required for Tailscale HTTPS).

- **Tauri UI export + Tauri app build (optional, enabled by default)**
  - Controlled by `HAPPY_LOCAL_BUILD_TAURI` (default `1`)
  - Exports a second web bundle for Tauri to `HAPPY_LOCAL_TAURI_UI_DIR` (default `<happy>/dist`)
    - Sets `EXPO_PUBLIC_HAPPY_SERVER_URL=http://127.0.0.1:<port>` for Tauri (because `tauri://` origins can’t use `window.location.origin`)
    - Also sets `EXPO_PUBLIC_SERVER_URL=http://127.0.0.1:<port>` for parts of the app that read that variable
  - Generates a temporary Tauri config:
    - `~/.happy/local/tauri.conf.happy-local.json`
    - Sets `frontendDist` to the exported directory
    - Disables upstream `beforeBuildCommand` / `beforeDevCommand`
    - Applies `HAPPY_LOCAL_TAURI_IDENTIFIER` + `HAPPY_LOCAL_TAURI_PRODUCT_NAME`
    - If `HAPPY_LOCAL_TAURI_DEBUG=1` (default): enables `devtools: true`
  - Builds with isolated Rust output dir:
    - `CARGO_TARGET_DIR=~/.happy/local/tauri-target`
  - Runs: `tauri build --config <generated> [--debug]`

### Autostart (macOS)

Enable start-on-boot:

```bash
pnpm bootstrap -- --autostart
```

Start/stop/status/logs:

```bash
pnpm service:status
pnpm service:restart
pnpm logs:tail
```

Disable:

```bash
pnpm bootstrap -- --no-autostart
```

### Cloning components (optional)

If `./components/*` is missing, `pnpm bootstrap -- --clone` can clone (if you set repo URLs):

- `HAPPY_LOCAL_SERVER_REPO_URL`
- `HAPPY_LOCAL_CLI_REPO_URL`
- `HAPPY_LOCAL_UI_REPO_URL`

Disable auto-clone:

```bash
pnpm bootstrap -- --no-clone
```

