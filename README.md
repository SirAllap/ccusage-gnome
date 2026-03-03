# ccusage-gnome

A GNOME Shell extension that shows your **Claude Code API usage** directly in the top bar — session %, time to reset, weekly budget tracking, and today's full token analytics — all without leaving your desktop.

---

## Features

- **Top bar at a glance** — session % consumed, countdown to reset, weekly budget bar (7-day pace)
- **Detailed dropdown** — progress bars for Session (5h rolling), Weekly (all models), Weekly (Sonnet), with Day X/7 budget tracking
- **Today's token analytics** — input/output tokens, cache stats + hit ratio, model breakdown, avg turn time, top tools used, thinking blocks, web search/fetch counts, estimated cost
- **Extra spend tracking** — pay-as-you-go tier shown if applicable
- **Background refresh** — data fetched automatically, never blocking your workflow
- **Force refresh** — one click to clear cache and fetch fresh data immediately
- **No external services** — reads directly from the Claude CLI; no API keys required beyond your existing Claude Code login

---

## How It Works

```
┌──────────────────────────────────────────────────┐
│  GNOME Shell Extension (extension.js)            │
│  • Renders top bar label + dropdown              │
│  • Reads /tmp/claude_usage.json every 30s        │
│  • Reads /tmp/claude_tokens.json for token stats │
│  • Spawns fetch.py when cache is stale (>90s)    │
└──────────────────┬───────────────────────────────┘
                   │ spawns
                   ▼
┌──────────────────────────────────────────────────┐
│  fetch.py (Python — bundled with extension)      │
│  • Opens a PTY and launches claude CLI           │
│  • Sends /usage, parses TUI output               │
│  • Writes /tmp/claude_usage.json                 │
│  • Scans ~/.claude/projects/**/*.jsonl           │
│  • Writes /tmp/claude_tokens.json                │
└──────────────────────────────────────────────────┘
```

> **Why a Python script?** GJS (GNOME's JS engine) cannot open a PTY or run interactive terminal sessions. `fetch.py` handles this by spawning the Claude CLI in a pseudo-terminal and scraping its `/usage` output.

---

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| GNOME Shell | 45+ | Ubuntu 23.10+, Fedora 39+ |
| Python | 3.9+ | Standard library only, no extra packages needed |
| Claude CLI | any | Installed via Claude Code setup |

### Install Claude CLI

Follow the official guide: https://docs.anthropic.com/claude-code

The extension expects the Claude binary at `~/.local/bin/claude`.

---

## Installation

### Method 1: GNOME Extension Manager (recommended)

Install directly from [extensions.gnome.org](https://extensions.gnome.org) — no terminal required, no logout needed.

### Method 2: Install script

```bash
git clone https://github.com/SirAllap/ccusage-gnome.git
cd ccusage-gnome
./install.sh
```

On first install, GNOME Shell needs a session restart (Wayland limitation):

- **Wayland:** Log out and back in
- **X11:** Press `Alt+F2`, type `r`, press Enter

Then enable if needed:

```bash
gnome-extensions enable ccusage-gnome@SirAllap.github.io
```

Future updates via `install.sh` will hot-reload without a logout.

---

## Usage

### Top bar

```
[icon]  23%  ↺4h12m  ▰▰▰▱▱▱▱
         │     │        │
         │     │        └── Weekly budget bar (7 blocks = 7-day cycle)
         │     └─────────── Time remaining until session resets
         └───────────────── Session usage % (5h rolling window)
```

Percentage colour indicates urgency:

| Colour | Threshold |
|---|---|
| Green | < 75% |
| Yellow | 75–89% |
| Red | ≥ 90% |

### Dropdown

Click the indicator to open the detailed view:

- **Session (5h rolling)** — bar, %, reset time + countdown
- **Weekly (all models)** — bar, %, reset time, Day X/7 · Budget · Used, 7-block bar
- **Weekly (Sonnet)** — same as above
- **Extra spend** — shown if you have a pay-as-you-go tier
- **Today's Tokens** — sessions, messages, tool calls, model breakdown, avg turn time, top tools, tokens in/out, thinking blocks, cache read/write + ratio, web usage, estimated cost
- **Footer** — data age + fetch status
- **↺ Force Refresh** — clears cache and triggers an immediate fetch

---

## Uninstallation

```bash
./uninstall.sh
```

---

## File Structure

```
ccusage-gnome/
├── README.md
├── LICENSE
├── install.sh                              ← automated installer
├── uninstall.sh                            ← automated uninstaller
└── ccusage-gnome@SirAllap.github.io/      ← self-contained extension bundle
    ├── extension.js                        ← panel indicator + dropdown UI
    ├── fetch.py                            ← Claude CLI PTY fetcher + token analytics
    ├── metadata.json                       ← extension manifest
    └── icons/
        └── claude-color.png
```

**Runtime files (created automatically):**

```
/tmp/claude_usage.json      ← usage data cache (auto-cleared on reboot)
/tmp/claude_fetch.lock      ← fetch process lock
/tmp/claude_tokens.json     ← token analytics cache (auto-cleared on reboot)
```

---

## Development

### Reload after changes

```bash
./install.sh
```

Hot-reloads automatically if the extension was already active.

### Watch logs

```bash
journalctl -f -o cat /usr/bin/gnome-shell | grep -i ccusage
```

### Test fetch.py standalone

```bash
python3 ccusage-gnome@SirAllap.github.io/fetch.py
cat /tmp/claude_usage.json
cat /tmp/claude_tokens.json
```

### Build release zip

```bash
cd ccusage-gnome@SirAllap.github.io
zip -r ../ccusage-gnome.zip extension.js metadata.json fetch.py icons/claude-color.png
```

---

## Troubleshooting

### Extension not visible in the top bar

```bash
gnome-extensions info ccusage-gnome@SirAllap.github.io
journalctl -b -o cat /usr/bin/gnome-shell | grep -i "ccusage\|Extension error"
```

### Label shows "CC·" (no data)

Cache is empty. Click the indicator and use **↺ Force Refresh**. First fetch takes ~20 seconds as it launches a full Claude CLI session.

### Reset time or countdown looks wrong

The extension uses `GLib.TimeZone` to correctly parse the timezone in the reset string (e.g. `Europe/Madrid`). If the countdown still looks off, check your Claude CLI output:

```bash
cat /tmp/claude_usage.json | python3 -m json.tool
```

---

## Compatibility

| Component | Tested on |
|---|---|
| GNOME Shell | 46 (Ubuntu 24.04) |
| Python | 3.12, 3.14 |
| Claude CLI | 2.x |
| Session type | Wayland, X11 |

---

## License

MIT — see [LICENSE](LICENSE).
