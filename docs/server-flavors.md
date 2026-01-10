# Server flavors: `happy-server-light` vs `happy-server`

Happy Stacks supports two server “flavors”. You can switch between them globally (main stack) or per stack.

## What’s the difference?

Both are forks/flavors of the same upstream server repo (`slopus/happy-server`), but optimized for different use cases:

- **`happy-server-light`** (recommended default)
  - optimized for local usage
  - can **serve the built web UI** (so `happys start` works end-to-end without a separate web server)
  - usually the best choice when you just want a stable “main” stack on your machine

- **`happy-server`** (full server)
  - closer to upstream “full” behavior (useful when developing server changes meant to go upstream)
  - typically does **not** serve the built UI (you’ll use the UI dev server or connect the UI separately)
  - useful when you need to test upstream/server-only behavior or reproduce upstream issues

Important: for a given run (`happys start` / `happys dev`) you choose **one** flavor.

## How to switch (main stack)

Use the `srv` helper (persisted in `env.local`):

```bash
happys srv status
happys srv use happy-server-light
happys srv use happy-server
happys srv use --interactive
```

This persists `HAPPY_STACKS_SERVER_COMPONENT` (and also writes the legacy alias `HAPPY_LOCAL_SERVER_COMPONENT` for compatibility).

## How to switch for a specific stack

Use the stack wrapper:

```bash
happys stack srv exp1 -- status
happys stack srv exp1 -- use happy-server-light
happys stack srv exp1 -- use happy-server
happys stack srv exp1 -- use --interactive
```

This updates the stack env file (typically `~/.happy/stacks/<name>/env`).

## One-off overrides (do not persist)

You can override the server flavor for a single run:

```bash
happys start --server=happy-server-light
happys start --server=happy-server

happys dev --server=happy-server-light
happys dev --server=happy-server
```

## Setup note (cloning both)

If you want both component repos present under `components/`:

```bash
happys bootstrap --server=both
```
