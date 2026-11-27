#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const HOME = os.homedir();
const APP = process.env.SWAPHAT_HOME || __dirname;
const KEYCHAIN = process.env.SWAPHAT_KEYCHAIN || '';
const at = n => path.join(APP, n);
const AUTO_GUARD_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;

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
const isDefault = dir => norm(dir) === norm(defaultDir());
const thisDir = () => process.env.CLAUDE_CONFIG_DIR || defaultDir();
const globalCfgFile = dir => (isDefault(dir) ? path.join(HOME, '.claude.json') : path.join(expand(dir), '.claude.json'));
const credFile = dir => path.join(expand(dir), '.credentials.json');

const accountIn = (c, s, i) => c.accounts[s.swapped ? 1 - i : i];
const slotOf = (c, dir) => c.accounts.findIndex(a => norm(a.dir) === norm(dir));
const hasLogin = o => !!(o && o.claudeAiOauth && o.claudeAiOauth.refreshToken);

function security(args) {
  return cp.spawnSync('security', KEYCHAIN ? [...args, KEYCHAIN] : args, { encoding: 'utf8', timeout: 10000 });
}

function securityInteractive(line) {
  const r = cp.spawnSync('security', ['-i'], { input: `${line}${KEYCHAIN ? ` "${KEYCHAIN}"` : ''}\n`, encoding: 'utf8', timeout: 10000 });
  if (r.status !== 0 || /error|fail/i.test(r.stderr || '')) throw new Error(`keychain write failed: ${(r.stderr || '').trim() || r.status}`);
}

function decodeSecret(t) {
  try { return JSON.parse(t); } catch {}
  if (/^[0-9a-f]+$/i.test(t)) { try { return JSON.parse(Buffer.from(t, 'hex').toString('utf8')); } catch {} }
  return null;
}

function keychainServices(dir) {
  if (isDefault(dir)) return ['Claude Code-credentials'];
  const p = expand(dir).normalize('NFC');
  const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  return [...new Set([p, p + path.sep])].map(x => `Claude Code-credentials-${hash(x)}`);
}

function keychainItem(dir) {
  for (const service of keychainServices(dir)) {
    const meta = security(['find-generic-password', '-s', service]);
    if (meta.status !== 0) continue;
    const account = (/"acct"<blob>="([^"]*)"/.exec(meta.stdout || '') || [])[1] || 'claude-code-user';
    const pw = security(['find-generic-password', '-s', service, '-w']);
    if (pw.status !== 0) continue;
    return { service, account, data: decodeSecret((pw.stdout || '').trim()) };
  }
  return null;
}

function store(dir) {
  const file = credFile(dir);
  const fileStore = { kind: 'file', where: file, read: () => readJson(file, null), write: o => writeJson(file, o) };
  if (process.platform !== 'darwin') return fileStore;
  const item = keychainItem(dir);
  if (!item) return fileStore;
  return {
    kind: 'keychain',
    where: item.service,
    read: () => item.data,
    write: o => {
      const hex = Buffer.from(JSON.stringify(o), 'utf8').toString('hex');
      securityInteractive(`add-generic-password -U -a "${item.account}" -s "${item.service}" -X "${hex}"`);
      const back = keychainItem(dir);
      if (!back || JSON.stringify(back.data) !== JSON.stringify(o)) throw new Error(`keychain item ${item.service} did not update`);
      item.data = o;
    },
  };
}

function withLock(fn) {
  const lock = at('swap.lock');
  try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.unlinkSync(lock); } catch {}
  let fd;
  try { fd = fs.openSync(lock, 'wx'); } catch { return { err: 'cant swap: another swap is running, try again in a second' }; }
  try { return fn(); } finally { fs.closeSync(fd); try { fs.unlinkSync(lock); } catch {} }
}

function sameAccount(creds, dirs) {
  if (creds[0].claudeAiOauth.refreshToken === creds[1].claudeAiOauth.refreshToken) return true;
  const ids = dirs.map(d => ((readJson(globalCfgFile(d), {}) || {}).oauthAccount || {}).accountUuid);
  return !!(ids[0] && ids[0] === ids[1]);
}

