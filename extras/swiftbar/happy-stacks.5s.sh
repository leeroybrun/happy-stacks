#!/bin/bash

# <xbar.title>Happy Stacks</xbar.title>
# <xbar.version>1.0.0</xbar.version>
# <xbar.author>Happy Stacks</xbar.author>
# <xbar.author.github>leeroybrun</xbar.author.github>
# <xbar.desc>Monitor and control your Happy stacks from the menu bar</xbar.desc>
# <xbar.dependencies>node</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>false</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
# <swiftbar.refreshOnOpen>false</swiftbar.refreshOnOpen>

# ============================================================================
# Configuration
# ============================================================================

HAPPY_STACKS_HOME_DIR="${HAPPY_STACKS_HOME_DIR:-$HOME/.happy-stacks}"
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HAPPY_STACKS_HOME_DIR}"
HAPPY_LOCAL_PORT="${HAPPY_LOCAL_PORT:-3005}"

# Map common preferences from HAPPY_STACKS_* -> HAPPY_LOCAL_* (SwiftBar scripts are shell-based).
if [[ -n "${HAPPY_STACKS_WT_TERMINAL:-}" && -z "${HAPPY_LOCAL_WT_TERMINAL:-}" ]]; then HAPPY_LOCAL_WT_TERMINAL="$HAPPY_STACKS_WT_TERMINAL"; fi
if [[ -n "${HAPPY_STACKS_WT_SHELL:-}" && -z "${HAPPY_LOCAL_WT_SHELL:-}" ]]; then HAPPY_LOCAL_WT_SHELL="$HAPPY_STACKS_WT_SHELL"; fi
if [[ -n "${HAPPY_STACKS_SWIFTBAR_ICON_PATH:-}" && -z "${HAPPY_LOCAL_SWIFTBAR_ICON_PATH:-}" ]]; then HAPPY_LOCAL_SWIFTBAR_ICON_PATH="$HAPPY_STACKS_SWIFTBAR_ICON_PATH"; fi

# Storage root migrated from ~/.happy/local -> ~/.happy/stacks/main.
if [[ -z "${HAPPY_HOME_DIR:-}" ]]; then
  if [[ -d "$HOME/.happy/stacks/main" ]] || [[ ! -d "$HOME/.happy/local" ]]; then
    HAPPY_HOME_DIR="$HOME/.happy/stacks/main"
  else
    HAPPY_HOME_DIR="$HOME/.happy/local"
  fi
fi
CLI_HOME_DIR="$HAPPY_HOME_DIR/cli"
LOGS_DIR="$HAPPY_HOME_DIR/logs"

# Colors
GREEN="#34C759"
RED="#FF3B30"
YELLOW="#FFCC00"
GRAY="#8E8E93"
BLUE="#007AFF"

# ============================================================================
# Load libs
# ============================================================================

LIB_DIR="$HAPPY_LOCAL_DIR/extras/swiftbar/lib"
if [[ ! -f "$LIB_DIR/utils.sh" ]]; then
  echo "Happy Stacks"
  echo "---"
  echo "SwiftBar libs missing at: $LIB_DIR"
  echo "↪ run: happys menubar install"
  exit 0
fi

# shellcheck source=/dev/null
source "$LIB_DIR/utils.sh"
HAPPY_LOCAL_DIR="$(resolve_happy_local_dir)"
LIB_DIR="$HAPPY_LOCAL_DIR/extras/swiftbar/lib"
# shellcheck source=/dev/null
source "$LIB_DIR/icons.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/system.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/git.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/render.sh"

# ============================================================================
# Menu
# ============================================================================

PNPM_BIN="$(resolve_pnpm_bin)"
MAIN_PORT="$(resolve_main_port)"
MAIN_SERVER_COMPONENT="$(resolve_main_server_component)"
TAILSCALE_URL="$(get_tailscale_url)"
MAIN_ENV_FILE="$(resolve_main_env_file)"

ensure_launchctl_cache

