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
const MAC = process.platform === 'darwin';
const WIN = process.platform === 'win32';

const at = n => path.join(APP, n);
const GUARD_MS = 5 * 60 * 1000;
const LOCK_STALE_MS = 30 * 1000;
const LOCK_WAIT_MS = 2500;
const LIMIT_HOLD_MS = 60 * 60 * 1000;
const USAGE_CACHE_MS = 10 * 60 * 1000;
const DEFAULT_THRESHOLD = 95;
const VAULT = 'vault';
const RESERVED = new Set([
  'status', 'list', 'auto', 'doctor', 'add', 'remove', 'login', 'swap', 'help', 'next', 'hook', 'export'
]);
const COLOURS = ['35', '36', '33', '32', '34', '31'];

// --- Path & File Utilities ---

const expand = p => {
  const raw = String(p)
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/%([^%]+)%/g, (_, v) => process.env[v] ?? '');
  return path.resolve(raw);
};

const norm = p => {
  const s = expand(p).replace(/[\\/]+$/, '');
  return WIN ? s.toLowerCase() : s;
};

const tilde = p => {
  const e = expand(p);
  const rel = path.relative(HOME, e);
  if (!rel) return '~';
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
    return '~/' + rel.replace(/\\/g, '/');
  }
  return e;
};

const readJson = (p, fallback) => {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
};

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const rand = crypto.randomBytes(4).toString('hex');
  const tmp = `${p}.${process.pid}.${rand}.swap-tmp`;
  const data = JSON.stringify(obj, null, 2) + '\n';
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.writeFileSync(fd, data, 'utf8');
    try { fs.fsyncSync(fd); } catch {}
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, p);
  try { fs.chmodSync(p, 0o600); } catch {}
}

