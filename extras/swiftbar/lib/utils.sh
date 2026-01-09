#!/bin/bash

shorten_text() {
  local s="$1"
  local max="${2:-44}"
  if [[ ${#s} -le $max ]]; then
    echo "$s"
    return
  fi
  echo "${s:0:$((max - 3))}..."
}

shorten_path() {
  local p="$1"
  local max="${2:-44}"
  local pretty="${p/#$HOME/~}"
  shorten_text "$pretty" "$max"
}

dotenv_get() {
  # Usage: dotenv_get /path/to/env KEY
  # Notes:
  # - ignores blank lines and comments
  # - does not expand variables
  # - strips simple surrounding quotes
  local file="$1"
  local key="$2"
  if [[ -z "$file" ]] || [[ -z "$key" ]] || [[ ! -f "$file" ]]; then
    return
  fi
  awk -v k="$key" '
    BEGIN { FS="=" }
    /^[[:space:]]*$/ { next }
    /^[[:space:]]*#/ { next }
    {
      kk=$1
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", kk)
      if (kk != k) next

      vv=$0
      sub(/^[^=]*=/, "", vv)
      gsub(/^[[:space:]]+|[[:space:]]+$/, "", vv)

      if (vv ~ /^".*"$/) { sub(/^"/, "", vv); sub(/"$/, "", vv) }
      if (vv ~ /^'\''.*'\''$/) { sub(/^'\''/, "", vv); sub(/'\''$/, "", vv) }

      print vv
      exit
    }
  ' "$file" 2>/dev/null
}

resolve_happy_local_dir() {
  # If user provided a valid directory, keep it.
  if [[ -n "${HAPPY_LOCAL_DIR:-}" ]] && [[ -f "$HAPPY_LOCAL_DIR/scripts/run.mjs" ]]; then
    echo "$HAPPY_LOCAL_DIR"
    return
  fi

  # Common locations.
  local candidates=(
    "$HOME/Documents/Development/happy-stacks"
    "$HOME/Development/happy-stacks"
    "$HOME/Documents/Development/happy-local"
    "$HOME/Development/happy-local"
  )

  for dir in "${candidates[@]}"; do
    if [[ -f "$dir/scripts/run.mjs" ]]; then
      echo "$dir"
      return
    fi
  done

  # Fall back to whatever was set (even if missing) so status can still show.
  echo "$HAPPY_LOCAL_DIR"
}

resolve_pnpm_bin() {
  # Prefer the SwiftBar wrapper which guarantees cwd=repo root.
  local swiftbar_pnpm="$HAPPY_LOCAL_DIR/extras/swiftbar/pnpm.sh"
  if [[ -x "$swiftbar_pnpm" ]]; then
    echo "$swiftbar_pnpm"
    return
  fi

  local local_pnpm="$HAPPY_LOCAL_DIR/node_modules/.bin/pnpm"
  if [[ -x "$local_pnpm" ]]; then
    echo "$local_pnpm"
    return
  fi

  local global_pnpm
  global_pnpm="$(command -v pnpm 2>/dev/null || true)"
  if [[ -n "$global_pnpm" ]]; then
    echo "$global_pnpm"
    return
  fi

  echo ""
}

resolve_main_port() {
  # Priority:
  # 1) explicit env var
  # 2) env.local
  # 3) .env
  # 4) fallback to HAPPY_LOCAL_PORT / 3005
  if [[ -n "${HAPPY_LOCAL_SERVER_PORT:-}" ]]; then
    echo "$HAPPY_LOCAL_SERVER_PORT"
    return
  fi
  local p
  p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_SERVER_PORT")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi
  p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_SERVER_PORT")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi
  echo "${HAPPY_LOCAL_PORT:-3005}"
}

resolve_main_server_component() {
  if [[ -n "${HAPPY_LOCAL_SERVER_COMPONENT:-}" ]]; then
    echo "$HAPPY_LOCAL_SERVER_COMPONENT"
    return
  fi
  local c
  c="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_SERVER_COMPONENT")"
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi
  c="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_SERVER_COMPONENT")"
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi
  echo "happy-server-light"
}

