#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const HOME = os.homedir();
const APP = process.env.CLAUDE_SWAP_HOME || __dirname;
const at = n => path.join(APP, n);
const AUTO_GUARD_MS = 5 * 60 * 1000;

const expand = p => path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME).replace(/%([^%]+)%/g, (_, v) => process.env[v] || ''));
const norm = p => { const s = expand(p).replace(/[\\/]+$/, ''); return process.platform === 'win32' ? s.toLowerCase() : s; };
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
function writeJson(p, o) {
  const t = `${p}.${process.pid}.swap-tmp`;
  fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode: 0o600 });
  fs.renameSync(t, p);
}
const log = m => { try { fs.appendFileSync(at('swap.log'), `${new Date().toISOString()} ${m}\n`); } catch {} };

function config() {
  const c = readJson(at('config.json'), null);
  if (!c || !Array.isArray(c.accounts) || c.accounts.length !== 2)
    throw new Error(`config.json missing or broken in ${APP}. Run the installer again.`);
  return c;
}
const state = () => readJson(at('state.json'), { swapped: false, auto: false });
const saveState = s => writeJson(at('state.json'), s);

const defaultDir = () => path.join(HOME, '.claude');
const thisDir = () => process.env.CLAUDE_CONFIG_DIR || defaultDir();
const globalCfgFile = dir => (norm(dir) === norm(defaultDir()) ? path.join(HOME, '.claude.json') : path.join(expand(dir), '.claude.json'));
const credFile = dir => path.join(expand(dir), '.credentials.json');

const accountIn = (c, s, i) => c.accounts[s.swapped ? 1 - i : i];
const slotOf = (c, dir) => c.accounts.findIndex(a => norm(a.dir) === norm(dir));

function swap() {
  const c = config();
  const dirs = c.accounts.map(a => a.dir);
  const creds = dirs.map(d => readJson(credFile(d), null));
  for (let i = 0; i < 2; i++) {
    if (!creds[i] || !creds[i].claudeAiOauth || !creds[i].claudeAiOauth.refreshToken) {
      if (process.platform === 'darwin' && !fs.existsSync(credFile(dirs[i])))
        return { err: 'cant swap: on macOS Claude Code keeps logins in the Keychain, which claude-swap does not support yet' };
      return { err: `cant swap: no claude.ai login in ${dirs[i]}. Run "claude-swap login" (or claude /login there) first.` };
    }
  }

  [creds[0].claudeAiOauth, creds[1].claudeAiOauth] = [creds[1].claudeAiOauth, creds[0].claudeAiOauth];
  writeJson(credFile(dirs[0]), creds[0]);
  writeJson(credFile(dirs[1]), creds[1]);

  try {
    const g = dirs.map(d => readJson(globalCfgFile(d), null));
    if (g[0] && g[1]) {
      [g[0].oauthAccount, g[1].oauthAccount] = [g[1].oauthAccount, g[0].oauthAccount];
      writeJson(globalCfgFile(dirs[0]), g[0]);
      writeJson(globalCfgFile(dirs[1]), g[1]);
    }
  } catch (e) { log(`oauthAccount swap failed: ${e.message}`); }

  const s = state();
  s.swapped = !s.swapped;
  saveState(s);
  const here = slotOf(c, thisDir());
  const now = accountIn(c, s, here < 0 ? 0 : here);
  log(`swapped: ${dirs[0]} -> ${accountIn(c, s, 0).name}, ${dirs[1]} -> ${accountIn(c, s, 1).name}`);
  return { now: now.name };
}

function status() {
  const c = config(), s = state();
  const here = slotOf(c, thisDir());
  const auto = `auto swap ${s.auto ? 'on' : 'off'}`;
  if (here < 0) return `this dir (${thisDir()}) isnt one of the two swap dirs; ${c.accounts[0].dir} has ${accountIn(c, s, 0).name}, ${auto}`;
  return `on ${accountIn(c, s, here).name}, ${auto}`;
}

function setAuto(arg) {
  const s = state();
  s.auto = arg === 'on' ? true : arg === 'off' ? false : !s.auto;
  saveState(s);
  return `auto swap ${s.auto ? 'on: when you hit a usage limit it swaps to the other account' : 'off'}`;
}

function command(argv) {
  const a = argv.map(x => String(x).toLowerCase());
  if (a[0] === 'status') return status();
  if (a[0] === 'auto') return setAuto(a[1]);
  if (!a[0] || a[0] === 'swap') { const r = swap(); return r.err || `swapped to ${r.now}`; }
  return `unknown: ${argv.join(' ')}. Use: swap | status | auto [on|off] | login`;
}

function login() {
  const c = config();
  const dir = expand(c.accounts[1].dir);
  fs.mkdirSync(dir, { recursive: true });
  console.log(`Signing in ${c.accounts[1].name} into ${dir}. Pick the OTHER account in the browser.`);
  const env = { ...process.env, CLAUDE_CONFIG_DIR: dir };
  const r = cp.spawnSync('claude', ['auth', 'login'], { stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) {
    const manual = process.platform === 'win32' ? `$env:CLAUDE_CONFIG_DIR="${dir}"; claude` : `CLAUDE_CONFIG_DIR="${dir}" claude`;
    console.log(`\nThat didnt finish. Do it by hand instead:\n  ${manual}\nthen type /login, sign in with the other account, and /exit.`);
    process.exitCode = 1;
  }
}

function continueLater(text) {
  if (process.platform !== 'win32') return;
  try {
    cp.execFileSync('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'continue.ps1'), '-StartPid', String(process.ppid), '-Text', text],
      { stdio: 'ignore', windowsHide: true, timeout: 12000 });
  } catch (e) { log(`continue failed: ${e.message}`); }
}

function hook(raw) {
  let j;
  try { j = JSON.parse(raw.replace(/^\uFEFF/, '')); } catch { return; }

  if (j.hook_event_name === 'UserPromptExpansion') {
    if (!/^\/?swap$/i.test(j.command_name || '')) return;
    let msg;
    try { msg = command(String(j.command_args || '').trim().split(/\s+/).filter(Boolean)); } catch (e) { msg = `cant swap: ${e.message}`; }
    process.stdout.write(JSON.stringify({ continue: false, stopReason: msg, suppressOutput: true }));
    return;
  }

  if (j.hook_event_name === 'StopFailure') {
    const s = state();
    if (!s.auto) return;
    if (j.error && !/rate_limit/i.test(String(j.error))) return;
    if (Date.now() - (s.lastAuto || 0) < AUTO_GUARD_MS) return log('auto swap skipped: swapped less than 5 min ago');
    s.lastAuto = Date.now();
    saveState(s);
    const r = swap();
    if (r.err) return log(`auto ${r.err}`);
    log(`auto swap: now ${r.now}`);
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'cli')
      continueLater(`You hit the usage limit and were swapped to ${r.now}. Carry on exactly where you left off.`);
  }
}

if (require.main === module) {
  const [mode, ...rest] = process.argv.slice(2);
  if (mode === 'hook') {
    let raw = '';
    process.stdin.on('data', d => (raw += d));
    process.stdin.on('end', () => { try { hook(raw); } catch (e) { log(`hook error: ${e.message}`); } });
  } else if (mode === 'login') {
    try { login(); } catch (e) { console.error(e.message); process.exitCode = 1; }
  } else if (mode === '-h' || mode === '--help' || mode === 'help') {
    console.log('claude-swap [swap | status | auto [on|off] | login]');
  } else {
    try { console.log(command(mode ? [mode, ...rest] : [])); } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}

module.exports = { swap, status, setAuto, command, hook, expand, norm };
