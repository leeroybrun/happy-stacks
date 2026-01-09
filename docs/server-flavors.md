# Server flavors: `happy-server-light` vs `happy-server`

Happy Stacks supports two server “flavors”. You can switch between them globally (main stack) or per stack.

## What’s the difference?

Both are forks/flavors of the same upstream server repo (`slopus/happy-server`), but optimized for different use cases:

- **`happy-server-light`** (recommended default)
  - optimized for local usage
  - can **serve the built web UI** (so `pnpm start` works end-to-end without a separate web server)
  - usually the best choice when you just want a stable “main” stack on your machine

- **`happy-server`** (full server)
  - closer to upstream “full” behavior (useful when developing server changes meant to go upstream)
  - typically does **not** serve the built UI (you’ll use the UI dev server or connect the UI separately)
  - useful when you need to test upstream/server-only behavior or reproduce upstream issues

Important: for a given run (`pnpm start` / `pnpm dev`) you choose **one** flavor.

## How to switch (main stack)

Use the `srv` helper (persisted in `env.local`):

```bash
pnpm srv -- status
pnpm srv -- use happy-server-light
pnpm srv -- use happy-server
pnpm srv -- use --interactive
```

This persists `HAPPY_STACKS_SERVER_COMPONENT` (and also writes the legacy alias `HAPPY_LOCAL_SERVER_COMPONENT` for compatibility).

## How to switch for a specific stack

Use the stack wrapper:

```bash
pnpm stack srv exp1 -- status
pnpm stack srv exp1 -- use happy-server-light
pnpm stack srv exp1 -- use happy-server
pnpm stack srv exp1 -- use --interactive
```

This updates the stack env file (typically `~/.happy/stacks/<name>/env`).

## One-off overrides (do not persist)

You can override the server flavor for a single run:

```bash
pnpm start -- --server=happy-server-light
pnpm start -- --server=happy-server

pnpm dev -- --server=happy-server-light
pnpm dev -- --server=happy-server
```

## Setup note (cloning both)

If you want both component repos present under `components/`:

```bash
pnpm bootstrap -- --server=both
```

