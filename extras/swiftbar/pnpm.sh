#!/bin/bash
set -euo pipefail

# Run pnpm from the happy-local repo root (fixes SwiftBar running in $HOME).
#
# SwiftBar can sometimes execute menu actions with cwd=$HOME; this wrapper guarantees:
# - cwd is the repo root
# - pnpm resolution prefers repo-local node_modules/.bin first

HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HOME/Documents/Development/happy-local}"

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
exec "$PNPM_BIN" "$@"

