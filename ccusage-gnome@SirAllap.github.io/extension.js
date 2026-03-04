import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

const CACHE_FILE   = '/tmp/ccusage_usage.json';
const TOKEN_CACHE  = '/tmp/ccusage_tokens.json';
const LOCK_FILE    = '/tmp/ccusage_fetch.lock';
// Set at runtime from this.path so the extension is fully self-contained
let FETCH_SCRIPT = '';

const CACHE_TTL    = 90;    // seconds before triggering a background refresh
const TOKEN_TTL    = 480;   // seconds before token cache is too stale to show
const POLL_SECS    = 1;     // poll interval while fetch.py is running
const REFRESH_SECS = 30;    // idle re-render interval

// Catppuccin Mocha palette
const C = {
    purple: '#cba6f7',
    white:  '#cdd6f4',
    dim:    '#6c7086',
    green:  '#a6e3a1',
    yellow: '#f9e2af',
    red:    '#f38ba8',
    cyan:   '#89dceb',
};

const MONTHS = { jan:0, feb:1, mar:2, apr:3, may:4, jun:5, jul:6, aug:7, sep:8, oct:9, nov:10, dec:11 };

// [input, output, cache_read, cache_write] price per million tokens (USD)
const MODEL_PRICING = {
    'claude-opus-4-6':           [15.0,  75.0, 1.875, 18.75],
    'claude-sonnet-4-6':         [ 3.0,  15.0, 0.30,   3.75],
    'claude-haiku-4-5-20251001': [ 0.80,  4.0, 0.08,   1.00],
};

export default class CcusageGnomeExtension extends Extension {

    // =========================================================================
    // Lifecycle
    // =========================================================================

