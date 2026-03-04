#!/usr/bin/env python3
"""
ccusage-gnome Background Fetcher

Spawns the CLI in a PTY, sends /usage, parses the TUI output,
and writes structured JSON to /tmp/ccusage_usage.json.

Polls cleaned output until usage data appears, then exits —
typically ~6-8 seconds instead of a fixed sleep.
"""

from __future__ import annotations

import json
import os
import pty
import re
import select
import subprocess
import sys
import threading
import time
from datetime import datetime
from pathlib import Path


CACHE_FILE    = Path("/tmp/ccusage_usage.json")
LOCK_FILE     = Path("/tmp/ccusage_fetch.lock")
TOKEN_CACHE   = Path("/tmp/ccusage_tokens.json")
PROJECTS_DIR  = Path.home() / ".claude" / "projects"
CLI_PATH      = Path.home() / ".local/bin/claude"
EXIT_WAIT     = 0.8   # seconds to wait after /exit before killing
TOKEN_TTL     = 120   # seconds before recomputing token stats


# =============================================================================
# LOCK
# =============================================================================

def acquire_lock() -> bool:
    if LOCK_FILE.exists():
        try:
            pid = int(LOCK_FILE.read_text().strip())
            os.kill(pid, 0)
            return False  # still running
        except (ProcessLookupError, ValueError, OSError):
            pass          # stale lock
    LOCK_FILE.write_text(str(os.getpid()))
    return True


def release_lock() -> None:
    try:
        LOCK_FILE.unlink(missing_ok=True)
    except Exception:
        pass


# =============================================================================
# ANSI CLEANING
# =============================================================================

def clean_ansi(raw: str) -> str:
    s = raw
    s = re.sub(r'\x1b\[\d*C', ' ', s)                    # cursor-right → space
    s = re.sub(r'\x1b\[\d+;\d+H', '\n', s)               # cursor-position → newline
    s = re.sub(r'\x1b\[(\d+)(am|pm)', r'\1\2', s, flags=re.IGNORECASE)  # protect am/pm from CSI eating
    s = re.sub(r'\x1b\[[^A-Za-z]*[A-Za-z]', '', s)       # remaining CSI sequences
    s = re.sub(r'\x1b\][^\x07]*\x07', '', s)         # OSC sequences
    s = re.sub(r'[█▉▊▋▌▍▎▏░▒▓▐▛▜▝▘▗▖▞▟]', '', s)  # block / bar chars
    s = s.replace('\r', '\n').replace('\t', ' ')
    s = re.sub(r' {2,}', ' ', s)
    lines = [l.strip() for l in s.split('\n') if l.strip()]
    return '\n'.join(lines)


# =============================================================================
# PARSING
# =============================================================================

def parse_usage(text: str) -> dict:
    result: dict = {
        "session":    None,
        "week":       None,
        "weekSonnet": None,
        "extra":      None,
        "timestamp":  int(time.time() * 1000),
        "fromCache":  False,
    }
    pct_matches = re.findall(r'(\d+)\s*%\s*used', text, re.IGNORECASE)
    reset_matches = re.findall(
        r'Rese\w*\s+([\w\d,: ]+\([\w\/]+\))', text, re.IGNORECASE
    )
    spend_match = re.search(
        r'\$(\d+\.?\d*)\s*/\s*\$(\d+\.?\d*)\s*spent', text, re.IGNORECASE
    )
    sections = ["session", "week", "weekSonnet", "extra"]
    for idx, key in enumerate(sections[:len(pct_matches)]):
        result[key] = {"percent": int(pct_matches[idx])}
        if idx < len(reset_matches):
            rt = reset_matches[idx].strip()
            rt = re.sub(r'^[a-z]{1,2}\s+', '', rt, flags=re.IGNORECASE)
            rt = re.sub(r'\s+', ' ', rt)
            result[key]["resetTime"] = rt
    if result["extra"] and spend_match:
        result["extra"]["spent"] = float(spend_match.group(1))
        result["extra"]["limit"] = float(spend_match.group(2))
    return result


# =============================================================================
# PTY FETCH
# =============================================================================

