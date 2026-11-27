#!/usr/bin/env node
'use strict';
const path = require('path');

const esc = (code, t) => `\x1b[${code}m${t}\x1b[0m`;
const pctColour = p => (p >= 90 ? '31' : p >= 70 ? '33' : '32');

function left(r, now) {
  if (r == null) return '';
  const t = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : Date.parse(r);
  if (!t || isNaN(t)) return '';
  const mins = Math.round((t - now) / 60000);
  if (mins <= 0) return '';
  if (mins < 60) return ` ${mins}m`;
  const h = Math.floor(mins / 60);
  return h < 24 ? ` ${h}h${String(mins % 60).padStart(2, '0')}` : ` ${Math.floor(h / 24)}d${h % 24}h`;
}

function render(j, now = Date.now()) {
  let info = null;
  try { info = require(path.join(__dirname, 'swap.js')).onStatus(j, now); } catch {}
  const cur = info && info.cur;
  const s = (info && info.s) || {};
  const name = cur ? cur.name : '?';
  const parts = [esc(`1;${(cur && cur.colour) || '37'}`, name) + (s.auto ? esc('2', ' auto') : '')];
  if (info && info.swapped) parts[0] = esc('2', `${info.swapped.from} -> `) + parts[0];

  const rl = (info && info.swapped) ? {} : (j.rate_limits || {});
  for (const [key, short] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = rl[key];
    if (!w) continue;
    let p = w.used_percentage ?? w.utilization ?? w.used_percent;
    if (p == null) continue;
    if (p <= 1 && w.utilization != null) p *= 100;
    p = Math.round(p);
    parts.push(`${short} ${esc(pctColour(p), p + '%')}${esc('2', left(w.resets_at, now))}`);
  }
  if (info && info.swapped) parts.push(esc('2', 'swapped before the limit'));
  else if (!rl.five_hour && !rl.seven_day) parts.push(esc('2', 'usage after first reply'));
  const cw = j.context_window || {};
  if (cw.used_percentage != null) parts.push(esc('2', `ctx ${Math.round(cw.used_percentage)}%`));
  return parts.join(esc('2', ' | '));
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', d => (raw += d));
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch {}
    process.stdout.write(render(j));
  });
}

module.exports = { render };
