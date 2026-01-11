#!/bin/bash
set -euo pipefail

# Back-compat wrapper for SwiftBar menu actions.
# Historically this executed `pnpm`; now it delegates to `happys.sh`.

HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HAPPY_STACKS_HOME_DIR}"

exec "$HAPPY_LOCAL_DIR/extras/swiftbar/happys.sh" "$@"