def fetch_via_pty() -> dict:
    if not CLI_PATH.exists():
        raise FileNotFoundError(f"CLI not found at {CLI_PATH}")

    chunks: list[str] = []
    lock = threading.Lock()

    master, slave = pty.openpty()

    env = dict(os.environ)
    env.update({"NO_COLOR": "1", "FORCE_COLOR": "0",
                "TERM": "xterm-256color", "COLUMNS": "120", "LINES": "80"})
    # Prevent "nested session" error when running inside an active session
    for var in ("CLAUDECODE", "CLAUDE_SESSION_ID", "ANTHROPIC_CLAUDE_CODE"):
        env.pop(var, None)

    proc = subprocess.Popen(
        [str(CLI_PATH), "--dangerously-skip-permissions"],
        stdin=slave, stdout=slave, stderr=slave,
        close_fds=True, cwd="/tmp", env=env,
    )
    os.close(slave)

    def _read_loop() -> None:
        while True:
            try:
                r, _, _ = select.select([master], [], [], 0.5)
                if r:
                    data = os.read(master, 4096)
                    with lock:
                        chunks.append(data.decode("utf-8", errors="replace"))
            except OSError:
                break

    threading.Thread(target=_read_loop, daemon=True).start()

    def _write(data: bytes) -> None:
        try:
            os.write(master, data)
        except OSError:
            pass

    def _cleaned() -> str:
        with lock:
            return clean_ansi("".join(chunks))

    def _wait_for(pattern: str, timeout: float) -> bool:
        """Wait until pattern appears in cleaned output, or timeout fires."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            if re.search(pattern, _cleaned()):
                return True
            time.sleep(0.2)
        return False

    try:
        # Wait for the prompt — "bypass permissions on" signals the CLI is ready
        _wait_for(r"bypass permissions", timeout=8.0)
        time.sleep(0.1)

        # Type /usage; autocomplete appears on first Enter, executes on second
        _write(b"/usage")
        time.sleep(0.4)
        _write(b"\r")
        time.sleep(0.4)
        _write(b"\r")

        # Exit as soon as usage data is visible in output
        _wait_for(r"\d+\s*%\s*used", timeout=12.0)
        time.sleep(0.2)

        _write(b"/exit\r")
        time.sleep(EXIT_WAIT)
    except OSError:
        pass

    try:
        proc.wait(timeout=3)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()
    try:
        os.close(master)
    except OSError:
        pass

    return parse_usage(_cleaned())


# =============================================================================
# CACHE
# =============================================================================

def load_cache() -> dict | None:
    try:
        return json.loads(CACHE_FILE.read_text())
    except Exception:
        return None


def save_cache(data: dict) -> None:
    CACHE_FILE.write_text(json.dumps(data, indent=2))


# =============================================================================
# TOKEN ANALYTICS
# =============================================================================

def compute_today_tokens() -> None:
    """Scan today's JSONL session files and write /tmp/ccusage_tokens.json."""
    try:
        cache = json.loads(TOKEN_CACHE.read_text())
        if time.time() - cache.get("timestamp", 0) < TOKEN_TTL:
            return  # still fresh
    except Exception:
        pass

    if not PROJECTS_DIR.is_dir():
        return

    today       = datetime.now().date()
    today_start = datetime.combine(today, datetime.min.time()).timestamp()

    stats: dict = {
        "input_tokens": 0, "output_tokens": 0,
        "cache_read_tokens": 0, "cache_write_tokens": 0,
        "session_count": 0, "message_count": 0, "user_msg_count": 0,
        "tool_call_count": 0, "thinking_blocks": 0,
        "web_search_count": 0, "web_fetch_count": 0,
        "turn_duration_ms": 0, "turn_count": 0,
        "models": {}, "tools": {},
    }
    sessions: set[str] = set()

    for f in PROJECTS_DIR.glob("*/*.jsonl"):
        try:
            if f.stat().st_mtime < today_start:
                continue
        except OSError:
            continue
        for line in f.open(encoding="utf-8", errors="replace"):
            if '"_progress"' in line:
                continue
            if '"progress"' in line and '"system"' not in line:
                continue
            if '"file-history-snapshot"' in line or '"queue-operation"' in line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            ts_str = entry.get("timestamp", "")
            if not ts_str:
                continue
            try:
                utc_dt = datetime.fromisoformat(ts_str.replace("Z", "+00:00"))
                if utc_dt.astimezone().date() != today:
                    continue
            except Exception:
                continue
            sid = entry.get("sessionId", "")
            if sid:
                sessions.add(sid)
            entry_type = entry.get("type")
            if entry_type == "assistant":
                msg   = entry.get("message", {})
                usage = msg.get("usage")
                if not usage:
                    continue
                stats["input_tokens"]       += usage.get("input_tokens", 0)
                stats["output_tokens"]      += usage.get("output_tokens", 0)
                stats["cache_read_tokens"]  += usage.get("cache_read_input_tokens", 0)
                stats["cache_write_tokens"] += usage.get("cache_creation_input_tokens", 0)
                stats["message_count"]      += 1
                model = msg.get("model", "unknown")
                md = stats["models"].setdefault(model, {
                    "count": 0, "input": 0, "output": 0, "cache_read": 0, "cache_write": 0,
                })
                md["count"]       += 1
                md["input"]       += usage.get("input_tokens", 0)
                md["output"]      += usage.get("output_tokens", 0)
                md["cache_read"]  += usage.get("cache_read_input_tokens", 0)
                md["cache_write"] += usage.get("cache_creation_input_tokens", 0)
                stu = usage.get("server_tool_use")
                if stu:
                    stats["web_search_count"] += stu.get("web_search_requests", 0)
                    stats["web_fetch_count"]  += stu.get("web_fetch_requests", 0)
                for block in msg.get("content", []):
                    if not isinstance(block, dict):
                        continue
                    btype = block.get("type")
                    if btype == "thinking":
                        stats["thinking_blocks"] += 1
                    elif btype == "tool_use":
                        stats["tool_call_count"] += 1
                        name = block.get("name", "unknown")
                        stats["tools"][name] = stats["tools"].get(name, 0) + 1
            elif entry_type == "user":
                stats["user_msg_count"] += 1
            elif entry_type == "system" and entry.get("subtype") == "turn_duration":
                stats["turn_duration_ms"] += entry.get("durationMs", 0)
                stats["turn_count"]       += 1

    stats["session_count"] = len(sessions)
    stats["timestamp"]     = time.time()

    if stats["message_count"] > 0:
        try:
            TOKEN_CACHE.write_text(json.dumps(stats))
        except Exception:
            pass


# =============================================================================
# MAIN
# =============================================================================

def main() -> None:
    if not acquire_lock():
        sys.exit(0)
    try:
        data = fetch_via_pty()
        if data.get("session") or data.get("week"):
            save_cache(data)
        else:
            old = load_cache()
            if old:
                old["fromCache"] = True
                save_cache(old)
        compute_today_tokens()
    except Exception as e:
        print(f"[ccusage-fetch] {e}", file=sys.stderr)
        old = load_cache()
        if old:
            old["fromCache"] = True
            save_cache(old)
    finally:
        release_lock()


if __name__ == "__main__":
    main()
