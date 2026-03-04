#!/usr/bin/env bash
# =============================================================================
# ccusage-gnome — Uninstaller
# =============================================================================
set -euo pipefail

EXTENSION_UUID="ccusage-gnome@SirAllap.github.io"
EXTENSION_DEST="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

CYAN='\033[0;36m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}  →${RESET} $*"; }
success() { echo -e "${GREEN}  ✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}  !${RESET} $*"; }

echo -e "${BOLD}Uninstalling ccusage-gnome…${RESET}"
echo ""

# Disable and uninstall extension
if gnome-extensions list 2>/dev/null | grep -qF "$EXTENSION_UUID"; then
    gnome-extensions disable "$EXTENSION_UUID" &>/dev/null || true
    success "Extension disabled"
    gnome-extensions uninstall "$EXTENSION_UUID" &>/dev/null || true
fi

# Remove extension directory if still present
if [ -d "$EXTENSION_DEST" ]; then
    rm -rf "$EXTENSION_DEST"
    success "Removed $EXTENSION_DEST"
fi

# Remove temp / cache files
rm -f /tmp/ccusage_usage.json \
       /tmp/ccusage_fetch.lock \
       /tmp/ccusage_tokens.json
success "Removed cache files from /tmp"

echo ""
echo -e "${GREEN}${BOLD}Uninstall complete.${RESET}"
warn "GNOME Shell may need to restart for the panel icon to disappear."
