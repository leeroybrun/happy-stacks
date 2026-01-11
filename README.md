# Happy Stacks



Run the **Happy** stack locally (or many stacks in parallel) and access it remotely and securely (using Tailscale).

`happy-stacks` is a CLI (`happys`) that orchestrate the real upstream repos
cloned under your configured workspace (default: `~/.happy-stacks/workspace/components/*`).

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

Recommended:

```bash
npx happy-stacks init
export PATH="$HOME/.happy-stacks/bin:$PATH"
```

Alternative (global install):

```bash
npm install -g happy-stacks
happys init
export PATH="$HOME/.happy-stacks/bin:$PATH"
```

(`init` will run `bootstrap` automatically. Use `--no-bootstrap` if you only want to write config and shims.)

Developer mode (clone this repo):

```bash
git clone https://github.com/leeroybrun/happy-stacks.git
cd happy-stacks

node ./bin/happys.mjs bootstrap --interactive
# legacy:
# pnpm bootstrap -- --interactive
```

Notes:

- In a cloned repo, `pnpm <script>` still works, but `happys <command>` is now the recommended UX (same underlying scripts).

### Step 2: Run the main stack

Starts the local server, CLI daemon, and serves the pre-built UI.

```bash
happys start
```

### Step 2b (first run only): authenticate the daemon

On a **fresh machine** (or any new stack), the daemon needs to authenticate once before it can register a “machine”.

```bash
happys auth login
```

#### Troubleshooting: “no machine” on first run (daemon auth)

If `.../new` shows “no machine” check whether this is **auth** vs a **daemon/runtime** issue:

```bash
happys auth status
```

If it says **auth is required**, run:

```bash
happys auth login
```

If auth is OK but the daemon isn’t running, run:

```bash
happys doctor
```

### Step 3: Enable Tailscale Serve (recommended for remote devices)

```bash
happys tailscale enable
happys tailscale url
```

### Step 4: Mobile access

Make sure Tailscale is [installed and running]
([https://tailscale.com/kb/1347/installation](https://tailscale.com/kb/1347/installation)) on your 
phone, then either:

- Open the URL from `happys tailscale url` on your phone and “Add to Home Screen”, or
- [Download the Happy mobile app]
([https://happy.engineering/](https://happy.engineering/)) and [configure it to use 
your local server](docs/remote-access.md).

Details (secure context, phone instructions, automation knobs): `[docs/remote-access.md](docs/remote-access.md)`.

## Why this exists

- **Automated setup**: `happys init` + `happys start` gets the whole stack up and running.
- **No hosted dependency**: run the full stack on your own computer.
- **Lower latency**: localhost/LAN is typically much faster than remote hosted servers.
- **Custom forks**: easily use forks of the Happy UI + CLI (e.g. `leeroybrun/*`) while still contributing upstream to `slopus/*`.
- **Worktrees**: clean upstream PR branches without mixing fork-only patches.
- **Stacks**: run multiple isolated instances in parallel (ports + dirs + component overrides).
- **Remote access**: `happys tailscale ...` helps you get an HTTPS URL for mobile/remote devices.

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
happys tailscale enable
happys tailscale url
```

Details: `[docs/remote-access.md](docs/remote-access.md)`.

### Worktrees + forks (clean upstream PRs)

Create a clean upstream PR worktree:

```bash
happys wt new happy pr/my-feature --from=upstream --use
happys wt push happy active --remote=upstream
```

Test an upstream PR locally:

```bash
happys wt pr happy https://github.com/slopus/happy/pull/123 --use
happys wt pr happy 123 --update --stash
```

Details: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`.

### Server flavor (server-light vs full server)

- Use `happy-server-light` for a light local stack (no Redis, no Postgres, no Docker), and UI serving via server-light.
- Use `happy-server` when you need some production-ready server (eg. to distribute and host multiple users) or develop server changes for upstream.

Switch globally:

```bash
happys srv status
happys srv use --interactive
```

Switch per-stack:

```bash
happys stack srv exp1 -- use --interactive
```

Details: `[docs/server-flavors.md](docs/server-flavors.md)`.

### Stacks (multiple isolated instances)

```bash
happys stack new exp1 --interactive
happys stack dev exp1
```

Point a stack at a PR worktree:

```bash
happys wt pr happy 123 --use
happys stack wt exp1 -- use happy slopus/pr/123-fix-thing
happys stack dev exp1
```

Details: `[docs/stacks.md](docs/stacks.md)`.

### Menu bar (SwiftBar)

```bash
happys menubar install
happys menubar open
```

Details: `[docs/menubar.md](docs/menubar.md)`.

### Mobile iOS dev (optional)

```bash
happys mobile --help
happys mobile --json
```

Details: `[docs/mobile-ios.md](docs/mobile-ios.md)`.

### Tauri desktop app (optional)

```bash
happys build --tauri
```

Details: `[docs/tauri.md](docs/tauri.md)`.

## Commands (high-signal)

- **Setup**:
  - `happys init`
  - `happys bootstrap --interactive` (wizard)
  - `happys bootstrap --forks|--upstream`
  - `happys bootstrap --server=happy-server|happy-server-light|both`
- **Run**:
  - `happys start` (production-like; serves built UI via server-light)
  - `happys dev` (dev; Expo web dev server for UI)
- **Server flavor**:
  - `happys srv status`
  - `happys srv use --interactive`
- **Worktrees**:
  - `happys wt use --interactive`
  - `happys wt pr <component> <pr-url|number> --use [--update] [--stash] [--force]`
  - `happys wt sync-all`
  - `happys wt update-all --dry-run` / `happys wt update-all --stash`
- **Stacks**:
  - `happys stack new --interactive`
  - `happys stack dev <name>` / `happys stack start <name>`
  - `happys stack edit <name> --interactive`
  - `happys stack wt <name> -- use --interactive`
  - `happys stack migrate`
- **Menu bar (SwiftBar)**:
  - `happys menubar install`

## Docs (deep dives)

- **Remote access (Tailscale + phone)**: `[docs/remote-access.md](docs/remote-access.md)`
- **Server flavors (server-light vs server)**: `[docs/server-flavors.md](docs/server-flavors.md)`
- **Worktrees + forks workflow**: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`
- **Stacks (multiple instances)**: `[docs/stacks.md](docs/stacks.md)`
- **Menu bar (SwiftBar)**: `[docs/menubar.md](docs/menubar.md)`
- **Mobile iOS dev**: `[docs/mobile-ios.md](docs/mobile-ios.md)`
- **Tauri desktop app**: `[docs/tauri.md](docs/tauri.md)`

## Configuration

Where config lives by default:

- `~/.happy-stacks/.env`: stable “pointer” file (home/workspace/runtime)
- `~/.happy-stacks/env.local`: optional global overrides
- `~/.happy/stacks/main/env`: main stack config (port, server flavor, component overrides)

Notes:

- Canonical env prefix is `HAPPY_STACKS_*` (legacy `HAPPY_LOCAL_*` still works).
- Canonical stack storage is `~/.happy/stacks` (legacy `~/.happy/local` is still supported).

For contributor/LLM workflow expectations: `[AGENTS.md](AGENTS.md)`.