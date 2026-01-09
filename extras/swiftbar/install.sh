#!/bin/bash

# ============================================================================
# Happy Stacks SwiftBar Plugin Installer
# ============================================================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_SOURCE="$SCRIPT_DIR/happy-stacks.5s.sh"
# Backwards compatible fallback.
if [[ ! -f "$PLUGIN_SOURCE" ]]; then
  PLUGIN_SOURCE="$SCRIPT_DIR/happy-local.5s.sh"
fi
# Default refresh: 5 minutes (good baseline; still refreshes instantly on open).
# You can override:
#   HAPPY_LOCAL_SWIFTBAR_INTERVAL=30s ./install.sh
PLUGIN_INTERVAL="${HAPPY_STACKS_SWIFTBAR_INTERVAL:-${HAPPY_LOCAL_SWIFTBAR_INTERVAL:-5m}}"
PLUGIN_FILE="happy-stacks.${PLUGIN_INTERVAL}.sh"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo ""
echo -e "${BLUE}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║       Happy Stacks SwiftBar Plugin Installer               ║${NC}"
echo -e "${BLUE}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

# Check if running on macOS
if [[ "$(uname)" != "Darwin" ]]; then
    echo -e "${RED}Error: This installer only works on macOS${NC}"
    exit 1
fi

# Check if SwiftBar is installed
check_swiftbar() {
    if [[ -d "/Applications/SwiftBar.app" ]]; then
        return 0
    elif mdfind "kMDItemCFBundleIdentifier == 'com.ameba.SwiftBar'" 2>/dev/null | grep -q ".app"; then
        return 0
    else
        return 1
    fi
}

# Get SwiftBar plugins directory
get_plugins_dir() {
    # Default location
    local default_dir="$HOME/Library/Application Support/SwiftBar/Plugins"
    
    # Check if SwiftBar has a custom plugins directory set
    local plist_dir
    plist_dir=$(defaults read com.ameba.SwiftBar PluginDirectory 2>/dev/null || echo "")
    
    if [[ -n "$plist_dir" ]] && [[ -d "$plist_dir" ]]; then
        echo "$plist_dir"
    elif [[ -d "$default_dir" ]]; then
        echo "$default_dir"
    else
        echo ""
    fi
}

# Step 1: Check/Install SwiftBar
echo -e "${YELLOW}Step 1: Checking for SwiftBar...${NC}"

if check_swiftbar; then
    echo -e "${GREEN}✓ SwiftBar is already installed${NC}"
else
    echo -e "${YELLOW}SwiftBar is not installed.${NC}"
    echo ""
    echo "Would you like to install SwiftBar via Homebrew? (y/n)"
    read -r INSTALL_CHOICE
    
    if [[ "$INSTALL_CHOICE" == "y" ]] || [[ "$INSTALL_CHOICE" == "Y" ]]; then
        if ! command -v brew &>/dev/null; then
            echo -e "${RED}Error: Homebrew is not installed.${NC}"
            echo "Please install Homebrew first: https://brew.sh"
            echo "Or install SwiftBar manually: https://swiftbar.app"
            exit 1
        fi
        
        echo "Installing SwiftBar..."
        brew install --cask swiftbar
        
        if ! check_swiftbar; then
            echo -e "${RED}Error: SwiftBar installation failed${NC}"
            exit 1
        fi
        echo -e "${GREEN}✓ SwiftBar installed successfully${NC}"
    else
        echo ""
        echo "Please install SwiftBar manually:"
        echo "  - Homebrew: brew install --cask swiftbar"
        echo "  - Direct download: https://swiftbar.app"
        echo ""
        exit 1
    fi
fi

echo ""

# Step 2: Get or create plugins directory
echo -e "${YELLOW}Step 2: Setting up plugins directory...${NC}"

PLUGINS_DIR=$(get_plugins_dir)

if [[ -z "$PLUGINS_DIR" ]]; then
    PLUGINS_DIR="$HOME/Library/Application Support/SwiftBar/Plugins"
    echo "Creating plugins directory: $PLUGINS_DIR"
    mkdir -p "$PLUGINS_DIR"
fi

echo -e "${GREEN}✓ Plugins directory: $PLUGINS_DIR${NC}"
echo ""

# Step 3: Install the plugin
echo -e "${YELLOW}Step 3: Installing Happy Stacks plugin...${NC}"

PLUGIN_DEST="$PLUGINS_DIR/$PLUGIN_FILE"

if [[ -f "$PLUGIN_DEST" ]]; then
    echo "Plugin already exists at $PLUGIN_DEST"
    echo "Would you like to overwrite it? (y/n)"
    read -r OVERWRITE_CHOICE
    
    if [[ "$OVERWRITE_CHOICE" != "y" ]] && [[ "$OVERWRITE_CHOICE" != "Y" ]]; then
        echo "Skipping plugin installation."
    else
        cp "$PLUGIN_SOURCE" "$PLUGIN_DEST"
        chmod +x "$PLUGIN_DEST"
        echo -e "${GREEN}✓ Plugin updated${NC}"
    fi
else
    cp "$PLUGIN_SOURCE" "$PLUGIN_DEST"
    chmod +x "$PLUGIN_DEST"
    echo -e "${GREEN}✓ Plugin installed${NC}"
fi

echo ""

# Step 4: Launch SwiftBar if not running
echo -e "${YELLOW}Step 4: Starting SwiftBar...${NC}"

if ! pgrep -x "SwiftBar" > /dev/null; then
    echo "Launching SwiftBar..."
    open -a SwiftBar
    sleep 2
    echo -e "${GREEN}✓ SwiftBar started${NC}"
else
    echo -e "${GREEN}✓ SwiftBar is already running${NC}"
    echo "  Refreshing plugins..."
    # Trigger a refresh by touching the plugin file
    touch "$PLUGIN_DEST"
fi

echo ""

# Done!
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Installation Complete!                   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo "You should now see a 😊 (or 😢) icon in your menu bar."
echo ""
echo "The plugin refreshes every ${PLUGIN_INTERVAL}."
echo "Click it to see the full menu with controls."
echo ""
echo -e "${BLUE}Tips:${NC}"
echo "  • Right-click the icon for SwiftBar options"
echo "  • The plugin is located at: $PLUGIN_DEST"
echo "  • Edit the script to customize behavior"
echo ""
