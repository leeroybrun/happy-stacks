#!/bin/bash

# Lightweight git helpers for SwiftBar.
# Keep these fast: avoid network, avoid long commands.

is_git_repo() {
  local dir="$1"
  [[ -n "$dir" && -d "$dir" && ( -d "$dir/.git" || -f "$dir/.git" ) ]]
}

git_try() {
  local dir="$1"
  shift
  if ! command -v git >/dev/null 2>&1; then
    return 1
  fi
  git -C "$dir" "$@" 2>/dev/null
}

git_head_branch() {
  local dir="$1"
  git_try "$dir" rev-parse --abbrev-ref HEAD | head -1
}

git_head_short() {
  local dir="$1"
  git_try "$dir" rev-parse --short HEAD | head -1
}

git_upstream_short() {
  local dir="$1"
  # Prints like "origin/main" or "upstream/main"
  git_try "$dir" rev-parse --abbrev-ref --symbolic-full-name '@{u}' | head -1 || true
}

git_ahead_behind() {
  # Output: ahead|behind (numbers). Returns empty if no upstream.
  local dir="$1"
  local upstream
  upstream="$(git_upstream_short "$dir")"
  if [[ -z "$upstream" ]]; then
    echo ""
    return
  fi
  local counts
  counts="$(git_try "$dir" rev-list --left-right --count "${upstream}...HEAD" | tr -s ' ' | sed 's/^ //')" || true
  if [[ -z "$counts" ]]; then
    echo ""
    return
  fi
  # counts is "behind ahead"
  local behind ahead
  behind="$(echo "$counts" | awk '{print $1}')"
  ahead="$(echo "$counts" | awk '{print $2}')"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    echo "${ahead}|${behind}"
  else
    echo ""
  fi
}

git_dirty_flag() {
  # "clean" | "dirty" | "unknown"
  local dir="$1"
  if ! is_git_repo "$dir"; then
    echo "unknown"
    return
  fi
  local out
  out="$(git_try "$dir" status --porcelain | head -1 || true)"
  if [[ -n "$out" ]]; then
    echo "dirty"
  else
    echo "clean"
  fi
}

git_main_branch_name() {
  local dir="$1"
  if git_try "$dir" show-ref --verify --quiet refs/heads/main; then
    echo "main"
    return
  fi
  if git_try "$dir" show-ref --verify --quiet refs/heads/master; then
    echo "master"
    return
  fi
  echo ""
}

git_branch_upstream_short() {
  local dir="$1"
  local branch="$2"
  if [[ -z "$branch" ]]; then
    echo ""
    return
  fi
  git_try "$dir" rev-parse --abbrev-ref --symbolic-full-name "${branch}@{u}" | head -1 || true
}

git_branch_ahead_behind() {
  # Output: ahead|behind for a branch vs its upstream.
  local dir="$1"
  local branch="$2"
  local upstream
  upstream="$(git_branch_upstream_short "$dir" "$branch")"
  if [[ -z "$branch" || -z "$upstream" ]]; then
    echo ""
    return
  fi
  local counts
  counts="$(git_try "$dir" rev-list --left-right --count "${upstream}...${branch}" | tr -s ' ' | sed 's/^ //')" || true
  if [[ -z "$counts" ]]; then
    echo ""
    return
  fi
  local behind ahead
  behind="$(echo "$counts" | awk '{print $1}')"
  ahead="$(echo "$counts" | awk '{print $2}')"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    echo "${ahead}|${behind}"
  else
    echo ""
  fi
}

git_ref_exists() {
  local dir="$1"
  local ref="$2"
  [[ -n "$ref" ]] || return 1
  git_try "$dir" show-ref --verify --quiet "$ref"
}

git_remote_main_ref() {
  # Returns a remote tracking ref like refs/remotes/origin/main or refs/remotes/upstream/master.
  local dir="$1"
  local remote="$2"
  if git_ref_exists "$dir" "refs/remotes/${remote}/main"; then
    echo "refs/remotes/${remote}/main"
    return
  fi
  if git_ref_exists "$dir" "refs/remotes/${remote}/master"; then
    echo "refs/remotes/${remote}/master"
    return
  fi
  echo ""
}

