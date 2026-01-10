# Agent / Contributor Guide (happy-stacks)

It is designed for:

- running the **Happy** stack fully on your own machine (server + UI + CLI/daemon)
- securely accessing it remotely (recommended: **Tailscale Serve** for HTTPS secure context)
- developing on Happy across multiple repos using **worktrees**
- running multiple isolated instances via **stacks**
- maintaining a **patched fork** while still producing **clean upstream PRs**

If you are an LLM agent: treat this file as the “ground truth” for workflows, naming, and commands.

---

### Big picture (what lives where)

#### **This repo**

- `scripts/*.mjs`: orchestration CLIs (bootstrapping, run/dev/build, worktrees, stacks, service, tailscale).
- `components/*`: cloned component repos (each is its own Git repo).
- `components/.worktrees/*`: all worktrees (keeps `components/*` “clean”).

#### **Happy components**

The main components managed by happy-stacks:

- `happy` (UI)
- `happy-cli` (CLI + daemon)
- `happy-server-light` (lightweight server)
- `happy-server` (full server)

---

### Critical invariants / expectations

#### **Stay upstream-compatible**

- Your changes in our forks should stay compatible with upstream (`slopus/*`).
- Avoid “fork-only hacks” that permanently diverge unless explicitly intended.
- Prefer feature flags, clean commits, and PR-ready changes.

#### **Document fork additions**

When you add a feature/fix/infra change in any fork under `components/*`:

- Update that component’s **README** (top “Fork additions” section).
- Include a short bullet describing the change.
- If there’s an upstream PR (opened or merged), include an inline link to it (e.g. `slopus/<repo>#123`).
  - If it’s not upstreamed yet, link to the fork PR/branch instead.

#### **Our fork’s `main` is a “distribution” branch**

We maintain fork-specific changes so people can use our fork directly.

#### **Upstream PRs must be clean**

When contributing back to upstream:

- base PR branches on upstream `main` (or the appropriate upstream base)
- do not include fork-only patches in upstream PR branches

The tooling below exists so you don’t have to manually re-copy changes between branches.

---

### Git remotes + naming conventions

#### **Remotes**

Each component repo under `components/<component>` should typically have:

- `origin`: our fork (often `leeroybrun/*`)
- `upstream`: upstream repo (often `slopus/*`)

#### **Branch naming**

Branches created/managed by worktree tooling are owner-prefixed:

```
<owner>/<branch...>
```

Examples:

- `leeroybrun/local/my-patch` (fork-only)
- `slopus/pr/123-fix-thing` (upstream PR branch)

---

### Worktrees (how we do parallel PR work safely)

#### **Layout**

All worktrees live under:

```
components/.worktrees/<component>/<owner>/<branch...>
```

Examples:

- `components/.worktrees/happy/slopus/pr/123-fix-thing`
- `components/.worktrees/happy-cli/leeroybrun/local/my-patch`

#### **Active component selection**

Happy-stacks runs components from `components/<component>` by default.
You can override per component via env vars (prefer `HAPPY_STACKS_*`):

- `HAPPY_STACKS_COMPONENT_DIR_HAPPY`
- `HAPPY_STACKS_COMPONENT_DIR_HAPPY_CLI`
- `HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER_LIGHT`
- `HAPPY_STACKS_COMPONENT_DIR_HAPPY_SERVER`

Legacy aliases still work:

- `HAPPY_LOCAL_COMPONENT_DIR_*`

Use `happys wt use ...` instead of editing env files by hand. (Legacy in a cloned repo: `pnpm wt use ...`.)

---

### Stacks (multiple isolated “instances”)

A “stack” is an isolated set of:

- server port
- UI build dir
- CLI home dir
- optional component directory overrides (pointing at worktrees)

#### **Storage layout**

New canonical storage root:

```
~/.happy/stacks/<name>/...
```

Stack env file:

```
~/.happy/stacks/<name>/env
```

Legacy stack env files are still supported:

```
~/.happy/local/stacks/<name>/env
```

To migrate legacy stack env files:

```bash
happys stack migrate
```

---

### Environment loading + precedence (important)

Scripts load environment in this order:

