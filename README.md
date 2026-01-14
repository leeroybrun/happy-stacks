# Happy Stacks

Run [**Happy**](https://happy.engineering/) locally and access it remotely and securely (using Tailscale).

## What is Happy?

Happy is an UI/CLI stack (server + web UI + CLI + daemon) who let you monitor and interact with Claude Code, Codex and Gemini sessions from your mobile, a web UI and/or a desktop app.

## What is Happy Stacks?

happy-stacks is a guided installer + local orchestration CLI for Happy.

If you only want to **self-host Happy**, start with the **Self-host** section below.
If you want to **develop Happy** (worktrees, multiple stacks, upstream PR workflows), see the **Development** section further down.

## Self-host Happy (install + run)

### Step 1: Setup

Recommended:

```bash
npx happy-stacks setup --profile=selfhost
```

Alternative (global install):

```bash
npm install -g happy-stacks
happys setup --profile=selfhost
```

`setup` can optionally start Happy and guide you through authentication.

### Step 2: Start Happy

Starts the local server, CLI daemon, and serves the pre-built UI.

```bash
happys start
```

### Step 3 (first run only): authenticate

On a **fresh machine** (or any new stack), the daemon needs to authenticate once before it can register a “machine”.

```bash
happys auth login
```

If you want a quick diagnosis:

```bash
happys auth status
```

### Step 4: Enable Tailscale Serve (recommended for mobile/remote)

```bash
happys tailscale enable
happys tailscale url
```

### Step 5: Mobile access

Make sure Tailscale is [installed and running]
([https://tailscale.com/kb/1347/installation](https://tailscale.com/kb/1347/installation)) on your 
phone, then either:

- Open the URL from `happys tailscale url` on your phone and “Add to Home Screen”, or
- [Download the Happy mobile app]
([https://happy.engineering/](https://happy.engineering/)) and [configure it to use 
your local server](docs/remote-access.md).

Details (secure context, phone instructions, automation knobs): `[docs/remote-access.md](docs/remote-access.md)`.

## Development (worktrees, stacks, contributor workflows)

### Setup (guided)

```bash
npx happy-stacks setup --profile=dev
```

### Developing from a cloned repo

```bash
git clone https://github.com/leeroybrun/happy-stacks.git
cd happy-stacks

node ./bin/happys.mjs setup --profile=dev
```

Notes:

- In a cloned repo, `pnpm <script>` still works, but `happys <command>` is the recommended UX (same underlying scripts).
- To make the installed `~/.happy-stacks/bin/happys` shim (LaunchAgents / SwiftBar) run your local checkout without publishing to npm, set:

  ```bash
  echo 'HAPPY_STACKS_CLI_ROOT_DIR=/path/to/your/happy-stacks-checkout' >> ~/.happy-stacks/.env
  ```

  Or (recommended) persist it via init:

  ```bash
  happys init --cli-root-dir=/path/to/your/happy-stacks-checkout
  ```

### Why this exists

- **Automated setup**: `happys setup` + `happys start` gets the whole stack up and running.
- **No hosted dependency**: run the full stack on your own computer.
- **Lower latency**: localhost/LAN is typically much faster than remote hosted servers.
- **Custom forks**: easily use forks of the Happy UI + CLI (e.g. `leeroybrun/*`) while still contributing upstream to `slopus/*`.
- **Worktrees**: clean upstream PR branches without mixing fork-only patches.
- **Stacks**: run multiple isolated instances in parallel (ports + dirs + component overrides).
- **Remote access**: `happys tailscale ...` helps you get an HTTPS URL for mobile/remote devices.

### How Happy Stacks wires “local” URLs

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
     | happy-server-light OR          |
     | happy-server (via UI gateway)  |
     |  - listens on :PORT            |
     |  - serves UI at /              |
     +--------------------------------+
                   ^
                   | internal loopback
                   |
            http://127.0.0.1:<port>
               (daemon / CLI)
```

More details + automation: `[docs/remote-access.md](docs/remote-access.md)`.

### How it’s organized

- **Scripts**: `scripts/*.mjs` (bootstrap/dev/start/build/stacks/worktrees/service/tailscale/mobile)
- **Components**: `components/*` (each is its own Git repo)
- **Worktrees**: `components/.worktrees/<component>/<owner>/<branch...>`

Components:

- `happy` (UI)
- `happy-cli` (CLI + daemon)
- `happy-server-light` (light server, can serve built UI)
- `happy-server` (full server)

### Quickstarts (feature-focused)

#### Remote access (Tailscale Serve)

```bash
happys tailscale enable
happys tailscale url
```

Details: `[docs/remote-access.md](docs/remote-access.md)`.

#### Worktrees + forks (clean upstream PRs)

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

#### Server flavor (server-light vs full server)

- Use `happy-server-light` for a light local stack (no Redis, no Postgres, no Docker), and UI serving via server-light.
- Use `happy-server` when you need a more production-like server (Postgres + Redis + S3-compatible storage) or want to develop server changes for upstream.
  - Happy Stacks can **manage the required infra automatically per stack** (via Docker Compose) and runs a **UI gateway** so you still get a single `https://...ts.net` URL that serves the UI + proxies API/websockets/files.

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

#### Stacks (multiple isolated instances)

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

#### Dev stacks: browser origin isolation (IMPORTANT)

Non-main stacks use a stack-specific localhost hostname (no `/etc/hosts` changes required):

- `http://happy-<stack>.localhost:<uiPort>`

This avoids browser auth/session collisions between stacks (separate origin per stack).

#### Menu bar (SwiftBar)

```bash
happys menubar install
happys menubar open
```

Details: `[docs/menubar.md](docs/menubar.md)`.

#### Mobile iOS dev (optional)

```bash
happys mobile --help
happys mobile --json
```

Details: `[docs/mobile-ios.md](docs/mobile-ios.md)`.

#### Tauri desktop app (optional)

```bash
happys build --tauri
```

Details: `[docs/tauri.md](docs/tauri.md)`.

### Commands (high-signal)

- **Setup**:
  - `happys setup` (guided; selfhost or dev)
  - (advanced) `happys init` (plumbing: shims/runtime/pointer env)
  - (advanced) `happys bootstrap --interactive` (component installer wizard)
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

### Docs (deep dives)

- **Remote access (Tailscale + phone)**: `[docs/remote-access.md](docs/remote-access.md)`
- **Server flavors (server-light vs server)**: `[docs/server-flavors.md](docs/server-flavors.md)`
- **Worktrees + forks workflow**: `[docs/worktrees-and-forks.md](docs/worktrees-and-forks.md)`
- **Stacks (multiple instances)**: `[docs/stacks.md](docs/stacks.md)`
- **Paths + env precedence (home/workspace/runtime/stacks)**: `[docs/paths-and-env.md](docs/paths-and-env.md)`
- **Menu bar (SwiftBar)**: `[docs/menubar.md](docs/menubar.md)`
- **Mobile iOS dev**: `[docs/mobile-ios.md](docs/mobile-ios.md)`
- **Tauri desktop app**: `[docs/tauri.md](docs/tauri.md)`

### Configuration

Where config lives by default:

- `~/.happy-stacks/.env`: stable “pointer” file (home/workspace/runtime)
- `~/.happy-stacks/env.local`: optional global overrides
- `~/.happy/stacks/main/env`: main stack config (port, server flavor, component overrides)

Notes:

- Canonical env prefix is `HAPPY_STACKS_*` (legacy `HAPPY_LOCAL_*` still works).
- Canonical stack storage is `~/.happy/stacks` (legacy `~/.happy/local` is still supported).
- **Repo env templates**:
  - **Use `.env.example` as the canonical template** (copy it to `.env` if you’re running this repo directly).
  - If an LLM tool refuses to read/edit `.env.example` due to safety restrictions, **do not create an `env.example` workaround**—instead, ask the user to apply the change manually.

For contributor/LLM workflow expectations: `[AGENTS.md](AGENTS.md)`.
