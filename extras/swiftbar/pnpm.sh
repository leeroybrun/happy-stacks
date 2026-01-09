#!/bin/bash
set -euo pipefail

# Run pnpm from the happy-local repo root (fixes SwiftBar running in $HOME).
#
# SwiftBar can sometimes execute menu actions with cwd=$HOME; this wrapper guarantees:
# - cwd is the repo root
# - pnpm resolution prefers repo-local node_modules/.bin first

HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HOME/Documents/Development/happy-local}"

# If env points somewhere stale, prefer the repo root relative to this script.
if [[ ! -f "$HAPPY_LOCAL_DIR/package.json" ]]; then
  script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  repo_root="$(cd "$script_dir/../.." && pwd)"
  if [[ -f "$repo_root/package.json" ]]; then
    HAPPY_LOCAL_DIR="$repo_root"
  fi
fi

if [[ ! -f "$HAPPY_LOCAL_DIR/package.json" ]]; then
  echo "happy-local not found at: $HAPPY_LOCAL_DIR" >&2
  exit 1
fi

PNPM_BIN="$HAPPY_LOCAL_DIR/node_modules/.bin/pnpm"
if [[ ! -x "$PNPM_BIN" ]]; then
  PNPM_BIN="$(command -v pnpm 2>/dev/null || true)"
fi

if [[ -z "$PNPM_BIN" ]]; then
  echo "pnpm not found" >&2
  exit 1
fi

cd "$HAPPY_LOCAL_DIR"

cmd="${1:-}"
if [[ -z "$cmd" ]]; then
  exec "$PNPM_BIN"
fi

# pnpm only exposes a few lifecycle scripts as top-level commands (start/test/etc).
# For custom scripts like `srv`, `wt`, `stack`, we must use `pnpm run <script> -- ...`.
if [[ "$cmd" != "run" && "$cmd" != "-r" && "$cmd" != "--recursive" ]]; then
  if node -e 'const p=require("./package.json"); const s=p.scripts||{}; process.exit(Object.prototype.hasOwnProperty.call(s, process.argv[1])?0:1)' "$cmd" 2>/dev/null; then
    # If caller already included a `--` (common pattern), drop it to avoid double separators.
    if [[ "${2:-}" == "--" ]]; then
      shift 2
    else
      shift 1
    fi
    exec "$PNPM_BIN" run "$cmd" -- "$@"
  fi
fi

exec "$PNPM_BIN" "$@"

