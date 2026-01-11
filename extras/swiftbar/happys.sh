#!/bin/bash
set -euo pipefail

# SwiftBar menu action wrapper.
# Runs `happys` using the stable shim installed under ~/.happy-stacks/bin.

CANONICAL_ENV_FILE="$HOME/.happy-stacks/.env"

dotenv_get_quick() {
  local file="$1"
  local key="$2"
  [[ -n "$file" && -n "$key" && -f "$file" ]] || return 0
  local line
  line="$(grep -E "^${key}=" "$file" 2>/dev/null | head -n 1 || true)"
  [[ -n "$line" ]] || return 0
  local v="${line#*=}"
  v="${v%$'\r'}"
  if [[ "$v" == \"*\" && "$v" == *\" ]]; then v="${v#\"}"; v="${v%\"}"; fi
  if [[ "$v" == \'*\' && "$v" == *\' ]]; then v="${v#\'}"; v="${v%\'}"; fi
  echo "$v"
}

expand_home_quick() {
  local p="$1"
  if [[ "$p" == "~/"* ]]; then
    echo "$HOME/${p#~/}"
  else
    echo "$p"
  fi
}

home_from_canonical=""
if [[ -f "$CANONICAL_ENV_FILE" ]]; then
  home_from_canonical="$(dotenv_get_quick "$CANONICAL_ENV_FILE" "HAPPY_STACKS_HOME_DIR")"
  [[ -z "$home_from_canonical" ]] && home_from_canonical="$(dotenv_get_quick "$CANONICAL_ENV_FILE" "HAPPY_LOCAL_HOME_DIR")"
fi
home_from_canonical="$(expand_home_quick "${home_from_canonical:-}")"

HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-${home_from_canonical:-$HOME/.happy-stacks}}"
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
