# Stacks (multiple local Happy instances)

`happy-stacks` supports running **multiple stacks** in parallel on the same machine.

A “stack” is just:

- a dedicated **server port**
- isolated directories for **UI build output**, **CLI home**, and **logs**
- optional per-component overrides (point at specific worktrees)

Stacks are configured via a plain env file stored under:

```
~/.happy/stacks/<name>/env
```

Legacy path (still supported during migration):

```
~/.happy/local/stacks/<name>/env
```

To migrate existing stacks:

```bash
happys stack migrate
```

## Create a stack

Non-interactive:

```bash
happys stack new exp1 --port=3010 --server=happy-server-light
```

Auto-pick a port:

```bash
happys stack new exp2
```

Interactive wizard (TTY only):

```bash
happys stack new --interactive
```

The wizard lets you:

- pick the server type (`happy-server-light` or `happy-server`)
- pick or create worktrees for `happy`, `happy-cli`, and the chosen server component
- choose which Git remote to base newly-created worktrees on (defaults to `upstream`)

## Run a stack

Dev mode:

```bash
happys stack dev exp1
```

Production-like mode:

```bash
happys stack start exp1
```

Build UI for a stack (server-light serving):

```bash
happys stack build exp1
```

Doctor:

```bash
happys stack doctor exp1
```

## Edit a stack (interactive)

To change server flavor, port, or component worktrees for an existing stack:

```bash
happys stack edit exp1 --interactive
```

## Switch server flavor for a stack

You can change `happy-server-light` vs `happy-server` for an existing stack without re-running the full edit wizard:

```bash
happys stack srv exp1 -- status
happys stack srv exp1 -- use happy-server-light
happys stack srv exp1 -- use happy-server
happys stack srv exp1 -- use --interactive
```

## Switch component worktrees for a stack (`stack wt`)

If you want the **exact** same UX as `happys wt`, but scoped to a stack env file:

```bash
happys stack wt exp1 -- status happy
happys stack wt exp1 -- use happy slopus/pr/my-ui-pr
happys stack wt exp1 -- use happy-cli default
```

This updates the stack env file (`~/.happy/stacks/<name>/env`), not repo `env.local` (legacy path still supported).

## Stack wrappers you can use

These commands run with the stack env file applied:

- `happys stack dev <name>`
- `happys stack start <name>`
- `happys stack build <name>`
- `happys stack doctor <name>`
- `happys stack mobile <name>`
- `happys stack srv <name> -- status|use ...`
- `happys stack wt <name> -- <wt args...>`
- `happys stack tailscale:status|enable|disable|url <name>`
- `happys stack service:* <name>`

Global/non-stack commands:

- `happys bootstrap` (sets up shared component repos)
- `happys cli:link` (installs `happy` shim under `~/.happy-stacks/bin/`)

## Services (macOS LaunchAgents)

Each stack can have its own LaunchAgent (so multiple stacks can start at login).

```bash
happys stack service:install exp1
happys stack service:status exp1
happys stack service:restart exp1
happys stack service:logs exp1
```

Implementation notes:

- Service label is stack-scoped:
  - `main` → `com.happy.stacks` (legacy: `com.happy.local`)
  - `exp1` → `com.happy.stacks.exp1` (legacy: `com.happy.local.exp1`)
- The LaunchAgent persists `HAPPY_STACKS_ENV_FILE` (and legacy `HAPPY_LOCAL_ENV_FILE`), so you can edit the stack env file without reinstalling.

## Component/worktree selection per stack

When creating a stack you can point components at worktrees:

```bash
happys stack new exp3 \\
  --happy=slopus/pr/my-ui-pr \\
  --happy-cli=slopus/pr/my-cli-pr \\
  --server=happy-server
```

Worktree specs are interpreted as:

```
components/.worktrees/<component>/<spec...>
```

So `--happy=slopus/pr/foo` maps to:

```
components/.worktrees/happy/slopus/pr/foo
```

You can also pass an absolute path.

## Stack env + repo env precedence

On startup, `happy-stacks` loads env in this order:

1. `~/.happy-stacks/.env` (defaults)
2. `~/.happy-stacks/env.local` (local overrides)
3. `HAPPY_STACKS_ENV_FILE` (stack env; highest precedence for `HAPPY_STACKS_*` / `HAPPY_LOCAL_*`)

`happys stack ...` sets `HAPPY_STACKS_ENV_FILE=~/.happy/stacks/<name>/env` (and also sets legacy `HAPPY_LOCAL_ENV_FILE`) and clears any already-exported `HAPPY_STACKS_*` / `HAPPY_LOCAL_*` variables so the stack env stays authoritative.

## Daemon auth + “no machine” on first run

On a **fresh machine** (or any new stack), the daemon may need to authenticate before it can register a “machine”.
If the UI shows “no machine” (or the daemon shows `auth_required`), it usually means the stack-specific CLI home
doesn’t have credentials yet:

- `~/.happy/stacks/<stack>/cli/access.key`

To check / authenticate a stack, run:

```bash
happys stack auth <stack> status
happys stack auth <stack> login
```

Notes:
- For the **main** stack, use `<stack>=main` and the default `<port>=3005` (unless you changed it).
- If you use Tailscale Serve, `HAPPY_WEBAPP_URL` should be your HTTPS URL (what you get from `happys tailscale url`).
- Logs live under `~/.happy/stacks/<stack>/cli/logs/`.

## JSON mode

For programmatic usage:

```bash
happys stack list --json
happys stack new exp3 --json
happys stack edit exp3 --interactive --json
```
