#!/usr/bin/env bash
set -euo pipefail

# Provision a fresh Ubuntu VM for running happy-local's `review-pr` end-to-end.
# Intended for Apple Silicon users running Ubuntu ARM64 via Lima/UTM.
#
# This installs:
# - Node (via nvm)
# - corepack (yarn/pnpm shims)
# - basic build tooling for native deps used by Expo/React Native ecosystem
# - a few common CLI utilities used in developer workflows (zip/unzip/jq/rsync)

if [[ "$(uname -s)" != "Linux" ]]; then
  echo "[provision] expected Linux; got: $(uname -s)" >&2
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive

echo "[provision] installing apt dependencies..."
sudo apt-get update -y
sudo apt-get install -y \
  ca-certificates \
  curl \
  git \
  build-essential \
  python3 \
  pkg-config \
  unzip \
  zip \
  jq \
  rsync

echo "[provision] installing nvm + Node..."
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
if [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
  mkdir -p "$NVM_DIR"
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
fi

# shellcheck disable=SC1090
source "$NVM_DIR/nvm.sh"

# Use the current Node.js LTS by default.
# Override if needed: `NODE_VERSION=24 ...` (or any version supported by nvm).
# (As of 2026-01-24, the current LTS line is 24.x.)
NODE_VERSION="${NODE_VERSION:-lts/*}"
nvm install "$NODE_VERSION"
nvm use "$NODE_VERSION"

echo "[provision] enabling corepack..."
corepack enable >/dev/null 2>&1 || true
# Pre-activate common package managers so first-run installs are smoother.
# (Yarn classic is used by the slopus/happy monorepo today.)
corepack prepare yarn@1.22.22 --activate >/dev/null 2>&1 || true
corepack prepare pnpm@latest --activate >/dev/null 2>&1 || true

echo "[provision] done."
echo "[provision] Node: $(node --version)"
echo "[provision] npm:  $(npm --version)"
echo "[provision] git:  $(git --version)"
