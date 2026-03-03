# Claude Code Usage

A GNOME Shell extension that shows your **Claude Code API usage** directly in the top bar — session consumption, time remaining, weekly budget tracking, and today's token analytics — all without leaving your desktop.

---

## Features

- **Top bar at a glance** — session % consumed, time until reset, weekly budget bar (7-day pace tracking)
- **Detailed dropdown** — progress bars for Session (5h rolling), Weekly (all models), Weekly (Sonnet), with Day X/7 budget tracking for each
- **Today's token analytics** — total input/output tokens, cache read/write, session count, message count (populated when the popup is opened)
- **GTK4 popup window** — full detailed view triggered by a keyboard shortcut
- **Background refresh** — data is fetched automatically, never blocking your workflow
- **Force refresh** — one click to invalidate cache and fetch fresh data
- **No external services** — reads directly from the Claude CLI; no API keys required beyond your existing Claude Code login

---

## How It Works

The project has three components that work together:

```
┌─────────────────────────────────────────────────────────────┐
│  GNOME Shell Extension (extension.js)                       │
│  • Reads /tmp/claude_usage.json every 30 s                  │
│  • Spawns fetch.py when cache is stale (>90 s)              │
│  • Reads /tmp/claude_tokens.json for token stats            │
└─────────────────┬───────────────────────┬───────────────────┘
                  │ spawns                │ reads
                  ▼                       │
┌─────────────────────────────┐          │
│  fetch.py (Python)          │          │
│  • Opens a PTY session      │          │
│  • Launches claude CLI      │          │
│  • Sends /usage command     │          │
│  • Parses TUI output        │          │
│  • Writes claude_usage.json │          │
└─────────────────────────────┘          │
                                         │
┌────────────────────────────────────────┴────────────────────┐
│  popup.py (Python / GTK4)                                   │
│  • Floating window triggered by keyboard shortcut           │
│  • Shows full usage details + token analytics               │
│  • Writes /tmp/claude_tokens.json (read by extension)       │
└─────────────────────────────────────────────────────────────┘
```

> **Why Python scripts?** The GNOME Shell JavaScript engine (GJS) cannot open a PTY or run interactive terminal sessions. `fetch.py` handles this by spawning the Claude CLI in a pseudo-terminal and scraping its `/usage` output.

---

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| GNOME Shell | 45+ | Ubuntu 23.10+, Fedora 39+ |
| Python | 3.9+ | Required for `zoneinfo` module |
| python3-gi | any | GTK bindings for popup window |
| gir1.2-gtk-4.0 | any | GTK 4 typelib data |
| Claude CLI | any | Installed via Claude Code setup |

### Install system dependencies (Ubuntu/Debian)

```bash
sudo apt install python3 python3-gi gir1.2-gtk-4.0
```

### Install Claude CLI

Follow the official Claude Code installation guide:
https://docs.anthropic.com/claude-code

The installer expects the Claude binary at `~/.local/bin/claude`.

---

## Installation

### Method 1: Install script (recommended)

```bash
git clone https://github.com/SirAllap/claude-code-usage.git
cd claude-code-usage
chmod +x install.sh
./install.sh
```

The script will:
- Verify all dependencies
- Install Python backend scripts to `~/.local/share/claude-usage/`
- Install the GNOME extension to `~/.local/share/gnome-shell/extensions/`
- Create the `claude-usage-popup` command in `~/.local/bin/`
- Register and enable the extension

If the extension does not appear in the top bar immediately, **restart GNOME Shell**:

- **X11:** Press `Alt+F2`, type `r`, press Enter
- **Wayland:** Log out and log back in

Then enable manually if needed:

```bash
gnome-extensions enable claude-code-usage@SirAllap.github.io
```

---

### Method 2: Manual installation

```bash
# 1. Clone the repository
git clone https://github.com/SirAllap/claude-code-usage.git
cd claude-code-usage

# 2. Install Python backend scripts
mkdir -p ~/.local/share/claude-usage
cp scripts/fetch.py scripts/popup.py ~/.local/share/claude-usage/
chmod +x ~/.local/share/claude-usage/popup.py

# 3. Install popup wrapper (optional — for keyboard shortcut)
mkdir -p ~/.local/bin
cat > ~/.local/bin/claude-usage-popup <<'EOF'
#!/usr/bin/env bash
exec python3 "$HOME/.local/share/claude-usage/popup.py" "$@"
EOF
chmod +x ~/.local/bin/claude-usage-popup

# 4. Install GNOME extension
mkdir -p ~/.local/share/gnome-shell/extensions/claude-code-usage@SirAllap.github.io
cp "claude-code-usage@SirAllap.github.io"/* \
   ~/.local/share/gnome-shell/extensions/claude-code-usage@SirAllap.github.io/

# 5. Register with GNOME Shell
cd ~/.local/share/gnome-shell/extensions
zip -r /tmp/claude-code-usage@SirAllap.github.io.zip claude-code-usage@SirAllap.github.io/
gnome-extensions install --force /tmp/claude-code-usage@SirAllap.github.io.zip
rm /tmp/claude-code-usage@SirAllap.github.io.zip

# 6. Enable
gnome-extensions enable claude-code-usage@SirAllap.github.io
```