const log = msg => {
  try {
    fs.mkdirSync(APP, { recursive: true });
    fs.appendFileSync(at('swap.log'), `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 });
  } catch {}
};

// --- Locking (PID-verified, race-safe O_EXCL with bounded spin) ---

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, Math.max(1, ms));
}

function tryAcquireLock(lockPath) {
  const payload = JSON.stringify({ pid: process.pid, ts: Date.now() });
  try {
    const fd = fs.openSync(lockPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600);
    fs.writeSync(fd, payload);
    return fd;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') throw e;
    return null;
  }
}

function reapStaleLock(lockPath) {
  let st;
  try { st = fs.statSync(lockPath); } catch { return; }
  const meta = readJson(lockPath, null);
  const age = Date.now() - (meta && typeof meta.ts === 'number' ? meta.ts : st.mtimeMs);
  const deadOwner = meta && typeof meta.pid === 'number' && !isPidAlive(meta.pid);
  if (deadOwner || age > LOCK_STALE_MS) {
    try { fs.unlinkSync(lockPath); } catch {}
  }
}

function withLock(fn) {
  fs.mkdirSync(APP, { recursive: true });
  const lockPath = at('swap.lock');
  const deadline = Date.now() + LOCK_WAIT_MS;
  let fd = null;

  while (Date.now() <= deadline) {
    try {
      fd = tryAcquireLock(lockPath);
      if (fd !== null) break;
    } catch (e) {
      return { err: `cant lock state: ${e.message}` };
    }
    reapStaleLock(lockPath);
    sleepSync(25 + Math.floor(Math.random() * 25));
  }

  if (fd === null) {
    return { err: 'cant swap: another swap is running, try again in a second', busy: true };
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch {}
    try {
      const cur = readJson(lockPath, null);
      if (!cur || cur.pid === process.pid) fs.unlinkSync(lockPath);
    } catch {}
  }
}

// --- Config & State ---

function config() {
  const c = readJson(at('config.json'), null);
  if (!c || !Array.isArray(c.accounts) || !c.accounts.length) {
    throw new Error(`config.json missing or broken in ${APP}. Run the installer again.`);
  }
  if (Array.isArray(c.slots)) return c;

  const old = readJson(at('state.json'), {});
  const slots = c.accounts.map(a => a.dir);
  const where = {};
  c.accounts.forEach((a, i) => {
    where[a.name] = slots[old.swapped ? 1 - i : i];
  });
  const next = {
    slots,
    accounts: c.accounts.map(a => ({ name: a.name, colour: a.colour })),
    threshold: DEFAULT_THRESHOLD,
  };
  writeJson(at('config.json'), next);
  writeJson(at('state.json'), {
    where,
    auto: !!old.auto,
    lastAuto: old.lastAuto || 0,
    usage: {},
  });
  log(`migrated config to slots: ${slots.join(', ')}`);
  return next;
}

const saveConfig = c => writeJson(at('config.json'), c);

function state() {
  const s = readJson(at('state.json'), {}) || {};
  return {
    where: (s.where && typeof s.where === 'object') ? s.where : {},
    usage: (s.usage && typeof s.usage === 'object') ? s.usage : {},
    auto: Boolean(s.auto),
    lastAuto: Number(s.lastAuto) || 0,
  };
}

const saveState = s => writeJson(at('state.json'), s);
const getThreshold = c => (typeof c.threshold === 'number' && !Number.isNaN(c.threshold) ? c.threshold : DEFAULT_THRESHOLD);

// --- Claude Directory & OAuth Helpers ---

const defaultDir = () => path.join(HOME, '.claude');
const isDefault = dir => norm(dir) === norm(defaultDir());
const thisDir = () => process.env.CLAUDE_CONFIG_DIR || defaultDir();
const globalCfgFile = dir => (isDefault(dir) ? path.join(HOME, '.claude.json') : path.join(expand(dir), '.claude.json'));
const credFile = dir => path.join(expand(dir), '.credentials.json');
const hasLogin = o => !!(o && o.claudeAiOauth && typeof o.claudeAiOauth.refreshToken === 'string' && o.claudeAiOauth.refreshToken.length > 0);
const identity = a => (a && a.accountUuid && a.organizationUuid ? `${a.accountUuid}/${a.organizationUuid}` : null);
const oauthAccountOf = dir => (readJson(globalCfgFile(dir), {}) || {}).oauthAccount || null;

function setOauthAccount(dir, acct) {
  const f = globalCfgFile(dir);
  const g = readJson(f, {}) || {};
  if (acct) g.oauthAccount = acct;
  else delete g.oauthAccount;
  writeJson(f, g);
}

const slotOf = (c, dir) => c.slots.find(d => norm(d) === norm(dir));

const accountAt = (c, s, slot) =>
  c.accounts.find(a => s.where[a.name] && s.where[a.name] !== VAULT && norm(s.where[a.name]) === norm(slot));

function findAccount(c, q) {
  const n = String(q || '').trim().toLowerCase();
  if (!n) return null;
  const exact = c.accounts.find(a => a.name.toLowerCase() === n);
  if (exact) return exact;
  const hits = c.accounts.filter(a => a.name.toLowerCase().startsWith(n));
  return hits.length === 1 ? hits[0] : null;
}

// --- macOS Keychain & Credential Stores ---

const quoteInteractive = s => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

function security(args) {
  return cp.spawnSync('security', KEYCHAIN ? [...args, KEYCHAIN] : args, {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
}

function securityInteractive(cmdTokens) {
  const line = cmdTokens.map(quoteInteractive).join(' ') + (KEYCHAIN ? ` ${quoteInteractive(KEYCHAIN)}` : '') + '\n';
  const r = cp.spawnSync('security', ['-i'], {
    input: line,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (r.status !== 0 || /\b(error|fail|failed)\b/i.test(r.stderr || '')) {
    throw new Error(`keychain write failed: ${(r.stderr || '').trim() || `exit ${r.status}`}`);
  }
}

function decodeSecret(t) {
  try { return JSON.parse(t); } catch {}
  if (/^[0-9a-f]+$/i.test(t) && t.length % 2 === 0) {
    try { return JSON.parse(Buffer.from(t, 'hex').toString('utf8')); } catch {}
  }
  return null;
}

function kcRead(service) {
  const meta = security(['find-generic-password', '-s', service]);
  if (meta.status !== 0) return null;
  const account = (/"acct"<blob>="([^"]*)"/.exec(meta.stdout || '') || [])[1] || '';
  const pw = security(['find-generic-password', '-s', service, '-w']);
  if (pw.status !== 0) return null;
  return { service, account, data: decodeSecret((pw.stdout || '').trim()) };
}

function kcWrite(service, account, obj) {
  const hex = Buffer.from(JSON.stringify(obj), 'utf8').toString('hex');
  securityInteractive(['add-generic-password', '-U', '-a', account, '-s', service, '-X', hex]);
  const back = kcRead(service);
  if (!back || JSON.stringify(back.data) !== JSON.stringify(obj)) {
    throw new Error(`keychain item ${service} did not update`);
  }
}

const kcDelete = service => {
  security(['delete-generic-password', '-s', service]);
};

function keychainServices(dir) {
  if (isDefault(dir)) return ['Claude Code-credentials'];
  const p = expand(dir).normalize('NFC');
  const hash = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
  return [...new Set([p, p + path.sep])].map(x => `Claude Code-credentials-${hash(x)}`);
}

function slotStore(dir) {
  const file = credFile(dir);
  const fileStore = {
    kind: 'file',
    where: file,
    read: () => readJson(file, null),
    write: o => writeJson(file, o),
    clear: () => {
      const o = readJson(file, null);
      if (o) {
        delete o.claudeAiOauth;
        writeJson(file, o);
      }
    },
  };
  if (!MAC) return fileStore;
  let item = null;
  for (const service of keychainServices(dir)) {
    item = kcRead(service);
    if (item) break;
  }
  if (!item) return fileStore;
  return {
    kind: 'keychain',
    where: item.service,
    read: () => item.data,
    write: o => {
      kcWrite(item.service, item.account || 'claude-code-user', o);
      item.data = o;
    },
    clear: () => kcDelete(item.service),
  };
}

function vaultStore(name) {
  const id = crypto.createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 12);
  const file = at(path.join(VAULT, `${id}.json`));
  if (MAC && (KEYCHAIN || slotStore(defaultDir()).kind === 'keychain')) {
    const service = `swaphat-vault-${id}`;
    return {
      kind: 'keychain',
      where: service,
      read: () => {
        const it = kcRead(service);
        return it && it.data;
      },
      write: o => kcWrite(service, 'swaphat', o),
      remove: () => kcDelete(service),
    };
  }
  return {
    kind: 'file',
    where: file,
    read: () => readJson(file, null),
    write: o => writeJson(file, o),
    remove: () => fs.rmSync(file, { force: true }),
  };
}

// --- Usage & Account Selection ---

function windowLoad(w, now) {
  if (!w || w.pct == null) return 0;
  if (w.resets && w.resets <= now) return 0;
  return w.pct;
}

const load = (s, name, now = Date.now()) => {
  const u = s.usage[name] || {};
  return Math.max(windowLoad(u.five_hour, now), windowLoad(u.seven_day, now));
};

function pickNext(c, s, cur, auto, now = Date.now()) {
  const ready = c.accounts.filter(a => s.where[a.name] && (!cur || a.name !== cur.name));
  if (auto) {
    const thresh = getThreshold(c);
    const ok = ready.filter(a => load(s, a.name, now) < thresh);
    ok.sort((a, b) => load(s, a.name, now) - load(s, b.name, now));
    return ok[0] || null;
  }
  const i = cur ? c.accounts.findIndex(a => a.name === cur.name) : -1;
  for (let k = 1; k <= c.accounts.length; k++) {
    const a = c.accounts[(i + k) % c.accounts.length];
    if (ready.includes(a)) return a;
  }
  return null;
}

function sameIdentity(credA, acctA, credB, acctB) {
  if (hasLogin(credA) && hasLogin(credB) && credA.claudeAiOauth.refreshToken === credB.claudeAiOauth.refreshToken) {
    return true;
  }
  const idA = identity(acctA);
  const idB = identity(acctB);
  return !!(idA && idB && idA === idB);
}

// --- Core Swap Operation (Transactional with Rollback) ---

function doSwap(targetName, fromDir, opts = {}) {
  const now = Date.now();
  const c = config();
  const s = state();
  const slot = slotOf(c, fromDir);
  if (!slot) {
    return { err: `cant swap: ${tilde(fromDir)} isnt one of the dirs swaphat manages (${c.slots.map(tilde).join(', ')})` };
  }
  if (opts.auto && now - (s.lastAuto || 0) < GUARD_MS) {
    return { err: 'auto swap skipped: swapped less than 5 min ago', quiet: true };
  }

  const cur = accountAt(c, s, slot);
  if (!cur) {
    return { err: `cant swap: swaphat doesnt know which account is in ${tilde(slot)}. Run "swaphat doctor"` };
  }

  const target = targetName ? findAccount(c, targetName) : pickNext(c, s, cur, opts.auto, now);
  if (!target) {
    if (targetName) return { err: `cant swap: no account called "${targetName}". Try /swap list` };
    if (opts.auto) return { err: 'auto swap skipped: every other account is over the limit too', quiet: true };
    const waiting = c.accounts.find(a => !s.where[a.name]);
    if (waiting) return { err: `cant swap: ${waiting.name} isnt logged in yet. Run "swaphat add ${waiting.name}"` };
    return { err: 'cant swap: there is no other account yet. Add one with "swaphat add <name>"' };
  }
  if (target.name === cur.name) return { now: cur.name, same: true };

  const tw = s.where[target.name];
  if (!tw) return { err: `cant swap: ${target.name} isnt logged in yet. Run "swaphat add ${target.name}"` };

  const here = slotStore(slot);
  const hereCred = here.read();
  if (!hasLogin(hereCred)) {
    return { err: `cant swap: no claude.ai login in ${tilde(slot)}. Run claude and /login there first` };
  }
  const hereAcct = oauthAccountOf(slot);

  if (tw === VAULT) {
    const v = vaultStore(target.name);
    const vc = v.read();
    if (!hasLogin(vc)) {
      return { err: `cant swap: the saved login for ${target.name} is missing. Run "swaphat add ${target.name}"` };
    }
    if (sameIdentity(vc, vc.oauthAccount, hereCred, hereAcct)) {
      return { err: `cant swap: ${target.name} and ${cur.name} are the same account` };
    }

    const parked = vaultStore(cur.name);
    try {
      parked.write({ claudeAiOauth: hereCred.claudeAiOauth, oauthAccount: hereAcct });
    } catch (e) {
      return { err: `cant swap: ${e.message}` };
    }

    try {
      here.write({ ...hereCred, claudeAiOauth: vc.claudeAiOauth });
    } catch (e) {
      try { parked.remove(); } catch {}
      return { err: `cant swap: ${e.message}. Nothing was changed.` };
    }

    try {
      setOauthAccount(slot, vc.oauthAccount);
    } catch (e) {
      log(`oauthAccount update failed: ${e.message}`);
    }

    s.where[cur.name] = VAULT;
    s.where[target.name] = slot;
    if (opts.auto) s.lastAuto = now;
    try {
      saveState(s);
    } catch (e) {
      try { here.write(hereCred); setOauthAccount(slot, hereAcct); parked.remove(); } catch {}
      return { err: `cant swap: state save failed (${e.message}). Rolled back.` };
    }

    try {
      v.remove();
    } catch (e) {
      log(`couldnt clear the saved login for ${target.name}: ${e.message}`);
    }
  } else {
    const there = slotStore(tw);
    const thereCred = there.read();
    if (!hasLogin(thereCred)) {
      return { err: `cant swap: no claude.ai login in ${tilde(tw)}` };
    }
    const thereAcct = oauthAccountOf(tw);
    if (sameIdentity(thereCred, thereAcct, hereCred, hereAcct)) {
      return { err: `cant swap: ${tilde(slot)} and ${tilde(tw)} are signed in to the same account. Log the right one in again` };
    }

    try {
      here.write({ ...hereCred, claudeAiOauth: thereCred.claudeAiOauth });
    } catch (e) {
      return { err: `cant swap: ${e.message}` };
    }

    try {
      there.write({ ...thereCred, claudeAiOauth: hereCred.claudeAiOauth });
    } catch (e) {
      try {
        here.write(hereCred);
      } catch (e2) {
        log(`swap failed half way and the undo failed too: ${e2.message}`);
        return { err: `swap failed half way and couldnt undo it (${e2.message}). Check ${here.where}` };
      }
      return { err: `cant swap: ${e.message}. Nothing was changed.` };
    }

    try {
      setOauthAccount(slot, thereAcct);
      setOauthAccount(tw, hereAcct);
    } catch (e) {
      log(`oauthAccount swap failed: ${e.message}`);
    }

    s.where[cur.name] = tw;
    s.where[target.name] = slot;
    if (opts.auto) s.lastAuto = now;
    try {
      saveState(s);
    } catch (e) {
      try {
        here.write(hereCred);
        there.write(thereCred);
        setOauthAccount(slot, hereAcct);
        setOauthAccount(tw, thereAcct);
      } catch {}
      return { err: `cant swap: state save failed (${e.message}). Rolled back.` };
    }
  }

  log(`${opts.auto ? 'auto ' : ''}swapped ${tilde(slot)}: ${cur.name} -> ${target.name}`);
  return { now: target.name, from: cur.name };
}

const swap = (name, opts) => withLock(() => doSwap(name, thisDir(), opts));

// --- Status, List & Auto Configuration ---

function ago(t, now = Date.now()) {
  if (!t || typeof t !== 'number') return 'unknown';
  const m = Math.max(0, Math.round((now - t) / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

function status() {
  const c = config();
  const s = state();
  const slot = slotOf(c, thisDir());
  const auto = s.auto ? `auto swap on at ${getThreshold(c)}%` : 'auto swap off';
  if (!slot) return `${tilde(thisDir())} isnt managed by swaphat, ${auto}`;
  const cur = accountAt(c, s, slot);
  return `on ${cur ? cur.name : 'an unknown account'}, ${auto}`;
}

function list(now = Date.now()) {
  const c = config();
  const s = state();
  const here = slotOf(c, thisDir());
  const rows = c.accounts.map(a => {
    const w = s.where[a.name];
    const mark = w && w !== VAULT && here && norm(w) === norm(here) ? '*' : ' ';
    const place = !w ? 'not logged in' : w === VAULT ? 'saved' : tilde(w);
    const u = s.usage[a.name];
    const pct = k => (u && u[k] && u[k].pct != null ? `${windowLoad(u[k], now)}%` : '-');
    const use = u ? `5h ${pct('five_hour')}  7d ${pct('seven_day')}  (${ago(u.seen, now)})` : '';
    return { mark, name: a.name, place, use };
  });

  const nameW = Math.max(4, ...rows.map(r => r.name.length));
  const placeW = Math.max(16, ...rows.map(r => r.place.length));
  const lines = rows.map(r => `${r.mark} ${r.name.padEnd(nameW)}  ${r.place.padEnd(placeW)}  ${r.use}`.trimEnd());
  lines.push(s.auto ? `auto swap on at ${getThreshold(c)}%` : 'auto swap off');
  return lines.join('\n');
}

function setAuto(arg) {
  return withLock(() => {
    const c = config();
    const s = state();
    if (arg != null && /^\d+$/.test(arg)) {
      const n = Number(arg);
      if (n < 50 || n > 100) return 'auto swap threshold has to be between 50 and 100';
      c.threshold = n;
      saveConfig(c);
      s.auto = true;
      saveState(s);
      return `auto swap on: swaps when an account passes ${n}% or hits its limit`;
    }
    s.auto = arg === 'on' ? true : arg === 'off' ? false : !s.auto;
    saveState(s);
    return s.auto ? `auto swap on: swaps when an account passes ${getThreshold(c)}% or hits its limit` : 'auto swap off';
  });
}

// --- Account Management (Add, Remove, Export) ---

function validName(name) {
  if (!/^[\w][\w .-]{0,31}$/.test(name || '')) {
    return 'names can be letters, numbers, spaces, dots and dashes, up to 32 long';
  }
  if (RESERVED.has(name.toLowerCase())) {
    return `"${name}" is a command, pick another name`;
  }
  return null;
}

function addFrom(name, dir) {
  const bad = validName(name);
  if (bad) return { err: bad };

  return withLock(() => {
    const c = config();
    const s = state();
    if (slotOf(c, dir)) return { err: `${tilde(dir)} is already managed by swaphat` };

    const existing = findAccount(c, name);
    if (existing && existing.name.toLowerCase() === name.toLowerCase() && s.where[existing.name]) {
      return { err: `${existing.name} is already added` };
    }

    const src = slotStore(dir);
    const cred = src.read();
    if (!hasLogin(cred)) return { err: `no claude.ai login in ${tilde(dir)}` };
    const acct = oauthAccountOf(dir);

    for (const a of c.accounts) {
      const w = s.where[a.name];
      if (!w) continue;
      const other = w === VAULT ? vaultStore(a.name).read() : slotStore(w).read();
      const otherAcct = w === VAULT ? (other && other.oauthAccount) : oauthAccountOf(w);
      if (sameIdentity(other, otherAcct, cred, acct)) {
        return { err: `that login is already saved as ${a.name}` };
      }
    }

    const entry = existing && existing.name.toLowerCase() === name.toLowerCase() ? existing : null;
    const finalName = entry ? entry.name : name;
    const vault = vaultStore(finalName);

    try {
      vault.write({ claudeAiOauth: cred.claudeAiOauth, oauthAccount: acct });
    } catch (e) {
      return { err: `cant save login to vault: ${e.message}` };
    }

    const nextAccounts = entry
      ? c.accounts
      : [...c.accounts, { name: finalName, colour: COLOURS[c.accounts.length % COLOURS.length] }];
    const nextConfig = { ...c, accounts: nextAccounts };
    const nextState = { ...s, where: { ...s.where, [finalName]: VAULT } };

    try {
      saveConfig(nextConfig);
      saveState(nextState);
    } catch (e) {
      try { vault.remove(); } catch {}
      return { err: `cant save account config: ${e.message}` };
    }

    try {
      src.clear();
    } catch (e) {
      log(`couldnt clear the login in ${dir}: ${e.message}`);
    }

    log(`added ${finalName} from ${tilde(dir)}`);
    return { added: finalName, who: acct && acct.emailAddress };
  });
}

function add(name, from) {
  if (from) return addFrom(name, expand(from));
  const bad = validName(name);
  if (bad) return { err: bad };

  const tmp = at(`login-tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });

  console.log(`Log in the account you want to save as ${name}. Pick it in the browser.`);
  const r = cp.spawnSync('claude', ['auth', 'login'], {
    stdio: 'inherit',
    env: { ...process.env, CLAUDE_CONFIG_DIR: tmp },
    shell: WIN,
  });

  if (r.status !== 0) {
    fs.rmSync(tmp, { recursive: true, force: true });
    const manual = WIN ? `$env:CLAUDE_CONFIG_DIR="${tmp}"; claude` : `CLAUDE_CONFIG_DIR="${tmp}" claude`;
    return { err: `that didnt finish. Do it by hand: run\n  ${manual}\nthen /login, /exit, and\n  swaphat add "${name}" --from "${tmp}"` };
  }

  const res = addFrom(name, tmp);
  if (!res.err) fs.rmSync(tmp, { recursive: true, force: true });
  return res;
}

