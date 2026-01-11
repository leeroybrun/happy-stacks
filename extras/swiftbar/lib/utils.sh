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

expand_home_path() {
  local p="$1"
  if [[ "$p" == "~/"* ]]; then
    echo "$HOME/${p#~/}"
    return
  fi
  echo "$p"
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

resolve_stacks_storage_root() {
  # Priority:
  # 1) explicit env var
  # 2) home env.local
  # 3) home .env (canonical pointer file, written by `happys init`)
  # 4) default to ~/.happy/stacks
  if [[ -n "${HAPPY_STACKS_STORAGE_DIR:-}" ]]; then
    echo "$(expand_home_path "$HAPPY_STACKS_STORAGE_DIR")"
    return
  fi
  if [[ -n "${HAPPY_LOCAL_STORAGE_DIR:-}" ]]; then
    echo "$(expand_home_path "$HAPPY_LOCAL_STORAGE_DIR")"
    return
  fi

  local p
  p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_STACKS_STORAGE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "HAPPY_LOCAL_STORAGE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_STACKS_STORAGE_DIR")"
  [[ -z "$p" ]] && p="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "HAPPY_LOCAL_STORAGE_DIR")"
  if [[ -n "$p" ]]; then
    echo "$(expand_home_path "$p")"
    return
  fi

  echo "$HOME/.happy/stacks"
}

resolve_stack_env_file() {
  local stack_name="${1:-main}"
  local storage_root
  storage_root="$(resolve_stacks_storage_root)"

  local primary="${storage_root}/${stack_name}/env"
  if [[ -f "$primary" ]]; then
    echo "$primary"
    return
  fi

  local legacy="$HOME/.happy/local/stacks/${stack_name}/env"
  if [[ -f "$legacy" ]]; then
    echo "$legacy"
    return
  fi

  # Very old single-stack location (best-effort).
  if [[ "$stack_name" == "main" ]]; then
    local legacy_single="$HOME/.happy/local/env"
    if [[ -f "$legacy_single" ]]; then
      echo "$legacy_single"
      return
    fi
  fi

  echo "$primary"
}

resolve_stack_base_dir() {
  local stack_name="${1:-main}"
  local env_file="${2:-}"
  if [[ -z "$env_file" ]]; then
    env_file="$(resolve_stack_env_file "$stack_name")"
  fi
  # If the env file exists, its parent directory is the stack base dir for all supported layouts.
  if [[ -n "$env_file" ]] && [[ -f "$env_file" ]]; then
    dirname "$env_file"
    return
  fi
  local storage_root
  storage_root="$(resolve_stacks_storage_root)"
  echo "${storage_root}/${stack_name}"
}

resolve_stack_cli_home_dir() {
  local stack_name="${1:-main}"
  local env_file="${2:-}"
  if [[ -z "$env_file" ]]; then
    env_file="$(resolve_stack_env_file "$stack_name")"
  fi
  local cli_home=""
  if [[ -n "$env_file" ]] && [[ -f "$env_file" ]]; then
    cli_home="$(dotenv_get "$env_file" "HAPPY_STACKS_CLI_HOME_DIR")"
    [[ -z "$cli_home" ]] && cli_home="$(dotenv_get "$env_file" "HAPPY_LOCAL_CLI_HOME_DIR")"
  fi
  if [[ -n "$cli_home" ]]; then
    echo "$(expand_home_path "$cli_home")"
    return
  fi
  local base_dir
  base_dir="$(resolve_stack_base_dir "$stack_name" "$env_file")"
  echo "${base_dir}/cli"
}

resolve_stack_label() {
  local stack_name="${1:-main}"
  local primary="com.happy.stacks"
  local legacy="com.happy.local"
  if [[ "$stack_name" != "main" ]]; then
    primary="com.happy.stacks.${stack_name}"
    legacy="com.happy.local.${stack_name}"
  fi
  local primary_plist="$HOME/Library/LaunchAgents/${primary}.plist"
  local legacy_plist="$HOME/Library/LaunchAgents/${legacy}.plist"
  if [[ -f "$primary_plist" ]]; then
    echo "$primary"
    return
  fi
  if [[ -f "$legacy_plist" ]]; then
    echo "$legacy"
    return
  fi
  echo "$primary"
}

resolve_pnpm_bin() {
  # Back-compat: historically this was "pnpm", but the plugin now runs `happys` via wrapper scripts.
  local wrapper="$HAPPY_LOCAL_DIR/extras/swiftbar/happys.sh"
  if [[ -x "$wrapper" ]]; then
    echo "$wrapper"
    return
  fi

  # Older installs.
  wrapper="$HAPPY_LOCAL_DIR/extras/swiftbar/pnpm.sh"
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

resolve_node_bin() {
  # Prefer explicit env vars first.
  if [[ -n "${HAPPY_STACKS_NODE:-}" ]] && [[ -x "${HAPPY_STACKS_NODE:-}" ]]; then
    echo "$HAPPY_STACKS_NODE"
    return
  fi
  if [[ -n "${HAPPY_LOCAL_NODE:-}" ]] && [[ -x "${HAPPY_LOCAL_NODE:-}" ]]; then
    echo "$HAPPY_LOCAL_NODE"
    return
  fi

  # Fall back to reading ~/.happy-stacks/.env (written by `happys init`).
  local home="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"
  local env_file="$home/.env"
  if [[ -f "$env_file" ]]; then
    local v
    v="$(dotenv_get "$env_file" "HAPPY_STACKS_NODE")"
    if [[ -n "$v" ]] && [[ -x "$v" ]]; then
      echo "$v"
      return
    fi
    v="$(dotenv_get "$env_file" "HAPPY_LOCAL_NODE")"
    if [[ -n "$v" ]] && [[ -x "$v" ]]; then
      echo "$v"
      return
    fi
  fi

  command -v node 2>/dev/null || true
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

  local storage_root
  storage_root="$(resolve_stacks_storage_root)"
  local main="$storage_root/main/env"
  if [[ -f "$main" ]]; then
    echo "$main"
    return
  fi
  # Legacy stacks location (pre-migration).
  local legacy="$HOME/.happy/local/stacks/main/env"
  if [[ -f "$legacy" ]]; then
    echo "$legacy"
    return
  fi
  # Very old single-stack location (best-effort).
  local legacy_single="$HOME/.happy/local/env"
  if [[ -f "$legacy_single" ]]; then
    echo "$legacy_single"
    return
  fi
  echo ""
}

resolve_main_port() {
  # Priority:
  # 1) explicit env var
  # 2) main stack env
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
