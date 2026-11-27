#!/usr/bin/env node
'use strict';

const path = require('path');

const esc = (code, text) => `\x1b[${code}m${text}\x1b[0m`;

const pctColour = pct => {
  if (!Number.isFinite(pct)) return '37';
  if (pct >= 90) return '31';
  if (pct >= 70) return '33';
  return '32';
};

function left(resetAt, now) {
  if (resetAt == null) return '';
  const ts = typeof resetAt === 'number'
    ? (resetAt < 1e12 ? resetAt * 1000 : resetAt)
    : Date.parse(resetAt);
  if (!Number.isFinite(ts) || ts <= now) return '';

  const diffMs = ts - now;
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return ' <1m';
  if (mins < 60) return ` ${mins}m`;

  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) {
    return ` ${hours}h${String(remMins).padStart(2, '0')}`;
  }
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return ` ${days}d${remHours}h`;
}

function parsePct(win) {
  if (!win || typeof win !== 'object') return null;
  let raw = win.used_percentage ?? win.utilization ?? win.used_percent;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  if (raw <= 1 && typeof win.utilization === 'number') raw *= 100;
  return Math.max(0, Math.min(100, Math.round(raw)));
}

function formatWindow(shortLabel, win, now) {
  const pct = parsePct(win);
  if (pct === null) return null;
  const remaining = esc('2', left(win.resets_at, now));
  return `${shortLabel} ${esc(pctColour(pct), `${pct}%`)}${remaining}`;
}

function render(payload, now = Date.now()) {
  const j = payload && typeof payload === 'object' ? payload : {};

  let info = null;
  try {
    const swapMod = require(path.join(__dirname, 'swap.js'));
    if (typeof swapMod.onStatus === 'function') {
      info = swapMod.onStatus(j, now);
    }
  } catch {}

  const cur = info && info.cur ? info.cur : null;
  const s = info && info.s && typeof info.s === 'object' ? info.s : {};
  const name = cur && cur.name ? cur.name : '?';
  const colour = cur && cur.colour ? cur.colour : '37';

  let badge = esc(`1;${colour}`, name) + (s.auto ? esc('2', ' auto') : '');
  if (info && info.swapped && info.swapped.from) {
    badge = esc('2', `${info.swapped.from} -> `) + badge;
  }

  const parts = [badge];
  const rl = j.rate_limits && typeof j.rate_limits === 'object' ? j.rate_limits : {};

  const recent = s.lastSwap && cur && s.lastSwap.to === cur.name && now - (Number(s.lastSwap.at) || 0) < 60 * 1000;
  if (info && info.swapped) {
    parts.push(esc('32', `✓ swapped to ${name} before the limit`));
  } else if (recent && s.rlAtSwap) {
    parts.push(esc('32', `✓ swapped to ${name}`));
  } else {
    if (recent) parts.push(esc('32', `✓ swapped to ${name}`));
    let addedAny = false;
    for (const [key, shortLabel] of [['five_hour', '5h'], ['seven_day', '7d']]) {
      const formatted = formatWindow(shortLabel, rl[key], now);
      if (formatted) {
        parts.push(formatted);
        addedAny = true;
      }
    }
    if (!addedAny) {
      parts.push(esc('2', 'usage after first reply'));
    }
  }

  const cw = j.context_window && typeof j.context_window === 'object' ? j.context_window : null;
  if (cw && typeof cw.used_percentage === 'number' && Number.isFinite(cw.used_percentage)) {
    const ctxPct = Math.max(0, Math.min(100, Math.round(cw.used_percentage)));
    parts.push(esc('2', `ctx ${ctxPct}%`));
  }

  return parts.join(esc('2', ' | '));
}

if (require.main === module) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    raw += chunk;
  });
  process.stdin.on('end', () => {
    let parsed = {};
    try {
      const cleaned = raw.replace(/^\uFEFF/, '').trim();
      if (cleaned) parsed = JSON.parse(cleaned);
    } catch {}
    process.stdout.write(render(parsed));
  });
}

module.exports = { render, left, pctColour };