function remove(name) {
  return withLock(() => {
    const c = config();
    const s = state();
    const a = findAccount(c, name);
    if (!a) return { err: `no account called "${name}"` };
    const w = s.where[a.name];
    if (w && w !== VAULT) {
      return { err: `${a.name} is in use in ${tilde(w)}. Swap to another account there first` };
    }
    if (w === VAULT) vaultStore(a.name).remove();
    delete s.where[a.name];
    delete s.usage[a.name];
    c.accounts = c.accounts.filter(x => x !== a);
    saveConfig(c);
    saveState(s);
    log(`removed ${a.name}`);
    return { removed: a.name };
  });
}

function exportSaved() {
  return withLock(() => {
    const c = config();
    const s = state();
    const out = [];
    for (const a of c.accounts) {
      if (s.where[a.name] !== VAULT) continue;
      const v = vaultStore(a.name);
      const vc = v.read();
      if (!hasLogin(vc)) continue;
      const slug = a.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'account';
      let dir = path.join(HOME, `.claude-${slug}`);
      for (let n = 2; fs.existsSync(credFile(dir)); n++) {
        dir = path.join(HOME, `.claude-${slug}-${n}`);
      }
      writeJson(credFile(dir), { claudeAiOauth: vc.claudeAiOauth });
      if (vc.oauthAccount) writeJson(path.join(dir, '.claude.json'), { oauthAccount: vc.oauthAccount });
      s.where[a.name] = dir;
      saveState(s);
      v.remove();
      out.push([a.name, tilde(dir)]);
    }
    return { exported: out };
  });
}

