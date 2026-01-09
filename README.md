# Happy Stacks

Run the **Happy** stack locally (or many stacks in parallel) and access it remotely and securely (using Tailscale).

`happy-stacks` is a set of Node scripts (`scripts/*.mjs`) that orchestrate the real upstream repos cloned under `components/*`.

## What is Happy?

Happy is an UI/CLI stack (server + web UI + CLI + daemon) who let you monitor and interact with Claude Code, Codex and Gemini sessions from your mobile, a web UI and/or a desktop app.

## What is Happy Stacks?

happy-stacks is a “launcher + workflow toolkit” to:

- run Happy fully on your own machine (no hosted dependency)
- safely access it remotely (HTTPS secure context) via Tailscale
- manage **worktrees** for clean upstream PRs while keeping a patched fork
- run **multiple isolated stacks** (ports + dirs + component overrides)
- optionally manage autostart (macOS LaunchAgent) and a SwiftBar menu bar control panel

## Quickstart

### Step 1: Install / bootstrap

```bash
git clone https://github.com/leeroybrun/happy-stacks.git
cd happy-stacks

pnpm bootstrap -- --interactive
```

### Step 2: Run the main stack

Starts the local server, CLI daemon, and serves the pre-built UI.

```bash
pnpm start
```

### Step 3: Enable Tailscale Serve (recommended for remote devices)

```bash
pnpm tailscale:enable
pnpm tailscale:url
```

### Step 4: Mobile access

