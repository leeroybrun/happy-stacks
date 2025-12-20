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
- `pnpm start`: starts server + daemon + serves the static UI at `/ui` (no Expo dev server)

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
- `HAPPY_LOCAL_TAURI_DEBUG` (`1` to build Tauri in debug mode + enable devtools, default `0`)
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

When you open the UI from another device (e.g. `http://<tailscale-ip>:3005`), the web UI must use the **current origin** as its server URL.
So the web export intentionally does **not** hardcode `EXPO_PUBLIC_HAPPY_SERVER_URL`; it falls back to `window.location.origin`.

Also note: `http://<tailscale-ip>:3005` is **not a secure context** in browsers (unlike `http://localhost`), which can break WebCrypto-backed features (commonly used for secure storage / key handling).
For best results, expose the UI over **HTTPS** via Tailscale (recommended):

```bash
# On the host running happy-local:
tailscale serve --bg http://127.0.0.1:3005
```

Then open the `https://<machine>.<tailnet>.ts.net/` URL on your phone/computer.

You can also have `pnpm start` configure this automatically by setting:

- `HAPPY_LOCAL_TAILSCALE_SERVE=1`
- `HAPPY_LOCAL_TAILSCALE_RESET_ON_EXIT=1` (optional)

### Autostart (macOS)

Enable start-on-boot:

```bash
pnpm bootstrap -- --autostart
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

