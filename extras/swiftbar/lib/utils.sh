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
  local home="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"

  # If user provided a valid directory, keep it.
  if [[ -n "${HAPPY_LOCAL_DIR:-}" ]] && [[ -f "$HAPPY_LOCAL_DIR/extras/swiftbar/lib/utils.sh" ]]; then
    echo "$HAPPY_LOCAL_DIR"
    return
  fi

  # Canonical install location.
  if [[ -f "$home/extras/swiftbar/lib/utils.sh" ]]; then
    echo "$home"
    return
  fi

  # Fall back to home even if missing so the menu can show actionable errors.
  echo "$home"
}

resolve_pnpm_bin() {
  # Back-compat: historically this was "pnpm", but the plugin now runs `happys` via a wrapper script.
  local wrapper="$HAPPY_LOCAL_DIR/extras/swiftbar/pnpm.sh"
  if [[ -x "$wrapper" ]]; then
    echo "$wrapper"
    return
  fi

  local global_happys
  global_happys="$(command -v happys 2>/dev/null || true)"
  if [[ -n "$global_happys" ]]; then
    echo "$global_happys"
    return
  fi

  echo ""
}

resolve_workspace_dir() {
  if [[ -n "${HAPPY_STACKS_WORKSPACE_DIR:-}" ]]; then
    echo "$HAPPY_STACKS_WORKSPACE_DIR"
    return
  fi
  local p
  p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_WORKSPACE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_WORKSPACE_DIR")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi
  echo "$HAPPY_LOCAL_DIR/workspace"
}

resolve_components_dir() {
  echo "$(resolve_workspace_dir)/components"
}

resolve_main_env_file() {
  local explicit="${HAPPY_STACKS_ENV_FILE:-${HAPPY_LOCAL_ENV_FILE:-}}"
  if [[ -n "$explicit" ]] && [[ -f "$explicit" ]]; then
    echo "$explicit"
    return
  fi
  local main="$HOME/.happy/stacks/main/env"
  if [[ -f "$main" ]]; then
    echo "$main"
    return
  fi
  echo ""
}

resolve_main_port() {
  # Priority:
  # 1) explicit env var
  # 2) main stack env (~/.happy/stacks/main/env)
  # 3) home env.local
  # 4) home .env
  # 4) fallback to HAPPY_LOCAL_PORT / 3005
  if [[ -n "${HAPPY_LOCAL_SERVER_PORT:-}" ]]; then
    echo "$HAPPY_LOCAL_SERVER_PORT"
    return
  fi
  if [[ -n "${HAPPY_STACKS_SERVER_PORT:-}" ]]; then
    echo "$HAPPY_STACKS_SERVER_PORT"
    return
  fi

  local p
  local env_file
  env_file="$(resolve_main_env_file)"
  if [[ -n "$env_file" ]]; then
    p="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_PORT")"
    [[ -z "$p" ]] && p="$(dotenv_get "$env_file" "HAPPY_STACKS_SERVER_PORT")"
  fi
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_SERVER_PORT")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_SERVER_PORT")"
  if [[ -n "$p" ]]; then
    echo "$p"
    return
  fi

  p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_SERVER_PORT")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_SERVER_PORT")"
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
  if [[ -n "${HAPPY_STACKS_SERVER_COMPONENT:-}" ]]; then
    echo "$HAPPY_STACKS_SERVER_COMPONENT"
    return
  fi

  local c
  local env_file
  env_file="$(resolve_main_env_file)"
  if [[ -n "$env_file" ]]; then
    c="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_COMPONENT")"
    [[ -z "$c" ]] && c="$(dotenv_get "$env_file" "HAPPY_STACKS_SERVER_COMPONENT")"
  fi
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi

  c="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_SERVER_COMPONENT")"
  [[ -z "$c" ]] && c="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_SERVER_COMPONENT")"
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi

  c="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_SERVER_COMPONENT")"
  [[ -z "$c" ]] && c="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_SERVER_COMPONENT")"
  if [[ -n "$c" ]]; then
    echo "$c"
    return
  fi

  echo "happy-server-light"
}