git_ahead_behind_refs() {
  # Output: ahead|behind for local_ref compared to base_ref.
  # Uses: git rev-list --left-right --count base...local => "behind ahead"
  local dir="$1"
  local base_ref="$2"
  local local_ref="$3"
  if [[ -z "$base_ref" || -z "$local_ref" ]]; then
    echo ""
    return
  fi
  local counts
  counts="$(git_try "$dir" rev-list --left-right --count "${base_ref}...${local_ref}" | tr -s ' ' | sed 's/^ //')" || true
  if [[ -z "$counts" ]]; then
    echo ""
    return
  fi
  local behind ahead
  behind="$(echo "$counts" | awk '{print $1}')"
  ahead="$(echo "$counts" | awk '{print $2}')"
  if [[ -n "$ahead" && -n "$behind" ]]; then
    echo "${ahead}|${behind}"
  else
    echo ""
  fi
}

git_worktree_count() {
  local dir="$1"
  if ! is_git_repo "$dir"; then
    echo ""
    return
  fi
  local out
  out="$(git_try "$dir" worktree list --porcelain || true)"
  if [[ -z "$out" ]]; then
    echo ""
    return
  fi
  # Count "worktree <path>" blocks.
  echo "$out" | awk '/^worktree /{c++} END{ if (c>0) print c; }'
}

git_worktrees_tsv() {
  # Output: path<TAB>branchRefOrEmpty
  # Example branch line in porcelain: "branch refs/heads/slopus/pr/foo"
  local dir="$1"
  if ! is_git_repo "$dir"; then
    return
  fi
  local out
  out="$(git_try "$dir" worktree list --porcelain || true)"
  if [[ -z "$out" ]]; then
    return
  fi

  local wt_path="" wt_branch=""
  while IFS= read -r line; do
    # Block separator
    if [[ -z "$line" ]]; then
      if [[ -n "$wt_path" ]]; then
        echo -e "${wt_path}\t${wt_branch}"
      fi
      wt_path=""
      wt_branch=""
      continue
    fi

    if [[ "$line" == worktree\ * ]]; then
      wt_path="${line#worktree }"
      continue
    fi
    if [[ "$line" == branch\ * ]]; then
      wt_branch="${line#branch }"
      continue
    fi
    # ignore HEAD/detached lines
  done <<<"$out"

  if [[ -n "$wt_path" ]]; then
    echo -e "${wt_path}\t${wt_branch}"
  fi
}

resolve_component_dir_from_env_file() {
  # Resolve component directory based on a stack env file.
  # Usage: resolve_component_dir_from_env_file <env_file> <component>
  local env_file="$1"
  local component="$2"
  local key=""
  case "$component" in
    happy) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY" ;;
    happy-cli) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI" ;;
    happy-server-light) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT" ;;
    happy-server) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER" ;;
    *) key="" ;;
  esac

  local fallback="$HAPPY_LOCAL_DIR/components/$component"
  if [[ -z "$env_file" || -z "$key" || ! -f "$env_file" ]]; then
    echo "$fallback"
    return
  fi

  local raw
  raw="$(dotenv_get "$env_file" "$key")"
  if [[ -z "$raw" ]]; then
    echo "$fallback"
    return
  fi

  if [[ "$raw" == "~/"* ]]; then
    raw="$HOME/${raw#~/}"
  fi
  if [[ "$raw" == /* ]]; then
    echo "$raw"
  else
    echo "$HAPPY_LOCAL_DIR/$raw"
  fi
}

resolve_component_dir_from_env() {
  # Resolve active component directory based on env + env.local + .env.
  # Usage: resolve_component_dir_from_env <component>
  # Output: absolute path (best-effort). Falls back to $HAPPY_LOCAL_DIR/components/<component>.
  local component="$1"
  local key=""
  case "$component" in
    happy) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY" ;;
    happy-cli) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY_CLI" ;;
    happy-server-light) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER_LIGHT" ;;
    happy-server) key="HAPPY_LOCAL_COMPONENT_DIR_HAPPY_SERVER" ;;
    *) key="" ;;
  esac

  local raw=""
  if [[ -n "$key" && -n "${!key:-}" ]]; then
    raw="${!key}"
  fi
  if [[ -z "$raw" && -n "$key" ]]; then
    raw="$(dotenv_get "$HAPPY_LOCAL_DIR/env.local" "$key")"
  fi
  if [[ -z "$raw" && -n "$key" ]]; then
    raw="$(dotenv_get "$HAPPY_LOCAL_DIR/.env" "$key")"
  fi

  local fallback="$HAPPY_LOCAL_DIR/components/$component"
  if [[ -z "$raw" ]]; then
    echo "$fallback"
    return
  fi

  # Expand ~
  if [[ "$raw" == "~/"* ]]; then
    raw="$HOME/${raw#~/}"
  fi

  # Absolute vs relative (relative is interpreted relative to the repo root).
  if [[ "$raw" == /* ]]; then
    echo "$raw"
  else
    echo "$HAPPY_LOCAL_DIR/$raw"
  fi
}