    enable() {
        FETCH_SCRIPT = `${this.path}/fetch.py`;
        this._timer     = null;
        this._pollTimer = null;

        this._indicator = new PanelMenu.Button(0.5, 'ccusage-gnome', false);

        const gicon = Gio.icon_new_for_string(`${this.path}/icons/ccusage.svg`);
        this._icon = new St.Icon({
            gicon,
            icon_size: 16,
            y_align: Clutter.ActorAlign.CENTER,
            style: 'margin: 0 2px 0 4px;',
        });

        this._label = new St.Label({
            y_align: Clutter.ActorAlign.CENTER,
            style: 'font-size: 12px; margin: 0 4px 0 0;',
        });
        this._label.clutter_text.use_markup = true;
        this._label.clutter_text.set_markup(`<span foreground="${C.dim}">CC…</span>`);

        const box = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER });
        box.add_child(this._icon);
        box.add_child(this._label);
        this._indicator.add_child(box);

        this._buildMenu();

        // Refresh data every time the dropdown is opened
        this._indicator.menu.connect('open-state-changed', (_menu, open) => {
            if (open) this._update();
        });

        Main.panel.addToStatusArea(this.uuid, this._indicator);
        this._update();

        // Periodic idle re-render to keep the label fresh
        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, REFRESH_SECS, () => {
            this._update();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        [this._timer, this._pollTimer].forEach(t => { if (t) GLib.source_remove(t); });
        this._timer = this._pollTimer = null;
        this._indicator?.destroy();
        this._indicator = this._icon = this._label = this._detailsLabel = this._footerLabel = null;
    }

    // =========================================================================
    // Menu construction
    // =========================================================================

    _buildMenu() {
        const menu = this._indicator.menu;

        // Header
        const hdrItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        const hdrLabel = new St.Label({ style: 'font-size: 13px; font-weight: bold;' });
        hdrLabel.clutter_text.use_markup = true;
        hdrLabel.clutter_text.set_markup(`<span foreground="${C.purple}"><b>CC Usage</b></span>`);
        hdrItem.add_child(hdrLabel);
        menu.addMenuItem(hdrItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Main content block — single markup label in monospace
        const detailItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._detailsLabel = new St.Label({
            x_expand: true,
            style: 'font-size: 12px; font-family: monospace;',
        });
        this._detailsLabel.clutter_text.use_markup = true;
        this._detailsLabel.clutter_text.line_wrap  = false;
        this._detailsLabel.clutter_text.set_markup(`<span foreground="${C.dim}">Loading…</span>`);
        detailItem.add_child(this._detailsLabel);
        menu.addMenuItem(detailItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Footer — timestamp + hint
        const footerItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false });
        this._footerLabel = new St.Label({
            x_expand: true,
            style: 'font-size: 11px; font-family: monospace;',
        });
        this._footerLabel.clutter_text.use_markup = true;
        this._footerLabel.clutter_text.set_markup(`<span foreground="${C.dim}">—</span>`);
        footerItem.add_child(this._footerLabel);
        menu.addMenuItem(footerItem);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        // Force-refresh action
        const refreshItem = new PopupMenu.PopupMenuItem('↺  Force Refresh');
        refreshItem.connect('activate', () => this._onRefresh());
        menu.addMenuItem(refreshItem);
    }

    // =========================================================================
    // Data helpers
    // =========================================================================

    _readFile(path) {
        try {
            const [ok, bytes] = Gio.File.new_for_path(path).load_contents(null);
            if (ok) return new TextDecoder().decode(bytes);
        } catch (_) {}
        return null;
    }

    _loadCache() {
        const txt = this._readFile(CACHE_FILE);
        if (!txt) return null;
        try { return JSON.parse(txt); } catch (_) { return null; }
    }

    _loadTokenCache() {
        const txt = this._readFile(TOKEN_CACHE);
        if (!txt) return null;
        try {
            const d = JSON.parse(txt);
            if ((Date.now() / 1000 - (d.timestamp || 0)) < TOKEN_TTL) return d;
        } catch (_) {}
        return null;
    }

    _isStale(data) {
        if (!data) return true;
        return (Date.now() / 1000 - (data.timestamp ?? 0) / 1000) > CACHE_TTL;
    }

    _isFetchRunning() {
        const txt = this._readFile(LOCK_FILE);
        if (!txt) return false;
        const pid = parseInt(txt.trim(), 10);
        if (!pid || pid <= 0) return false;
        // On Linux, /proc/<pid> exists iff the process is alive
        return Gio.File.new_for_path(`/proc/${pid}`).query_exists(null);
    }

    // fetch.py is a Python helper because GJS has no PTY API. The CLI's
    // /usage command requires an interactive pseudo-terminal session to produce
    // output — something that cannot be done from GJS directly.
    _spawnFetch() {
        try {
            Gio.Subprocess.new(
                ['python3', FETCH_SCRIPT],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE
            );
        } catch (e) {
            console.error(`[ccusage-gnome] spawn fetch: ${e}`);
        }
    }

    // =========================================================================
    // Update cycle
    // =========================================================================

    _update() {
        const data    = this._loadCache();
        const active  = this._isFetchRunning();
        const spawned = this._isStale(data) && !active;
        if (spawned) this._spawnFetch();
        if (active || spawned) this._startPolling();
        this._render(data, active || spawned);
    }

    _startPolling() {
        if (this._pollTimer) return;
        this._pollTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECS, () => {
            const fetching = this._isFetchRunning();
            this._render(this._loadCache(), fetching);
            if (!fetching) {
                this._pollTimer = null;
                return GLib.SOURCE_REMOVE;
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    // =========================================================================
    // Time / budget helpers
    // =========================================================================

    /**
     * Parse a resetTime string like "Mar 6, 6:59am (Europe/Madrid)" or "2pm (UTC)"
     * and return milliseconds until that moment, correctly honouring the timezone.
     */
    _parseResetMs(resetStr) {
        if (!resetStr) return null;

        // Extract named timezone; fall back to UTC
        const tzMatch = resetStr.match(/\(([\w/]+)\)/);
        const tzName  = tzMatch ? tzMatch[1] : 'UTC';
        let tz;
        try        { tz = GLib.TimeZone.new_identifier(tzName); }
        catch (_)  { tz = GLib.TimeZone.new_utc(); }

        // Strip timezone annotation, normalise broken "6:59 a m" → "6:59am"
        const clean = resetStr.replace(/\s*\([^)]*\)/, '').trim()
                               .replace(/(\d)\s+([ap])\s*m\b/gi, '$1$2m');
        const suffix = clean.match(/([ap])m$/i);
        const isPm   = suffix && suffix[1].toLowerCase() === 'p';
        const base   = clean.replace(/\s*[ap]m\s*$/i, '').trim();
        const h24    = h => (h % 12) + (isPm ? 12 : 0);
        const now    = GLib.DateTime.new_now(tz);
        let dt = null, m;

        // "Mar 6, 6:59" — full date + time
        m = base.match(/^([A-Za-z]{3})\w*\s+(\d+),\s+(\d+):(\d+)$/);
        if (m) {
            const mon = MONTHS[m[1].toLowerCase()];
            if (mon !== undefined) {
                dt = GLib.DateTime.new(tz, now.get_year(), mon + 1, +m[2], h24(+m[3]), +m[4], 0);
                if (dt && dt.compare(now) <= 0)
                    dt = GLib.DateTime.new(tz, now.get_year() + 1, mon + 1, +m[2], h24(+m[3]), +m[4], 0);
            }
        }

        // "Mar 6, 7" — date + hour only (no minutes)
        if (!dt) {
            m = base.match(/^([A-Za-z]{3})\w*\s+(\d+),\s+(\d+)$/);
            if (m) {
                const mon = MONTHS[m[1].toLowerCase()];
                if (mon !== undefined) {
                    dt = GLib.DateTime.new(tz, now.get_year(), mon + 1, +m[2], h24(+m[3]), 0, 0);
                    if (dt && dt.compare(now) <= 0)
                        dt = GLib.DateTime.new(tz, now.get_year() + 1, mon + 1, +m[2], h24(+m[3]), 0, 0);
                }
            }
        }

        // "6:59" — time only, assumed today
        if (!dt) {
            m = base.match(/^(\d+):(\d+)$/);
            if (m) {
                dt = GLib.DateTime.new(tz, now.get_year(), now.get_month(),
                                       now.get_day_of_month(), h24(+m[1]), +m[2], 0);
                if (dt && dt.compare(now) <= 0) dt = dt.add_days(1);
            }
        }

        // "2" — hour only, assumed today
        if (!dt) {
            m = base.match(/^(\d+)$/);
            if (m) {
                dt = GLib.DateTime.new(tz, now.get_year(), now.get_month(),
                                       now.get_day_of_month(), h24(+m[1]), 0, 0);
                if (dt && dt.compare(now) <= 0) dt = dt.add_days(1);
            }
        }

        if (!dt) return null;
        // now.difference(dt) = now − dt in µs; negate → dt − now → milliseconds
        return -now.difference(dt) / 1000;
    }

    _formatCountdown(ms) {
        if (ms === null || ms <= 0) return '';
        const totalMin = Math.floor(ms / 60000);
        const days  = Math.floor(totalMin / 1440);
        const hours = Math.floor((totalMin % 1440) / 60);
        const mins  = totalMin % 60;
        if (days > 0)  return `${days}d${hours}h`;
        if (hours > 0) return `${hours}h${mins}m`;
        return `${mins}m`;
    }

    /**
     * Compute weekly budget tracking info for a usage section.
     * Returns { filled (0-7), currentDay, cumulative, actual, color } or null.
     */
    _budgetInfo(section) {
        if (!section?.resetTime) return null;
        const ms = this._parseResetMs(section.resetTime);
        if (ms === null) return null;
        const resetMs    = Date.now() + ms;
        const cycleStart = resetMs - 7 * 86400 * 1000;
        const elapsed    = (Date.now() - cycleStart) / 86400000;
        const currentDay = Math.max(1, Math.min(7, Math.floor(elapsed) + 1));
        const cumulative = 100 / 7 * currentDay;
        const actual     = section.percent ?? 0;
        const ratio      = cumulative > 0 ? (actual / cumulative * 100) : 0;
        const filled     = Math.max(0, Math.min(7, Math.round(ratio / 100 * 7)));
        const color      = ratio > 85 ? C.red : ratio > 60 ? C.yellow : C.green;
        return { filled, currentDay, cumulative, actual, color };
    }

    // =========================================================================
    // Rendering helpers
    // =========================================================================

    _pctColor(pct) {
        if (pct >= 90) return C.red;
        if (pct >= 75) return C.yellow;
        return C.green;
    }

    _bar(pct, width = 20) {
        pct = Math.max(0, Math.min(100, pct));
        const filled = Math.round(pct / 100 * width);
        const color  = this._pctColor(pct);
        return (
            `<span foreground="${color}">${'█'.repeat(filled)}</span>` +
            `<span foreground="${C.dim}">${'░'.repeat(width - filled)}</span>`
        );
    }

    _budgetBarStr(info) {
        if (!info) return `<span foreground="${C.dim}">${'▱'.repeat(7)}</span>`;
        return (
            `<span foreground="${info.color}">${'▰'.repeat(info.filled)}</span>` +
            `<span foreground="${C.dim}">${'▱'.repeat(7 - info.filled)}</span>`
        );
    }

    _fmt(n) {
        if (!n || n < 1000) return String(n || 0);
        if (n < 1e6)  return `${(n / 1000).toFixed(1)}K`;
        return `${(n / 1e6).toFixed(1)}M`;
    }

    _shortModel(model) {
        if (model.includes('opus'))   return 'Opus';
        if (model.includes('sonnet')) return 'Sonnet';
        if (model.includes('haiku'))  return 'Haiku';
        return model;
    }

    _estimateCost(tokens) {
        let total = 0;
        for (const [model, data] of Object.entries(tokens.models || {})) {
            const pricing = MODEL_PRICING[model];
            if (!pricing) continue;
            const [inp, out, cr, cw] = pricing;
            total += (data.input       || 0) / 1e6 * inp;
            total += (data.output      || 0) / 1e6 * out;
            total += (data.cache_read  || 0) / 1e6 * cr;
            total += (data.cache_write || 0) / 1e6 * cw;
        }
        return total;
    }

    // =========================================================================
    // Full render
    // =========================================================================

    _render(data, fetching) {
        if (!data) {
            this._label.clutter_text.set_markup(
                `<span foreground="${C.dim}">${fetching ? 'CC…' : 'CC·'}</span>`
            );
            this._detailsLabel.clutter_text.set_markup(
                `<span foreground="${C.dim}">${fetching ? 'Fetching… (~20 s first run)' : 'No data — use Force Refresh'}</span>`
            );
            this._footerLabel.clutter_text.set_markup(`<span foreground="${C.dim}">—</span>`);
            return;
        }

        const { session, week, weekSonnet: sonnet, extra } = data;

        // ---- Panel label: "◆ 1% ↺4h0m ▰▰▰▱▱▱▱" ----
        // session % = 5h window consumed
        // countdown = time remaining until session resets
        // mini bar  = weekly all-models budget (7 blocks)
        const sPct      = session?.percent ?? 0;
        const sessMs    = this._parseResetMs(session?.resetTime);
        const countdown = sessMs !== null
            ? ` <span foreground="${C.dim}">↺${this._formatCountdown(sessMs)}</span>`
            : '';
        const bInfo   = this._budgetInfo(week);
        const miniBar = bInfo
            ? ` <span foreground="${bInfo.color}">${'▰'.repeat(bInfo.filled)}</span>` +
              `<span foreground="${C.dim}">${'▱'.repeat(7 - bInfo.filled)}</span>`
            : '';

        this._label.clutter_text.set_markup(
            `<span foreground="${this._pctColor(sPct)}">${sPct}%</span>` +
            countdown + miniBar
        );

        // ---- Dropdown content ----
        const lines = [];
        const sep   = `<span foreground="${C.dim}">${'─'.repeat(38)}</span>`;

        for (const [label, s, showBudget] of [
            ['Session  (5h rolling)', session, false],
            ['Weekly   (all models)', week,    true],
            ['Weekly   (Sonnet)',     sonnet,  true],
        ]) {
            if (!s) continue;
            const pct   = s.percent ?? 0;
            const color = this._pctColor(pct);
            const reset = s.resetTime ? s.resetTime.replace(/\s*\([^)]*\)/, '').trim() : '';

            lines.push(`<span foreground="${C.purple}">${label}</span>`);
            lines.push(`  [${this._bar(pct)}] <span foreground="${color}">${pct}%</span>`);
            if (reset) {
                const ms = this._parseResetMs(s.resetTime);
                const cd = ms !== null ? `  ↺${this._formatCountdown(ms)}` : '';
                lines.push(`  <span foreground="${C.dim}">Resets: ${reset}${cd}</span>`);
            }

            if (showBudget) {
                const bi = this._budgetInfo(s);
                if (bi) {
                    lines.push(
                        `  <span foreground="${bi.color}">Day ${bi.currentDay}/7` +
                        ` · Budget: ${Math.round(bi.cumulative)}%` +
                        ` · Used: ${bi.actual}%</span>`
                    );
                    lines.push(`  ${this._budgetBarStr(bi)}`);
                }
            }
            lines.push('');
        }

        // Extra spend (pay-as-you-go tier)
        if (extra) {
            const pct   = extra.percent ?? 0;
            const color = this._pctColor(pct);
            lines.push(`<span foreground="${C.purple}">Extra spend</span>`);
            lines.push(`  [${this._bar(pct)}] <span foreground="${color}">${pct}%</span>`);
            if (extra.spent !== undefined && extra.limit)
                lines.push(`  <span foreground="${color}">$${extra.spent.toFixed(2)} / $${extra.limit.toFixed(2)} spent</span>`);
            lines.push('');
        }

        // Today's token stats (populated by fetch.py on each refresh)
        const tokens = this._loadTokenCache();
        if (tokens?.message_count > 0) {
            lines.push(sep);
            const totalMsgs = (tokens.message_count || 0) + (tokens.user_msg_count || 0);
            const toolStr   = (tokens.tool_call_count || 0) > 0
                ? `, ${tokens.tool_call_count} tools` : '';
            lines.push(
                `<span foreground="${C.purple}">Today's Tokens</span>` +
                `  <span foreground="${C.dim}">${tokens.session_count} sessions, ${totalMsgs} msgs${toolStr}</span>`
            );

            // Model breakdown + avg turn time
            const models     = tokens.models || {};
            const modelParts = Object.keys(models)
                .sort((a, b) => models[b].count - models[a].count)
                .map(m => `${this._shortModel(m)} ${models[m].count}`);
            let avgTurn = '';
            const turnCount = tokens.turn_count || 0;
            if (turnCount > 0) {
                const avgS = tokens.turn_duration_ms / turnCount / 1000;
                avgTurn = avgS >= 60
                    ? ` · avg turn ${Math.floor(avgS / 60)}m${Math.floor(avgS % 60)}s`
                    : ` · avg turn ${Math.round(avgS)}s`;
            }
            if (modelParts.length > 0)
                lines.push(`  <span foreground="${C.dim}">${modelParts.join(' · ')}${avgTurn}</span>`);

            // Top 5 tools
            const tools     = tokens.tools || {};
            const toolParts = Object.entries(tools)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 5)
                .map(([name, count]) => `${name} ${count}`);
            if (toolParts.length > 0)
                lines.push(`  <span foreground="${C.dim}">${toolParts.join(' · ')}</span>`);

            // Tokens in/out + optional thinking indicator
            const thinking = (tokens.thinking_blocks || 0) > 0
                ? `   <span foreground="${C.purple}">◆ ${tokens.thinking_blocks}</span>` : '';
            lines.push(
                `  <span foreground="${C.cyan}">↓ ${this._fmt(tokens.input_tokens)} in</span>` +
                `   <span foreground="${C.green}">↑ ${this._fmt(tokens.output_tokens)} out</span>` +
                thinking
            );

            // Cache read/write + hit ratio
            const cacheRead  = tokens.cache_read_tokens  || 0;
            const cacheWrite = tokens.cache_write_tokens || 0;
            if (cacheRead > 0 || cacheWrite > 0) {
                const ratio = cacheWrite > 0 ? ` (${(cacheRead / cacheWrite).toFixed(1)}:1)` : '';
                lines.push(
                    `  <span foreground="${C.dim}">Cache: ${this._fmt(cacheRead)} read` +
                    ` · ${this._fmt(cacheWrite)} written${ratio}</span>`
                );
            }

            // Web tool usage
            const webParts = [];
            if ((tokens.web_search_count || 0) > 0) webParts.push(`${tokens.web_search_count} searches`);
            if ((tokens.web_fetch_count  || 0) > 0) webParts.push(`${tokens.web_fetch_count} fetches`);
            if (webParts.length > 0)
                lines.push(`  <span foreground="${C.dim}">Web: ${webParts.join(' · ')}</span>`);

            // Estimated cost
            const cost = this._estimateCost(tokens);
            if (cost > 0)
                lines.push(`  <span foreground="${C.yellow}">Est. cost: ~$${cost.toFixed(2)}</span>`);

            lines.push('');
        }

        this._detailsLabel.clutter_text.set_markup(lines.join('\n').trimEnd());

        // Footer
        const age    = Math.round(Date.now() / 1000 - (data.timestamp ?? 0) / 1000);
        const cached = data.fromCache ? ' (cached)' : '';
        const status = fetching ? 'fetching…' : `updated ${age}s ago${cached}`;
        this._footerLabel.clutter_text.set_markup(
            `<span foreground="${C.dim}">${status}</span>`
        );
    }

    // =========================================================================
    // Actions
    // =========================================================================

    _onRefresh() {
        try { Gio.File.new_for_path(CACHE_FILE).delete(null); } catch (_) {}
        try { Gio.File.new_for_path(TOKEN_CACHE).delete(null); } catch (_) {}
        if (!this._isFetchRunning()) {
            this._spawnFetch();
            this._startPolling();
        }
        this._render(null, true);
    }
}
