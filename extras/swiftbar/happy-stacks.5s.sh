#!/bin/bash

# <xbar.title>Happy Stacks</xbar.title>
# <xbar.version>1.0.0</xbar.version>
# <xbar.author>Happy Stacks</xbar.author>
# <xbar.author.github>leeroybrun</xbar.author.github>
# <xbar.desc>Monitor and control your Happy stacks from the menu bar</xbar.desc>
# <xbar.dependencies>node,pnpm</xbar.dependencies>
# <swiftbar.hideAbout>true</swiftbar.hideAbout>
# <swiftbar.hideRunInTerminal>true</swiftbar.hideRunInTerminal>
# <swiftbar.hideLastUpdated>false</swiftbar.hideLastUpdated>
# <swiftbar.hideDisablePlugin>true</swiftbar.hideDisablePlugin>
# <swiftbar.hideSwiftBar>true</swiftbar.hideSwiftBar>
# <swiftbar.refreshOnOpen>false</swiftbar.refreshOnOpen>

# ============================================================================
# Configuration
# ============================================================================

# NOTE: support both HAPPY_STACKS_* (new) and HAPPY_LOCAL_* (legacy).
HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HOME/Documents/Development/happy-stacks}"
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
  # Try common locations if the env var/default is stale.
  for cand in "$HOME/Documents/Development/happy-stacks" "$HOME/Development/happy-stacks" "$HOME/Documents/Development/happy-local" "$HOME/Development/happy-local"; do
    if [[ -f "$cand/extras/swiftbar/lib/utils.sh" ]]; then
      HAPPY_LOCAL_DIR="$cand"
      LIB_DIR="$cand/extras/swiftbar/lib"
      break
    fi
  done
fi

if [[ ! -f "$LIB_DIR/utils.sh" ]]; then
  echo "Happy Stacks"
  echo "---"
  echo "SwiftBar libs missing at: $LIB_DIR"
  exit 0
fi

# shellcheck source=/dev/null
source "$LIB_DIR/utils.sh"
HAPPY_LOCAL_DIR="$(resolve_happy_local_dir)"
LIB_DIR="$HAPPY_LOCAL_DIR/extras/swiftbar/lib"
# shellcheck source=/dev/null
source "$LIB_DIR/icons.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/git.sh"
# shellcheck source=/dev/null
source "$LIB_DIR/render.sh"

render_menu