1. `~/.happy-stacks/.env` (lowest precedence; created by `happys init`)
2. `~/.happy-stacks/env.local`
3. stack env file (highest precedence) via `HAPPY_STACKS_ENV_FILE` (legacy: `HAPPY_LOCAL_ENV_FILE`)

Backwards compatible fallback for cloned-repo usage (when home config doesn’t exist yet):

1. repo `.env` (lowest precedence)
2. repo `env.local`
3. stack env file (highest precedence)

#### **Prefix migration**

Canonical prefix: `HAPPY_STACKS_*`
Legacy prefix: `HAPPY_LOCAL_*`

The loader maps both ways so either prefix works, but new configuration should use `HAPPY_STACKS_*`.

---

### The only commands you should use (cheat sheet)

#### **Install / init (recommended)**

No repo clone required:

```bash
npx happy-stacks init
export PATH="$HOME/.happy-stacks/bin:$PATH"
```

#### **Bootstrap / setup**

Clone missing components, install deps, build/link wrappers, optional autostart:

```bash
happys bootstrap
happys bootstrap --interactive
```

Pick upstream clone source explicitly:

```bash
happys bootstrap --forks
happys bootstrap --upstream
```

#### **Run**

Production-like (serves built UI via server-light):

```bash
happys start
```

Dev mode (Expo web dev server for UI):

```bash
happys dev
```

#### **Server flavor**

We support `happy-server-light` and `happy-server` (not simultaneously for one run).

```bash
happys srv status
happys srv use happy-server-light
happys srv use happy-server
happys srv use --interactive
```

Note: in a cloned repo, `pnpm srv -- ...` still works (legacy).

#### **Worktrees**

Key commands:

```bash
happys wt migrate
happys wt use --interactive
happys wt new --interactive
happys wt list happy
happys wt status happy
happys wt sync-all
happys wt update-all --dry-run
happys wt update-all --stash
happys wt git happy active -- status
happys wt shell happy slopus/pr/123-fix-thing
happys wt code happy slopus/pr/123-fix-thing
happys wt cursor happy slopus/pr/123-fix-thing
```

Create a worktree for an upstream PR:

```bash
happys wt pr happy https://github.com/slopus/happy/pull/123 --use
```

Update a PR worktree when new commits are pushed:

- `--update` fast-forwards only
- if not possible, it aborts and tells you to use `--force`
- use `--stash` to auto-stash local modifications before updating

```bash
happys wt pr happy 123 --update
happys wt pr happy 123 --update --stash
happys wt pr happy 123 --update --force
```

#### **Stacks**

Create and run additional isolated stacks:

```bash
happys stack new exp1 --interactive
happys stack dev exp1
happys stack start exp1
happys stack edit exp1 --interactive
happys stack list
```

Run worktree tooling scoped to a stack env file:

```bash
happys stack wt exp1 -- use --interactive
happys stack wt exp1 -- status happy
```

Switch server flavor for a stack:

```bash
happys stack srv exp1 -- use --interactive
```

---

### Common workflows (copy/paste)

These are the most common flows we expect agents to follow. Prefer these over ad-hoc git worktree/env edits.

#### **1) Create a clean upstream PR worktree (based on `upstream/main`)**

Example: you want to propose a change to upstream `slopus/happy`.

```bash
# Create a new worktree branch based on upstream.
happys wt new happy pr/my-feature --from=upstream --use

# (optional) open a shell/editor in that worktree
happys wt shell happy active
happys wt cursor happy active

# When done, push to upstream remote (or push to your fork and open PR to upstream)
happys wt push happy active --remote=upstream
```

Notes:
- This worktree lives under `components/.worktrees/happy/slopus/pr/my-feature` (owner inferred from `upstream`).
- Keep this branch clean: **only** the upstream-worthy change(s).

#### **2) Create a fork-only patch worktree (based on `origin/main`)**

Example: you want a change that stays in our fork distribution branch, not upstream.

```bash
happys wt new happy local/my-fork-only-patch --from=origin --use
happys wt push happy active --remote=origin
```

#### **3) Check out a GitHub PR as a worktree**

