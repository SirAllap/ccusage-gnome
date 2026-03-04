#!/usr/bin/env bash
# =============================================================================
# ccusage-gnome — Installer
# =============================================================================
set -euo pipefail

EXTENSION_UUID="ccusage-gnome@SirAllap.github.io"
EXTENSION_SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$EXTENSION_UUID"

EXTENSION_DEST="$HOME/.local/share/gnome-shell/extensions/$EXTENSION_UUID"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

info()    { echo -e "${CYAN}  →${RESET} $*"; }
success() { echo -e "${GREEN}  ✓${RESET} $*"; }
warn()    { echo -e "${YELLOW}  !${RESET} $*"; }
error()   { echo -e "${RED}  ✗${RESET} $*" >&2; }
header()  { echo -e "\n${BOLD}$*${RESET}"; }

# =============================================================================
# Dependency checks
# =============================================================================
header "Checking dependencies…"

# GNOME Shell
if ! command -v gnome-shell &>/dev/null; then
    error "GNOME Shell not found. This extension requires GNOME."
    exit 1
fi
GNOME_VER=$(gnome-shell --version | grep -oP '\d+' | head -1)
if [ "$GNOME_VER" -lt 45 ]; then
    warn "GNOME Shell $GNOME_VER detected. This extension requires GNOME Shell 45+."
    warn "It may not work correctly on your system."
else
    success "GNOME Shell $GNOME_VER"
fi

# Python 3.9+ — required to run fetch.py in the background
PYTHON=""
for candidate in python3 /usr/bin/python3 python3.13 python3.12 python3.11 python3.10 python3.9; do
    bin=$(command -v "$candidate" 2>/dev/null || true)
    [ -z "$bin" ] && continue
    ver=$("$bin" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)
    major=$(echo "$ver" | cut -d. -f1)
    minor=$(echo "$ver" | cut -d. -f2)
    [ "$major" -lt 3 ] 2>/dev/null && continue
    { [ "$major" -eq 3 ] && [ "$minor" -lt 9 ]; } 2>/dev/null && continue
    PYTHON="$bin"
    PY_VER="$ver"
    break
done

if [ -z "$PYTHON" ]; then
    error "No Python 3.9+ found."
    error "Install with: sudo apt install python3"
    exit 1
fi
success "Python $PY_VER ($PYTHON)"

# CLI binary
CLI_BIN="$HOME/.local/bin/claude"
if [ ! -x "$CLI_BIN" ] && ! command -v claude &>/dev/null; then
    warn "CLI not found at $CLI_BIN."
    warn "fetch.py expects the CLI at ~/.local/bin/claude."
    warn "Install it first: https://docs.anthropic.com/claude-code"
    warn "Continuing installation — you can install it separately."
else
    success "CLI found"
fi

# =============================================================================
# Install GNOME Shell extension
# =============================================================================
header "Installing GNOME Shell extension…"

mkdir -p "$EXTENSION_DEST/icons"
cp "$EXTENSION_SRC/extension.js"           "$EXTENSION_DEST/extension.js"
cp "$EXTENSION_SRC/metadata.json"          "$EXTENSION_DEST/metadata.json"
cp "$EXTENSION_SRC/fetch.py"               "$EXTENSION_DEST/fetch.py"
cp "$EXTENSION_SRC/icons/ccusage.svg"      "$EXTENSION_DEST/icons/ccusage.svg"
success "Extension files installed to $EXTENSION_DEST"

# =============================================================================
# Enable the extension
# =============================================================================
header "Enabling extension…"

# If GNOME Shell already knows this extension (update path), do a hot reload:
# disable → files already copied above → enable.
# On a first install GNOME Shell hasn't scanned the new directory yet and
# requires a session restart (Wayland limitation — no in-session shell restart).
if gnome-extensions list 2>/dev/null | grep -qF "$EXTENSION_UUID"; then
    gnome-extensions disable "$EXTENSION_UUID" &>/dev/null || true
    gnome-extensions enable  "$EXTENSION_UUID" &>/dev/null && \
        success "Extension reloaded (hot-reload)"  || \
        warn "Reload failed — run: gnome-extensions enable $EXTENSION_UUID"
else
    warn "First install: GNOME Shell needs a session restart to discover the extension."
    info "Log out and back in, then the extension will appear automatically."
    info "(Future updates via this script will hot-reload without a logout.)"
fi

# =============================================================================
# Done
# =============================================================================
echo ""
echo -e "${GREEN}${BOLD}Installation complete!${RESET}"
echo ""
echo -e "${BOLD}The extension should now appear in your top bar.${RESET}"
echo "If it doesn't, log out and back in, then run:"
echo ""
echo "  gnome-extensions enable $EXTENSION_UUID"
echo ""
echo -e "${BOLD}To reload the extension after future updates:${RESET}"
echo "  bash install.sh"
echo ""
echo -e "${BOLD}To check for errors:${RESET}"
echo "  journalctl -f -o cat /usr/bin/gnome-shell | grep -i ccusage"