// --- Usage Tracking & Statusline Hook ---

function pctOf(w) {
  if (!w) return null;
  let p = w.used_percentage ?? w.utilization ?? w.used_percent;
  if (p == null) return null;
  if (p <= 1 && w.utilization != null) p *= 100;
  return Math.round(p);
}

function resetMs(r) {
  if (r == null) return null;
  const t = typeof r === 'number' ? (r < 1e12 ? r * 1000 : r) : Date.parse(r);
  return t && !isNaN(t) ? t : null;
}

function noteUsage(s, name, rl, now) {
  const u = {};
  for (const key of ['five_hour', 'seven_day']) {
    const pct = pctOf(rl && rl[key]);
    if (pct != null) u[key] = { pct, resets: resetMs(rl[key].resets_at) };
  }
  if (!Object.keys(u).length) return false;
  const prev = s.usage[name] || {};
  const same = ['five_hour', 'seven_day'].every(
    k => JSON.stringify(prev[k] || null) === JSON.stringify(u[k] || null)
  );
  if (same && now - (prev.seen || 0) < USAGE_CACHE_MS) return false;
  s.usage[name] = { ...u, seen: now };
  return true;
}

function onStatus(j, now = Date.now()) {
  let c;
  try { c = config(); } catch { return null; }
  const dir = thisDir();
  const slot = slotOf(c, dir);
  if (!slot) return { c, s: state(), cur: null };

  const r = withLock(() => {
    const s = state();
    const cur = accountAt(c, s, slot);
    if (!cur) return { c, s, cur };
    if (noteUsage(s, cur.name, j && j.rate_limits, now)) saveState(s);
    if (s.auto && load(s, cur.name, now) >= getThreshold(c)) {
      const sw = doSwap(null, dir, { auto: true });
      if (sw.now && !sw.same) {
        return { c, s: state(), cur: c.accounts.find(a => a.name === sw.now), swapped: sw };
      }
    }
    return { c, s, cur };
  });

  if (r && r.busy) {
    const s = state();
    return { c, s, cur: accountAt(c, s, slot) };
  }
  return r;
}

