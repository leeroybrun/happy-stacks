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
pnpm stack migrate
```

## Create a stack

Non-interactive:

```bash
pnpm stack new exp1 --port=3010 --server=happy-server-light
```

Auto-pick a port:

```bash
pnpm stack new exp2
```

Interactive wizard (TTY only):

```bash
pnpm stack new --interactive
```

The wizard lets you:

- pick the server type (`happy-server-light` or `happy-server`)
- pick or create worktrees for `happy`, `happy-cli`, and the chosen server component
- choose which Git remote to base newly-created worktrees on (defaults to `upstream`)

## Run a stack

Dev mode:

```bash
pnpm stack dev exp1
```

Production-like mode:

```bash
pnpm stack start exp1
```

Build UI for a stack (server-light serving):

```bash
pnpm stack build exp1
```

Doctor:

```bash
pnpm stack doctor exp1
```

## Edit a stack (interactive)

To change server flavor, port, or component worktrees for an existing stack:

```bash
pnpm stack edit exp1 --interactive
```

## Switch server flavor for a stack

You can change `happy-server-light` vs `happy-server` for an existing stack without re-running the full edit wizard:

```bash
pnpm stack srv exp1 -- status
pnpm stack srv exp1 -- use happy-server-light
pnpm stack srv exp1 -- use happy-server
pnpm stack srv exp1 -- use --interactive
```

## Switch component worktrees for a stack (`stack wt`)

If you want the **exact** same UX as `pnpm wt`, but scoped to a stack env file:

```bash
pnpm stack wt exp1 -- status happy
pnpm stack wt exp1 -- use happy slopus/pr/my-ui-pr
pnpm stack wt exp1 -- use happy-cli default
```

This updates the stack env file (`~/.happy/stacks/<name>/env`), not repo `env.local` (legacy path still supported).

## Stack wrappers you can use

These commands run with the stack env file applied:

- `pnpm stack dev <name>`
- `pnpm stack start <name>`
- `pnpm stack build <name>`
- `pnpm stack doctor <name>`
- `pnpm stack mobile <name>`
- `pnpm stack srv <name> -- status|use ...`
- `pnpm stack wt <name> -- <wt args...>`
- `pnpm stack tailscale:status|enable|disable|url <name>`
- `pnpm stack service:* <name>`

Global/non-stack commands:

- `pnpm bootstrap` (sets up shared component repos)
- `pnpm cli:link` (global PATH wrapper install)

## Services (macOS LaunchAgents)

Each stack can have its own LaunchAgent (so multiple stacks can start at login).

```bash
pnpm stack service:install exp1
pnpm stack service:status exp1
pnpm stack service:restart exp1
pnpm stack service:logs exp1
```

Implementation notes:

- Service label is stack-scoped:
  - `main` → `com.happy.stacks` (legacy: `com.happy.local`)
  - `exp1` → `com.happy.stacks.exp1` (legacy: `com.happy.local.exp1`)
- The LaunchAgent persists `HAPPY_STACKS_ENV_FILE` (and legacy `HAPPY_LOCAL_ENV_FILE`), so you can edit the stack env file without reinstalling.

## Component/worktree selection per stack

When creating a stack you can point components at worktrees:

```bash
pnpm stack new exp3 \\
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

1. `happy-stacks/.env` (defaults)
2. `happy-stacks/env.local` (local overrides)
3. `HAPPY_STACKS_ENV_FILE` (stack env; highest precedence for `HAPPY_STACKS_*` / `HAPPY_LOCAL_*`)

`pnpm stack ...` sets `HAPPY_STACKS_ENV_FILE=~/.happy/stacks/<name>/env` (and also sets legacy `HAPPY_LOCAL_ENV_FILE`) and clears any already-exported `HAPPY_STACKS_*` / `HAPPY_LOCAL_*` variables so the stack env stays authoritative.

## JSON mode

For programmatic usage:

```bash
pnpm stack list --json
pnpm stack new exp3 --json
pnpm stack edit exp3 --interactive --json
```

