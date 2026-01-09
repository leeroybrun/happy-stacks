#!/bin/bash
set -euo pipefail

# Usage:
#   ./set-server-flavor.sh main|<stackName> happy-server|happy-server-light
#
# For main:
#   - updates env.local via `pnpm srv -- use ...`
#   - restarts the LaunchAgent service if installed (best-effort)
#
# For stacks:
#   - updates the stack env via `pnpm stack srv <name> -- use ...`
#   - restarts the stack LaunchAgent service if installed (best-effort)

STACK="${1:-}"
FLAVOR="${2:-}"

if [[ -z "$STACK" ]] || [[ -z "$FLAVOR" ]]; then
  echo "usage: $0 <main|stackName> <happy-server|happy-server-light>" >&2
  exit 2
fi
if [[ "$FLAVOR" != "happy-server" && "$FLAVOR" != "happy-server-light" ]]; then
  echo "invalid flavor: $FLAVOR" >&2
  exit 2
fi

if [[ ! -f "package.json" ]]; then
  echo "run from happy-local root (SwiftBar sets dir=HAPPY_LOCAL_DIR)" >&2
  exit 2
fi

PNPM_BIN="./extras/swiftbar/pnpm.sh"
if [[ ! -x "$PNPM_BIN" ]]; then
  PNPM_BIN="$(command -v pnpm || true)"
  LOCAL_PNPM="./node_modules/.bin/pnpm"
  if [[ -x "$LOCAL_PNPM" ]]; then
    PNPM_BIN="$LOCAL_PNPM"
  fi
fi
if [[ -z "$PNPM_BIN" ]]; then
  echo "pnpm not found" >&2
  exit 1
fi

restart_main_service_if_present() {
  if [[ -f "$HOME/Library/LaunchAgents/com.happy.local.plist" ]]; then
    "$PNPM_BIN" service:restart >/dev/null 2>&1 || true
  fi
}

restart_stack_service_if_present() {
  local name="$1"
  local label="com.happy.local.${name}"
  if [[ -f "$HOME/Library/LaunchAgents/${label}.plist" ]]; then
    "$PNPM_BIN" stack service:restart "$name" >/dev/null 2>&1 || true
  fi
}

if [[ "$STACK" == "main" ]]; then
  "$PNPM_BIN" srv -- use "$FLAVOR"
  restart_main_service_if_present
  echo "ok: main -> $FLAVOR"
  exit 0
fi

"$PNPM_BIN" stack srv "$STACK" -- use "$FLAVOR"
restart_stack_service_if_present "$STACK"
echo "ok: $STACK -> $FLAVOR"