// --- Diagnostics ---

function doctor() {
  const out = [];
  const ok = (good, msg) => out.push(`${good ? 'ok  ' : 'FIX '} ${msg}`);
  const major = Number(process.versions.node.split('.')[0]);
  ok(major >= 18, `node ${process.versions.node}${major >= 18 ? '' : ' (need 18 or newer)'}`);

  let c;
  try { c = config(); } catch (e) { ok(false, e.message); return out.join('\n'); }
  const s = state();
  const tokens = [];

  for (const slot of c.slots) {
    const st = slotStore(slot);
    const cred = st.read();
    const cur = accountAt(c, s, slot);
    const who = oauthAccountOf(slot) || {};
    const label = [who.emailAddress, who.organizationName].filter(Boolean).join(', ');
    if (hasLogin(cred)) tokens.push([cur ? cur.name : tilde(slot), cred.claudeAiOauth.refreshToken]);

    ok(
      hasLogin(cred) && !!cur,
      `${tilde(slot)}: ${cur ? cur.name : 'no account assigned'}${label ? ` (${label})` : ''}, ${
        hasLogin(cred) ? `signed in (${st.kind})` : 'not signed in, run claude and /login there'
      }`
    );

    const hooks = JSON.stringify((readJson(path.join(expand(slot), 'settings.json'), {}) || {}).hooks || {});
    ok(
      /UserPromptExpansion/.test(hooks) && /(?:^|[\\/'"\s])swap\.js\b/.test(hooks),
      `${tilde(slot)}/settings.json has the /swap hook`
    );
    ok(fs.existsSync(path.join(expand(slot), 'commands', 'swap.md')), `${tilde(slot)}/commands/swap.md exists`);
  }

  for (const a of c.accounts) {
    const w = s.where[a.name];
    if (!w) {
      ok(false, `${a.name}: not logged in, run swaphat add "${a.name}"`);
      continue;
    }
    if (w !== VAULT) continue;
    const v = vaultStore(a.name);
    const vc = v.read();
    if (hasLogin(vc)) tokens.push([a.name, vc.claudeAiOauth.refreshToken]);
    const who = (vc && vc.oauthAccount) || {};
    ok(
      hasLogin(vc),
      `${a.name}: saved${
        who.emailAddress ? ` (${[who.emailAddress, who.organizationName].filter(Boolean).join(', ')})` : ''
      }, ${hasLogin(vc) ? `ready (${v.kind})` : `login missing, run swaphat add "${a.name}"`}`
    );
  }

  const seen = new Map();
  for (const [n, t] of tokens) {
    if (seen.has(t)) ok(false, `${seen.get(t)} and ${n} hold the same login`);
    else seen.set(t, n);
  }
  if (tokens.length > 1 && seen.size === tokens.length) {
    ok(true, 'every account holds its own login');
  }
  out.push(`     ${status()}`);
  return out.join('\n');
}

// --- Command & Hook Dispatch ---

function command(argv) {
  const a = argv.map(x => String(x));
  const head = (a[0] || '').toLowerCase();
  if (head === 'status') return status();
  if (head === 'list') return list();
  if (head === 'auto') return setAuto(a[1] && a[1].toLowerCase());
  if (head === 'doctor') return doctor();
  if (head === 'add' || head === 'remove' || head === 'login' || head === 'export') {
    return `run that one from a terminal: swaphat ${a.join(' ')}`;
  }
  const target = head === '' || head === 'swap' || head === 'next'
    ? (a[1] ? a.slice(1).join(' ') : null)
    : a.join(' ');
  const r = swap(target);
  if (r.err) return r.err;
  return r.same ? `already on ${r.now}` : `swapped to ${r.now}`;
}

function continueLater(text) {
  if (!WIN) return;
  try {
    cp.execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        path.join(__dirname, 'continue.ps1'),
        '-StartPid',
        String(process.ppid),
        '-Text',
        text,
      ],
      { stdio: 'ignore', windowsHide: true, timeout: 12000 }
    );
  } catch (e) {
    log(`continue failed: ${e.message}`);
  }
}