Make sure Tailscale is [installed and running]
([https://tailscale.com/kb/1347/installation](https://tailscale.com/kb/1347/installation)) on your 
phone, then either:

- Open the URL from `pnpm tailscale:url` on your phone and “Add to Home Screen”, or
- [Download the Happy mobile app]
([https://happy.engineering/](https://happy.engineering/)) and [configure it to use 
your local server](docs/remote-access.md).

Details (secure context, phone instructions, automation knobs): `[docs/remote-access.md](docs/remote-access.md)`.

## Why this exists

- **Automated setup**: `pnpm bootstrap` + `pnpm start` gets the whole stack up and running.
- **No hosted dependency**: run the full stack on your own computer.
- **Lower latency**: localhost/LAN is typically much faster than remote hosted servers.
- **Custom forks**: easily use forks of the Happy UI + CLI (e.g. `leeroybrun/*`) while still contributing upstream to `slopus/*`.
- **Worktrees**: clean upstream PR branches without mixing fork-only patches.
- **Stacks**: run multiple isolated instances in parallel (ports + dirs + component overrides).
- **Remote access**: `pnpm tailscale:*` helps you get an HTTPS URL for mobile/remote devices.

## How Happy Stacks wires “local” URLs

There are two “URLs” to understand:

- **Internal URL**: used by local processes on this machine (server/daemon/CLI)
  - typically `http://127.0.0.1:<port>`
- **Public URL**: used by other devices (phone/laptop) and embedded links/QR codes
  - recommended: `https://<machine>.<tailnet>.ts.net` via Tailscale Serve

Diagram:

```text
             other device (phone/laptop)
                   |
                   |  HTTPS (secure context)
                   v
        https://<machine>.<tailnet>.ts.net
                   |
                   | (tailscale serve)
                   v
           local machine (this repo)
     +--------------------------------+
     | happy-server(-light)           |
     |  - listens on :PORT            |
     |  - serves UI (server-light)    |
     +--------------------------------+
                   ^
                   | internal loopback
                   |
            http://127.0.0.1:<port>
               (daemon / CLI)
```

More details + automation: `[docs/remote-access.md](docs/remote-access.md)`.

## How it’s organized

- **Scripts**: `scripts/*.mjs` (bootstrap/dev/start/build/stacks/worktrees/service/tailscale/mobile)
- **Components**: `components/*` (each is its own Git repo)
- **Worktrees**: `components/.worktrees/<component>/<owner>/<branch...>`

Components:

- `happy` (UI)
- `happy-cli` (CLI + daemon)
- `happy-server-light` (light server, can serve built UI)
- `happy-server` (full server)

## Quickstarts (feature-focused)

### Remote access (Tailscale Serve)

```bash
pnpm tailscale:enable
pnpm tailscale:url
```

Details: `[docs/remote-access.md](docs/remote-access.md)`.

### Worktrees + forks (clean upstream PRs)

Create a clean upstream PR worktree:

```bash
pnpm wt new happy pr/my-feature --from=upstream --use
pnpm wt push happy active --remote=upstream
```

Test an upstream PR locally:

```bash
pnpm wt pr happy https://github.com/slopus/happy/pull/123 --use
pnpm wt pr happy 123 --update --stash
```

Details: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`.

### Server flavor (server-light vs full server)

- Use `happy-server-light` for a light local stack (no Redis, no Postgres, no Docker), and UI serving via server-light.
- Use `happy-server` when you need some production-ready server (eg. to distribute and host multiple users) or develop server changes for upstream.

Switch globally:

```bash
pnpm srv -- status
pnpm srv -- use --interactive
```

Switch per-stack:

```bash
pnpm stack srv exp1 -- use --interactive
```

Details: `[docs/server-flavors.md](docs/server-flavors.md)`.

### Stacks (multiple isolated instances)

```bash
pnpm stack new exp1 --interactive
pnpm stack dev exp1
```

Point a stack at a PR worktree:

```bash
pnpm wt pr happy 123 --use
pnpm stack wt exp1 -- use happy slopus/pr/123-fix-thing
pnpm stack dev exp1
```

Details: `[docs/stacks.md](docs/stacks.md)`.

### Menu bar (SwiftBar)

```bash
pnpm menubar:install
pnpm menubar:open
```

Details: `[docs/menubar.md](docs/menubar.md)`.

### Mobile iOS dev (optional)

```bash
pnpm mobile -- --help
pnpm mobile -- --json
```

Details: `[docs/mobile-ios.md](docs/mobile-ios.md)`.

### Tauri desktop app (optional)

```bash
pnpm build -- --tauri
```

Details: `[docs/tauri.md](docs/tauri.md)`.

## Commands (high-signal)

- **Setup**:
  - `pnpm bootstrap`
  - `pnpm bootstrap -- --interactive` (wizard)
  - `pnpm bootstrap -- --forks|--upstream`
  - `pnpm bootstrap -- --server=happy-server|happy-server-light|both`
- **Run**:
  - `pnpm start` (production-like; serves built UI via server-light)
  - `pnpm dev` (dev; Expo web dev server for UI)
- **Server flavor**:
  - `pnpm srv -- status`
  - `pnpm srv -- use --interactive`
- **Worktrees**:
  - `pnpm wt use --interactive`
  - `pnpm wt pr <component> <pr-url|number> --use [--update] [--stash] [--force]`
  - `pnpm wt sync-all`
  - `pnpm wt update-all --dry-run` / `pnpm wt update-all --stash`
- **Stacks**:
  - `pnpm stack new --interactive`
  - `pnpm stack dev <name>` / `pnpm stack start <name>`
  - `pnpm stack edit <name> --interactive`
  - `pnpm stack wt <name> -- use --interactive`
  - `pnpm stack migrate`
- **Menu bar (SwiftBar)**:
  - `pnpm menubar:install`

## Docs (deep dives)

- **Remote access (Tailscale + phone)**: `[docs/remote-access.md](docs/remote-access.md)`
- **Server flavors (server-light vs server)**: `[docs/server-flavors.md](docs/server-flavors.md)`
- **Worktrees + forks workflow**: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`
- **Stacks (multiple instances)**: `[docs/stacks.md](docs/stacks.md)`
- **Menu bar (SwiftBar)**: `[docs/menubar.md](docs/menubar.md)`
- **Mobile iOS dev**: `[docs/mobile-ios.md](docs/mobile-ios.md)`
- **Tauri desktop app**: `[docs/tauri.md](docs/tauri.md)`

## Configuration

- Copy the template:

```bash
cp env.example .env
```

Notes:

- Canonical env prefix is `HAPPY_STACKS_*` (legacy `HAPPY_LOCAL_*` still works).
- Canonical stack storage is `~/.happy/stacks` (legacy `~/.happy/local` is still supported).

For contributor/LLM workflow expectations: `[AGENTS.md](AGENTS.md)`.