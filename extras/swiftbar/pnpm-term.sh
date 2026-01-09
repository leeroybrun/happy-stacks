#!/bin/bash
set -euo pipefail

# Open preferred terminal and run a pnpm command in the happy-local repo root.
#
# Preference order follows wt shell semantics:
# - HAPPY_LOCAL_WT_TERMINAL=ghostty|iterm|terminal|current
#   (also accepts "auto" which tries ghostty->iterm->terminal->current)
#
# Notes:
# - iTerm / Terminal: we run the command automatically via AppleScript.
# - Ghostty: best-effort; if we can't run the command, we open Ghostty in the dir and copy the command to clipboard.

HAPPY_LOCAL_DIR="${HAPPY_LOCAL_DIR:-$HOME/Documents/Development/happy-local}"

if [[ ! -f "$HAPPY_LOCAL_DIR/package.json" ]]; then
  echo "happy-local not found at: $HAPPY_LOCAL_DIR" >&2
  exit 1
fi

PNPM_SH="$HAPPY_LOCAL_DIR/extras/swiftbar/pnpm.sh"
if [[ ! -x "$PNPM_SH" ]]; then
  echo "missing pnpm wrapper: $PNPM_SH" >&2
  exit 1
fi

pref_raw="$(echo "${HAPPY_LOCAL_WT_TERMINAL:-auto}" | tr '[:upper:]' '[:lower:]')"
pref="$pref_raw"
if [[ "$pref" == "" ]]; then pref="auto"; fi

cmd=( "$PNPM_SH" "$@" )

escape_for_osascript_string() {
  # Escape for inclusion inside an AppleScript string literal.
  # (We generate: write text "<cmd>")
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  echo "$s"
}

shell_cmd() {
  # Build a zsh command that cds and runs pnpm, leaving the shell open.
  local joined=""
  local q
  joined="cd \"${HAPPY_LOCAL_DIR//\"/\\\"}\"; "
  for q in "${cmd[@]}"; do
    # Basic shell quoting
    if [[ "$q" =~ [[:space:]\\"\'\$\`\!\&\|\;\<\>\(\)\[\]\{\}] ]]; then
      joined+="'${q//\'/\'\\\'\'}' "
    else
      joined+="$q "
    fi
  done
  joined+="; echo; echo \"[happy-local] done\"; exec /bin/zsh -i"
  echo "$joined"
}

run_iterm() {
  if ! command -v osascript >/dev/null 2>&1; then
    return 1
  fi
  local s
  s="$(shell_cmd)"
  s="$(escape_for_osascript_string "$s")"
  osascript \
    -e 'tell application "iTerm" to activate' \
    -e 'tell application "iTerm" to create window with default profile' \
    -e "tell application \"iTerm\" to tell current session of current window to write text \"${s}\"" >/dev/null
}

run_terminal_app() {
  if ! command -v osascript >/dev/null 2>&1; then
    return 1
  fi
  local s
  s="$(shell_cmd)"
  # Terminal.app uses do script.
  s="$(escape_for_osascript_string "$s")"
  osascript \
    -e 'tell application "Terminal" to activate' \
    -e "tell application \"Terminal\" to do script \"${s}\"" >/dev/null
}

run_ghostty() {
  if ! command -v ghostty >/dev/null 2>&1; then
    return 1
  fi

  # Best-effort: try to run the command. If ghostty doesn't support -e on this system,
  # fall back to opening the dir and copying the command.
  local s
  s="$(shell_cmd)"
  if ghostty --working-directory "$HAPPY_LOCAL_DIR" -e /bin/zsh -lc "$s" >/dev/null 2>&1; then
    return 0
  fi

  # Fallback: open in dir and copy command for manual paste.
  echo -n "$s" | pbcopy 2>/dev/null || true
  ghostty --working-directory "$HAPPY_LOCAL_DIR" >/dev/null 2>&1 || true
  return 0
}

try_one() {
  local t="$1"
  case "$t" in
    ghostty) run_ghostty ;;
    iterm) run_iterm ;;
    terminal) run_terminal_app ;;
    current) ( cd "$HAPPY_LOCAL_DIR"; exec "${cmd[@]}" ) ;;
    *) return 1 ;;
  esac
}

if [[ "$pref" == "auto" ]]; then
  for t in ghostty iterm terminal current; do
    if try_one "$t"; then
      exit 0
    fi
  done
  exit 1
fi

try_one "$pref"