function hook(raw) {
  let j;
  try {
    j = JSON.parse(String(raw).replace(/^\uFEFF/, ''));
  } catch {
    return;
  }

  if (j.hook_event_name === 'UserPromptExpansion') {
    if (!/^\/?swap$/i.test(j.command_name || '')) return;
    let msg;
    try {
      msg = command(String(j.command_args || '').trim().split(/\s+/).filter(Boolean));
    } catch (e) {
      msg = `cant swap: ${e.message}`;
    }
    if (msg.includes('\n')) msg = `\n${msg}`;
    process.stdout.write(JSON.stringify({ continue: false, stopReason: msg, suppressOutput: true }));
    return;
  }

  if (j.hook_event_name === 'StopFailure') {
    if (j.error && !/rate_limit/i.test(String(j.error))) return;
    const r = withLock(() => {
      const c = config();
      const s = state();
      if (!s.auto) return { err: 'auto off', quiet: true };
      const slot = slotOf(c, thisDir());
      const cur = slot && accountAt(c, s, slot);
      if (cur) {
        const now = Date.now();
        const u = s.usage[cur.name] || {};
        const hold = Math.max((u.five_hour && u.five_hour.resets) || 0, now + LIMIT_HOLD_MS);
        s.usage[cur.name] = { ...u, five_hour: { pct: 100, resets: hold }, seen: now };
        saveState(s);
      }
      return doSwap(null, thisDir(), { auto: true });
    });
    if (r.err) {
      if (r.err !== 'auto off') log(r.err);
      return;
    }
    if (process.env.CLAUDE_CODE_ENTRYPOINT === 'cli') {
      continueLater(`You hit the usage limit and were swapped to ${r.now}. Carry on exactly where you left off.`);
    }
  }
}

