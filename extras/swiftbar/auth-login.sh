#!/bin/bash
set -euo pipefail

# Run auth login (interactive) in the user's preferred terminal.
#
# Usage (backwards compatible with older callers):
#   ./auth-login.sh main <serverUrl> <webappUrl>
#   ./auth-login.sh <stackName> <serverUrl> <webappUrl> <cliHomeDir>
#
# New behavior:
# - Delegate to `happys auth login` / `happys stack auth <name> login` so URL + cliHome resolution stays centralized.

stack="${1:-main}"
_server_url="${2:-}"   # ignored (kept for backwards compatibility)
_webapp_url="${3:-}"   # ignored (kept for backwards compatibility)
_cli_home_dir="${4:-}" # ignored (kept for backwards compatibility)

HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HAPPY_STACKS_HOME_DIR}"

PNPM_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/pnpm-term.sh"
if [[ ! -x "$PNPM_TERM" ]]; then
  echo "missing terminal happys wrapper: $PNPM_TERM" >&2
  exit 1
fi

if [[ "$stack" == "main" ]]; then
  exec "$PNPM_TERM" auth login
fi

exec "$PNPM_TERM" stack auth "$stack" login