MAIN_COLLECT="$(collect_stack_status "$MAIN_PORT" "$CLI_HOME_DIR" "com.happy.stacks" "$HAPPY_HOME_DIR")"
IFS=$'\t' read -r MAIN_LEVEL MAIN_SERVER_STATUS MAIN_SERVER_PID MAIN_SERVER_METRICS MAIN_DAEMON_STATUS MAIN_DAEMON_PID MAIN_DAEMON_METRICS MAIN_DAEMON_UPTIME MAIN_LAST_HEARTBEAT MAIN_LAUNCHAGENT_STATUS MAIN_AUTOSTART_PID MAIN_AUTOSTART_METRICS <<<"$MAIN_COLLECT"
for v in MAIN_SERVER_PID MAIN_SERVER_METRICS MAIN_DAEMON_PID MAIN_DAEMON_METRICS MAIN_DAEMON_UPTIME MAIN_LAST_HEARTBEAT MAIN_AUTOSTART_PID MAIN_AUTOSTART_METRICS; do
  if [[ "${!v}" == "-" ]]; then
    printf -v "$v" '%s' ""
  fi
done

# Menu bar icon
MENU_STATUS_ICON_B64="$(status_icon_b64 "$MAIN_LEVEL" 18)"
if [[ -n "$MENU_STATUS_ICON_B64" ]]; then
  echo " | image=$MENU_STATUS_ICON_B64"
else
  STATUS_COLOR="$(color_for_level "$MAIN_LEVEL")"
  ICON_B64="$(get_menu_icon_b64)"
  if [[ -n "$ICON_B64" ]]; then
    echo "● | templateImage=$ICON_B64 color=$STATUS_COLOR"
  else
    echo "Happy"
  fi
fi

echo "---"
echo "Happy Stacks | size=14 font=SF Pro Display"
echo "---"

# Main stack (inline)
echo "Main stack"
echo "---"
export MAIN_LEVEL="$MAIN_LEVEL"
render_stack_info "" "main" "$MAIN_PORT" "$MAIN_SERVER_COMPONENT" "$HAPPY_HOME_DIR" "$CLI_HOME_DIR" "com.happy.stacks" "$MAIN_ENV_FILE" "$TAILSCALE_URL"
render_component_server "" "main" "$MAIN_PORT" "$MAIN_SERVER_COMPONENT" "$MAIN_SERVER_STATUS" "$MAIN_SERVER_PID" "$MAIN_SERVER_METRICS" "$TAILSCALE_URL" "com.happy.stacks"
render_component_daemon "" "$MAIN_DAEMON_STATUS" "$MAIN_DAEMON_PID" "$MAIN_DAEMON_METRICS" "$MAIN_DAEMON_UPTIME" "$MAIN_LAST_HEARTBEAT" "$CLI_HOME_DIR/daemon.state.json" "main"
render_component_autostart "" "main" "com.happy.stacks" "$MAIN_LAUNCHAGENT_STATUS" "$MAIN_AUTOSTART_PID" "$MAIN_AUTOSTART_METRICS" "$LOGS_DIR"
render_component_tailscale "" "main" "$TAILSCALE_URL"

echo "---"
echo "Stacks"
echo "---"

if [[ -n "$PNPM_BIN" ]]; then
  HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
  echo "New stack (interactive) | bash=$HAPPYS_TERM param1=stack param2=new param3=--interactive dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "List stacks | bash=$HAPPYS_TERM param1=stack param2=list dir=$HAPPY_LOCAL_DIR terminal=false"
  echo "---"
fi