// --- CLI Entrypoint ---

function parseAddArgs(rest) {
  let from = null;
  const nameParts = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--from') {
      if (i + 1 >= rest.length || !rest[i + 1]) {
        return { err: 'missing directory after --from' };
      }
      from = rest[++i];
    } else if (rest[i].startsWith('--from=')) {
      from = rest[i].slice('--from='.length);
      if (!from) return { err: 'missing directory after --from=' };
    } else {
      nameParts.push(rest[i]);
    }
  }
  return { name: nameParts.join(' '), from };
}

function main(argv) {
  const [mode, ...rest] = argv;
  if (mode === 'hook') {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => (raw += d));
    process.stdin.on('end', () => {
      try { hook(raw); } catch (e) { log(`hook error: ${e.message}`); }
    });
    return;
  }

  const say = r => {
    if (r.err) {
      console.error(r.err);
      process.exitCode = 1;
      return;
    }
    if (r.added) console.log(`added ${r.added}${r.who ? ` (${r.who})` : ''}. Switch to it with /swap ${r.added}`);
    if (r.removed) console.log(`removed ${r.removed}`);
    if (r.exported) {
      console.log(
        r.exported.length
          ? r.exported.map(([n, d]) => `exported ${n} -> ${d}`).join('\n')
          : 'no saved vault accounts to export'
      );
    }
  };

  try {
    if (mode === 'add') {
      const parsed = parseAddArgs(rest);
      if (parsed.err) return say(parsed);
      return say(add(parsed.name, parsed.from));
    }
    if (mode === 'remove') return say(remove(rest.join(' ')));
    if (mode === 'export') return say(exportSaved());
    if (mode === 'login') {
      const c = config();
      const s = state();
      const pending = c.accounts.find(a => !s.where[a.name]);
      if (!pending) {
        return say({ err: 'every account is already logged in. Add another with: swaphat add <name>' });
      }
      return say(add(pending.name));
    }
    if (mode === '-h' || mode === '--help' || mode === 'help') {
      return console.log('swaphat [name] | status | list | auto [on|off|NN] | add <name> [--from DIR] | remove <name> | login | export | doctor');
    }
    console.log(command(mode ? [mode, ...rest] : []));
  } catch (e) {
    console.error(e.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  swap,
  status,
  list,
  setAuto,
  add,
  addFrom,
  remove,
  exportSaved,
  doctor,
  command,
  hook,
  onStatus,
  config,
  state,
  load,
  pickNext,
  keychainServices,
  expand,
  norm,
  tilde,
  main,
};