---

## Usage

### Top bar label

```
◆  1%  ↺4h0m  ▰▰▰▱▱▱▱
│   │    │       │
│   │    │       └── Weekly budget bar (7 blocks = 7-day cycle)
│   │    └────────── Time remaining in current 5h session window
│   └─────────────── Session usage % (5h rolling window consumed)
└─────────────────── Claude icon
```

The percentage color indicates urgency:

| Color | Threshold |
|---|---|
| Green | < 75% |
| Yellow | 75–89% |
| Red | ≥ 90% |

### Dropdown panel

Click the indicator to open the detailed view:

- **Session (5h rolling)** — progress bar + reset time
- **Weekly (all models)** — progress bar + reset time + Day X/7 budget line + 7-block budget bar
- **Weekly (Sonnet)** — same as above
- **Today's Tokens** — session count, message count, tokens in/out, cache stats *(shown after opening the popup window at least once)*
- **Footer** — data age + fetch status
- **↺ Force Refresh** — delete cache and trigger an immediate fetch

### GTK4 popup window (optional)

For a full-screen floating window with all details, assign a keyboard shortcut:

```
Settings → Keyboard → View and Customise Shortcuts → Custom Shortcuts
Name:    Claude Usage
Command: claude-usage-popup
```

Press `Esc` or click away to close.

> Opening the popup also refreshes the **Today's Tokens** section in the extension dropdown, since popup.py writes the token cache that the extension reads.

---

## Uninstallation

```bash
chmod +x uninstall.sh
./uninstall.sh
```

Or manually:

```bash
gnome-extensions disable claude-code-usage@SirAllap.github.io
gnome-extensions uninstall claude-code-usage@SirAllap.github.io
rm -rf ~/.local/share/claude-usage
rm -f ~/.local/bin/claude-usage-popup
rm -f /tmp/claude_usage.json /tmp/claude_fetch.lock /tmp/claude_tokens.json
```

---

## File Structure

```
claude-code-usage/
├── README.md
├── LICENSE
├── install.sh                                    ← automated installer
├── uninstall.sh                                  ← automated uninstaller
├── claude-code-usage@SirAllap.github.io/         ← GNOME Shell extension
│   ├── extension.js                              ← panel indicator + dropdown UI
│   └── metadata.json                             ← extension manifest
└── scripts/                                      ← Python backend
    ├── fetch.py                                  ← Claude CLI PTY fetcher
    └── popup.py                                  ← GTK4 floating window
```

**Runtime locations (created by installer):**

```
~/.local/share/claude-usage/           ← backend scripts
~/.local/share/gnome-shell/extensions/claude-code-usage@SirAllap.github.io/
~/.local/bin/claude-usage-popup        ← popup launcher wrapper
/tmp/claude_usage.json                 ← usage data cache
/tmp/claude_fetch.lock                 ← fetch process lock
/tmp/claude_tokens.json                ← token analytics cache
```

---

## Development

### Reloading the extension after changes

Once the extension has been loaded by GNOME Shell at least once:

```bash
gnome-extensions disable claude-code-usage@SirAllap.github.io \
  && gnome-extensions enable claude-code-usage@SirAllap.github.io
```

### Watching logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i claude
```

### Testing fetch.py standalone

```bash
python3 ~/.local/share/claude-usage/fetch.py
cat /tmp/claude_usage.json
```

### Creating a release zip (for extensions.gnome.org)

```bash
cd "claude-code-usage@SirAllap.github.io"
zip -r ../claude-code-usage.zip . --exclude="*.git*"
```

---

## Troubleshooting

### Extension not visible in the top bar

```bash
# Check it is enabled and active
gnome-extensions info claude-code-usage@SirAllap.github.io

# Check for JS errors
journalctl -b -o cat /usr/bin/gnome-shell | grep -i "claude\|Extension error"

# Re-enable manually
gnome-extensions disable claude-code-usage@SirAllap.github.io
gnome-extensions enable claude-code-usage@SirAllap.github.io
```

### Label shows "CC·" (no data)

The cache is empty. Click the indicator and use **↺ Force Refresh**. The first fetch takes ~20 seconds as it launches a full Claude CLI session.

```bash
# Run fetcher manually to see errors
python3 ~/.local/share/claude-usage/fetch.py
```

### Popup window does not open

```bash
# Test directly
python3 ~/.local/share/claude-usage/popup.py

# Check GTK4 bindings
python3 -c "import gi; gi.require_version('Gtk','4.0'); from gi.repository import Gtk; print('OK')"

# Install if missing
sudo apt install python3-gi gir1.2-gtk-4.0
```

### Reset time shows raw string instead of formatted date

The system locale may use non-English AM/PM strings. The parser strips `am`/`pm` manually and converts to 24h internally, so this should not occur. If it does, file an issue with the raw `resetTime` value from:

```bash
cat /tmp/claude_usage.json
```

---

## Compatibility

| Component | Tested on |
|---|---|
| GNOME Shell | 46 (Ubuntu 24.04 / SlimbookOS 24) |
| Python | 3.10, 3.12 |
| Claude CLI | 2.x |
| Session type | Wayland, X11 |

---

## License

MIT — see [LICENSE](LICENSE).