Example: you want to review/test a PR locally without mixing it into other work.

```bash
# Create from PR URL (recommended)
happys wt pr happy https://github.com/slopus/happy/pull/123 --use

# Update later when new commits land on the PR:
happys wt pr happy 123 --update

# If the worktree is dirty:
happys wt pr happy 123 --update --stash

# If the PR was force-pushed and FF-only fails:
happys wt pr happy 123 --update --force
```

#### **4) Switch what the launcher runs (“activate” a worktree)**

Example: you have multiple worktrees and want `happys dev/start/build` to use one of them.

```bash
happys wt use happy slopus/pr/123-fix-thing
happys wt use happy-cli default
happys wt use happy-server-light default
```

Reset back to defaults:

```bash
happys wt use happy default
happys wt use happy-cli default
happys wt use happy-server-light default
```

#### **5) Create a new stack (isolated env + ports + dirs)**

Interactive (recommended):

```bash
happys stack new exp1 --interactive
happys stack dev exp1
```

Non-interactive:

```bash
happys stack new exp2 --port=3010 --server=happy-server-light
happys stack start exp2
```

#### **6) Test a PR inside a stack (recommended for parallel work)**

Example: keep your “main” stack stable, test PRs in `exp1`.

```bash
# Create/update PR worktree
happys wt pr happy 123 --use

# Point exp1 at that worktree (stack-scoped; does NOT touch env.local)
happys stack wt exp1 -- use happy slopus/pr/123-fix-thing

# Run the stack
happys stack dev exp1
```

#### **7) Update everything (sync mirror branches + update active worktrees)**

```bash
# Ensure slopus/main (mirror) is up to date across components
happys wt sync-all

# Preview updates across components
happys wt update-all --dry-run

# Apply updates (auto-stash if needed)
happys wt update-all --stash
```

---

### How to contribute upstream without breaking our fork

#### **Preferred workflow**

- Keep our fork’s `main` as the day-to-day distribution branch.
- For upstream PRs, use **worktrees** so you get clean branches based on upstream:
  - create PR worktree with `happys wt pr ...`
  - or create a new branch from upstream with `happys wt new ... --from=upstream`

#### **When upstream merges a change you also carried locally**

Git reconciles changes based on content/patches, not commit IDs. If the same lines land upstream, your branch update typically becomes a fast-forward or a small/no-op merge/rebase. When it can’t cleanly reconcile (conflicts), use the worktree commands with `--stash` / `--force` to proceed intentionally.

---

### Special note: `happy-server` vs `happy-server-light`

Conceptually they are “two flavors of the same upstream server codebase”:

- upstream lives under the `slopus/happy-server` repo
- `happy-server-light` is a lightweight branch/flavor intended for local use

In happy-stacks we keep them as two separate components so you can switch easily:

- `components/happy-server-light`
- `components/happy-server`

Expectations:

- keep both compatible with upstream branches
- when you implement changes that should go upstream, do it in an upstream-based worktree (e.g. `slopus/pr/...`) and open a PR

---

### Autostart (macOS LaunchAgent)

- Each stack can have its own LaunchAgent.
- New label base: `com.happy.stacks` (legacy: `com.happy.local`).
- The service persists only the stack env file path, so you can edit stack settings without reinstalling.

Commands:

```bash
happys service install
happys service status
happys service tail
happys stack service:install exp1
happys stack service:status exp1
```

---

### SwiftBar menu bar plugin (optional)

- Installer: `happys menubar install`
- It supports stacks and worktrees, and uses the same terminal/shell preferences as `happys wt shell`.

---

### Agent guidelines (LLM-specific)

- **Don’t edit component repos in-place on `components/<component>` unless that’s the intended “main/default” checkout.**
  - Prefer creating a worktree for any change that should become a PR.
- **Always pick a target upstream** (usually `slopus`) and keep PR branches clean.
- **Use `happys wt` / `happys stack` commands instead of raw `git worktree` / manual env edits** whenever possible.
- **Respect env precedence**: stack env file overrides everything; don’t “hardcode” paths in scripts.
- **Avoid breaking changes** to env vars/paths; preserve legacy behavior when possible
