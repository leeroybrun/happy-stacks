#!/bin/bash
set -euo pipefail

# Back-compat wrapper for SwiftBar menu actions.
# Historically this executed `pnpm` in the cloned repo; it now executes `happys`.

HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HAPPY_STACKS_HOME_DIR}"

HAPPYS_BIN="$HAPPY_LOCAL_DIR/bin/happys"
if [[ ! -x "$HAPPYS_BIN" ]]; then
  HAPPYS_BIN="$(command -v happys 2>/dev/null || true)"
fi

if [[ -z "${HAPPYS_BIN:-}" ]]; then
  echo "happys not found (run: npx happy-stacks init, or npm i -g happy-stacks)" >&2
  exit 1
fi

exec "$HAPPYS_BIN" "$@"

