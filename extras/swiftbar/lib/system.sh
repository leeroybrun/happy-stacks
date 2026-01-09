#!/bin/bash

get_process_metrics() {
  local pid="$1"
  if [[ -z "$pid" ]]; then
    echo ""
    return
  fi
  # Output: cpu|mem_mb|etime
  local line
  line="$(ps -p "$pid" -o %cpu= -o rss= -o etime= 2>/dev/null | head -1 | tr -s ' ' | sed 's/^ //')"
  if [[ -z "$line" ]]; then
    echo ""
    return
  fi
  local cpu rss etime
  cpu="$(echo "$line" | awk '{print $1}')"
  rss="$(echo "$line" | awk '{print $2}')" # KB
  etime="$(echo "$line" | awk '{print $3}')"
  local mem_mb
  mem_mb="$(awk -v rss="$rss" 'BEGIN { printf "%.0f", (rss/1024.0) }')"
  echo "$cpu|$mem_mb|$etime"
}

get_port_listener_pid() {
  local port="$1"
  if [[ -z "$port" ]]; then
    echo ""
    return
  fi
  if ! command -v lsof >/dev/null 2>&1; then
    echo ""
    return
  fi
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1 || true
}

# Cached launchctl output for speed across many stacks.
LAUNCHCTL_LIST_CACHE=""

ensure_launchctl_cache() {
  if [[ -n "$LAUNCHCTL_LIST_CACHE" ]]; then
    return
  fi
  if command -v launchctl >/dev/null 2>&1; then
    LAUNCHCTL_LIST_CACHE="$(launchctl list 2>/dev/null || true)"
  fi
}

check_launchagent_status() {
  local label="${1:-com.happy.local}"
  local plist="${2:-$HOME/Library/LaunchAgents/${label}.plist}"
  if [[ ! -f "$plist" ]]; then
    echo "not_installed"
    return
  fi

  ensure_launchctl_cache
  if echo "$LAUNCHCTL_LIST_CACHE" | grep -q "$label"; then
    echo "loaded"
    return
  fi
  echo "unloaded"
}

launchagent_pid_for_label() {
  local label="$1"
  if [[ -z "$label" ]]; then
    return
  fi
  ensure_launchctl_cache
  if [[ -z "$LAUNCHCTL_LIST_CACHE" ]]; then
    return
  fi
  local pid
  pid="$(echo "$LAUNCHCTL_LIST_CACHE" | awk -v lbl="$label" '$3==lbl{print $1}' | head -1)"
  if [[ "$pid" == "-" ]]; then
    return
  fi
  echo "$pid"
}

check_server_health() {
  local port="$1"
  if [[ -z "$port" ]]; then
    echo "stopped"
    return
  fi
  local response
  # Tight timeouts to keep menus snappy even with many stacks.
  response="$(curl -s --connect-timeout 0.2 --max-time 0.6 "http://127.0.0.1:${port}/health" 2>/dev/null || true)"
  if [[ "$response" == *"ok"* ]] || [[ "$response" == *"Welcome"* ]]; then
    echo "running"
    return
  fi
  echo "stopped"
}

check_daemon_status() {
  local cli_home_dir="$1"
  local state_file="$cli_home_dir/daemon.state.json"
  if [[ -z "$cli_home_dir" ]] || [[ ! -f "$state_file" ]]; then
    echo "stopped"
    return
  fi

  local pid httpPort
  pid="$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(s.pid ?? ""));' "$state_file" 2>/dev/null || true)"
  httpPort="$(node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); process.stdout.write(String(s.httpPort ?? ""));' "$state_file" 2>/dev/null || true)"

  if [[ -z "$pid" ]] || ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    echo "unknown"
    return
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    echo "stale"
    return
  fi

  # Best-effort: confirm the control server is responding (tight timeouts).
  if [[ -n "$httpPort" ]] && [[ "$httpPort" =~ ^[0-9]+$ ]]; then
    if curl -s --connect-timeout 0.2 --max-time 0.5 -X POST -H 'content-type: application/json' -d '{}' "http://127.0.0.1:${httpPort}/list" >/dev/null 2>&1; then
      echo "running:$pid"
      return
    fi
    echo "running-no-http:$pid"
    return
  fi

  echo "running:$pid"
}

get_daemon_uptime() {
  local cli_home_dir="$1"
  local state_file="$cli_home_dir/daemon.state.json"
  if [[ -z "$cli_home_dir" ]] || [[ ! -f "$state_file" ]]; then
    return
  fi
  node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (s.startTime) process.stdout.write(String(s.startTime));' "$state_file" 2>/dev/null || true
}

get_last_heartbeat() {
  local cli_home_dir="$1"
  local state_file="$cli_home_dir/daemon.state.json"
  if [[ -z "$cli_home_dir" ]] || [[ ! -f "$state_file" ]]; then
    return
  fi
  node -e 'const fs=require("fs"); const s=JSON.parse(fs.readFileSync(process.argv[1],"utf8")); if (s.lastHeartbeat) process.stdout.write(String(s.lastHeartbeat));' "$state_file" 2>/dev/null || true
}

get_tailscale_url() {
  # Try multiple methods to get the Tailscale URL (best-effort).
  local url=""

  if command -v tailscale &>/dev/null; then
    url="$(tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
  fi
  if [[ -z "$url" ]] && [[ -x "/Applications/Tailscale.app/Contents/MacOS/Tailscale" ]]; then
    url="$(/Applications/Tailscale.app/Contents/MacOS/Tailscale serve status 2>/dev/null | grep -oE 'https://[^ ]+' | head -1 || true)"
  fi

  echo "$url"
}