function swapUnlocked() {
  const c = config();
  const dirs = c.accounts.map(a => a.dir);
  const stores = dirs.map(store);
  const creds = stores.map(s => s.read());
  for (let i = 0; i < 2; i++)
    if (!hasLogin(creds[i])) return { err: `cant swap: no claude.ai login in ${dirs[i]}. Run "swaphat login" (or claude /login there) first.` };
  if (sameAccount(creds, dirs))
    return { err: 'cant swap: both dirs are signed in to the same account. Run "swaphat login" and pick the other one.' };

  const next = [{ ...creds[0], claudeAiOauth: creds[1].claudeAiOauth }, { ...creds[1], claudeAiOauth: creds[0].claudeAiOauth }];
  try { stores[0].write(next[0]); } catch (e) { return { err: `cant swap: ${e.message}` }; }
  try { stores[1].write(next[1]); } catch (e) {
    try { stores[0].write(creds[0]); } catch (e2) {
      log(`swap failed half way and the undo failed too: ${e2.message}`);
      return { err: `swap failed half way and couldnt undo it (${e2.message}). Check ${stores[0].where}` };
    }
    return { err: `cant swap: ${e.message}. Nothing was changed.` };
  }

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
  log(`swapped: ${dirs[0]} -> ${accountIn(c, s, 0).name}, ${dirs[1]} -> ${accountIn(c, s, 1).name}`);
  return { now: accountIn(c, s, here < 0 ? 0 : here).name };
}

const swap = () => withLock(swapUnlocked);

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

function doctor() {
  const out = [];
  const ok = (good, msg) => out.push(`${good ? 'ok  ' : 'FIX '} ${msg}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `node ${process.versions.node}${major >= 18 ? '' : ' (need 18 or newer)'}`);
  let c;
  try { c = config(); } catch (e) { ok(false, e.message); return out.join('\n'); }
  const s = state();
  const creds = [];
  c.accounts.forEach((a, i) => {
    const st = store(a.dir);
    const cred = st.read();
    creds.push(cred);
    const who = ((readJson(globalCfgFile(a.dir), {}) || {}).oauthAccount || {});
    const label = [who.emailAddress, who.organizationName].filter(Boolean).join(', ');
    ok(hasLogin(cred), `${a.dir} holds ${accountIn(c, s, i).name}${label ? ` (${label})` : ''}: ${hasLogin(cred) ? `signed in, ${st.kind}` : i ? 'not signed in, run swaphat login' : 'not signed in, run claude and /login'}`);
    const settings = readJson(path.join(expand(a.dir), 'settings.json'), {}) || {};
    const hooks = JSON.stringify(settings.hooks || {});
    ok(/UserPromptExpansion/.test(hooks) && /swap\.js\\?" hook/.test(hooks), `${a.dir}/settings.json has the /swap hook`);
    ok(fs.existsSync(path.join(expand(a.dir), 'commands', 'swap.md')), `${a.dir}/commands/swap.md exists`);
  });
  if (hasLogin(creds[0]) && hasLogin(creds[1]))
    ok(!sameAccount(creds, c.accounts.map(a => a.dir)), 'the two dirs hold different accounts');
  out.push(`     ${status()}`);
  return out.join('\n');
}

function command(argv) {
  const a = argv.map(x => String(x).toLowerCase());
  if (a[0] === 'status') return status();
  if (a[0] === 'auto') return setAuto(a[1]);
  if (a[0] === 'doctor') return doctor();
  if (!a[0] || a[0] === 'swap') { const r = swap(); return r.err || `swapped to ${r.now}`; }
  return `unknown: ${argv.join(' ')}. Use: swap | status | auto [on|off] | doctor | login`;
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
    console.log('swaphat [swap | status | auto [on|off] | doctor | login]');
  } else {
    try { console.log(command(mode ? [mode, ...rest] : [])); } catch (e) { console.error(e.message); process.exitCode = 1; }
  }
}

module.exports = { swap, status, setAuto, doctor, command, hook, keychainServices, expand, norm };
