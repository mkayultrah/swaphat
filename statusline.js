#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const APP = process.env.CLAUDE_SWAP_HOME || __dirname;
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const norm = p => {
  const s = path.resolve(String(p).replace(/^~(?=$|[\\/])/, os.homedir())).replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? s.toLowerCase() : s;
};

function render(j, now = Date.now()) {
  const c = readJson(path.join(APP, 'config.json'), { accounts: [] });
  const s = readJson(path.join(APP, 'state.json'), {});
  const dir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  const i = (c.accounts || []).findIndex(a => norm(a.dir) === norm(dir));
  const acct = i < 0 ? { name: '?', colour: '37' } : c.accounts[s.swapped ? 1 - i : i];

  const esc = (code, t) => `\x1b[${code}m${t}\x1b[0m`;
  const pctColour = p => (p >= 90 ? '31' : p >= 70 ? '33' : '32');
  const left = r => {
    if (r == null) return '';
    const t = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : Date.parse(r);
    if (!t || isNaN(t)) return '';
    const mins = Math.round((t - now) / 60000);
    if (mins <= 0) return '';
    if (mins < 60) return ` ${mins}m`;
    const h = Math.floor(mins / 60);
    return h < 24 ? ` ${h}h${String(mins % 60).padStart(2, '0')}` : ` ${Math.floor(h / 24)}d${h % 24}h`;
  };

  const parts = [esc(`1;${acct.colour || '37'}`, acct.name) + (s.auto ? esc('2', ' auto') : '')];
  const rl = j.rate_limits || {};
  for (const [key, short] of [['five_hour', '5h'], ['seven_day', '7d']]) {
    const w = rl[key];
    if (!w) continue;
    let p = w.used_percentage ?? w.utilization ?? w.used_percent;
    if (p == null) continue;
    if (p <= 1 && w.utilization != null) p *= 100;
    p = Math.round(p);
    parts.push(`${short} ${esc(pctColour(p), p + '%')}${esc('2', left(w.resets_at))}`);
  }
  if (!rl.five_hour && !rl.seven_day) parts.push(esc('2', 'usage after first reply'));
  const cw = j.context_window || {};
  if (cw.used_percentage != null) parts.push(esc('2', `ctx ${Math.round(cw.used_percentage)}%`));
  return parts.join(esc('2', ' | '));
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', d => (raw += d));
  process.stdin.on('end', () => {
    let j = {};
    try { j = JSON.parse(raw); } catch {}
    process.stdout.write(render(j));
  });
}

module.exports = { render };