STACKS_DIR="$HOME/.happy/stacks"
if [[ -d "$STACKS_DIR" ]]; then
  STACK_NAMES="$(ls -1 "$STACKS_DIR" 2>/dev/null || true)"
  if [[ -z "$STACK_NAMES" ]]; then
    echo "No stacks found | color=$GRAY"
  fi
  for s in $STACK_NAMES; do
    env_file="$STACKS_DIR/$s/env"
    [[ -f "$env_file" ]] || continue

    port="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_PORT")"
    [[ -n "$port" ]] || continue

    server_component="$(dotenv_get "$env_file" "HAPPY_LOCAL_SERVER_COMPONENT")"
    [[ -n "$server_component" ]] || server_component="happy-server-light"

    cli_home_dir="$(dotenv_get "$env_file" "HAPPY_LOCAL_CLI_HOME_DIR")"
    [[ -n "$cli_home_dir" ]] || cli_home_dir="$STACKS_DIR/$s/cli"

    base_dir="$STACKS_DIR/$s"
    label="com.happy.stacks.$s"

    COLLECT="$(collect_stack_status "$port" "$cli_home_dir" "$label" "$base_dir")"
    IFS=$'\t' read -r LEVEL SERVER_STATUS SERVER_PID SERVER_METRICS DAEMON_STATUS DAEMON_PID DAEMON_METRICS DAEMON_UPTIME LAST_HEARTBEAT LAUNCHAGENT_STATUS AUTOSTART_PID AUTOSTART_METRICS <<<"$COLLECT"
    for v in SERVER_PID SERVER_METRICS DAEMON_PID DAEMON_METRICS DAEMON_UPTIME LAST_HEARTBEAT AUTOSTART_PID AUTOSTART_METRICS; do
      if [[ "${!v}" == "-" ]]; then
        printf -v "$v" '%s' ""
      fi
    done

    render_stack_overview_item "Stack: $s" "$LEVEL" ""
    export STACK_LEVEL="$LEVEL"
    render_stack_info "--" "$s" "$port" "$server_component" "$base_dir" "$cli_home_dir" "$label" "$env_file" ""
    render_component_server "--" "$s" "$port" "$server_component" "$SERVER_STATUS" "$SERVER_PID" "$SERVER_METRICS" "" "$label"
    render_component_daemon "--" "$DAEMON_STATUS" "$DAEMON_PID" "$DAEMON_METRICS" "$DAEMON_UPTIME" "$LAST_HEARTBEAT" "$cli_home_dir/daemon.state.json" "$s"
    render_component_autostart "--" "$s" "$label" "$LAUNCHAGENT_STATUS" "$AUTOSTART_PID" "$AUTOSTART_METRICS" "$base_dir/logs"
    render_component_tailscale "--" "$s" ""
    render_components_menu "--" "stack" "$s" "$env_file"
  done
else
  echo "No stacks dir found at ~/.happy/stacks | color=$GRAY"
fi

echo "---"
render_components_menu "" "main" "main" ""

echo "Worktrees | sfimage=arrow.triangle.branch"
if [[ -z "$PNPM_BIN" ]]; then
  echo "--⚠️ happys not found (run: npx happy-stacks init, or install happy-stacks globally)"
else
  HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
  echo "--Use (interactive) | bash=$HAPPYS_TERM param1=wt param2=use param3=--interactive dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--New (interactive) | bash=$HAPPYS_TERM param1=wt param2=new param3=--interactive dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--PR worktree (prompt) | bash=$HAPPY_LOCAL_DIR/extras/swiftbar/wt-pr.sh dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--Sync mirrors (all) | bash=$PNPM_BIN param1=wt param2=sync-all dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--Update all (dry-run) | bash=$HAPPYS_TERM param1=wt param2=update-all param3=--dry-run dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--Update all (apply) | bash=$PNPM_BIN param1=wt param2=update-all dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
fi

echo "---"
echo "Setup / Tools"
if [[ -z "$PNPM_BIN" ]]; then
  echo "--⚠️ happys not found (run: npx happy-stacks init, or install happy-stacks globally)"
else
  HAPPYS_TERM="$HAPPY_LOCAL_DIR/extras/swiftbar/happys-term.sh"
  echo "--Bootstrap (clone/install) | bash=$HAPPYS_TERM param1=bootstrap dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--CLI link (install happy wrapper) | bash=$HAPPYS_TERM param1=cli:link dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
  echo "--Mobile dev helper | bash=$HAPPYS_TERM param1=mobile dir=$HAPPY_LOCAL_DIR terminal=false"
fi

echo "---"
echo "Refresh | sfimage=arrow.clockwise refresh=true"
echo "---"
echo "Refresh interval | sfimage=timer"
SET_INTERVAL="$HAPPY_LOCAL_DIR/extras/swiftbar/set-interval.sh"
echo "--10s | bash=$SET_INTERVAL param1=10s dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--30s | bash=$SET_INTERVAL param1=30s dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--1m | bash=$SET_INTERVAL param1=1m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--5m (recommended) | bash=$SET_INTERVAL param1=5m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--10m | bash=$SET_INTERVAL param1=10m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--15m | bash=$SET_INTERVAL param1=15m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--30m | bash=$SET_INTERVAL param1=30m dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--1h | bash=$SET_INTERVAL param1=1h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--2h | bash=$SET_INTERVAL param1=2h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--6h | bash=$SET_INTERVAL param1=6h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--12h | bash=$SET_INTERVAL param1=12h dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"
echo "--1d | bash=$SET_INTERVAL param1=1d dir=$HAPPY_LOCAL_DIR terminal=false refresh=true"

exit 0
