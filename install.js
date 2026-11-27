#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const SRC = __dirname;
const FILES = ['swap.js', 'statusline.js', 'continue.ps1'];
const MARK = '<!-- swaphat -->';
const COLOURS = ['35', '36', '33', '32', '34', '31'];

function parseArgs(argv) {
  const o = { names: null, secondDir: null, statusline: null, uninstall: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--names') o.names = String(argv[++i] || '').split(',').map(s => s.trim()).filter(Boolean);
    else if (a === '--second-dir') o.secondDir = argv[++i];
    else if (a === '--statusline') o.statusline = true;
    else if (a === '--no-statusline') o.statusline = false;
    else if (a === '--uninstall' || a === 'uninstall') o.uninstall = true;
    else if (a === 'install') {}
    else if (a === '-h' || a === '--help') o.help = true;
    else throw new Error(`unknown option ${a}`);
  }
  if (o.names && !o.names.length) throw new Error('--names needs at least one name, e.g. --names "Personal,Work"');
  return o;
}

const appDir = () => process.env.SWAPHAT_HOME || path.join(HOME, '.swaphat');
const expand = p => path.resolve(String(p).replace(/^~(?=$|[\\/])/, HOME));
const slash = p => p.replace(/\\/g, '/');
const readJson = (p, d) => {
  if (!fs.existsSync(p)) return d;
  const t = fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '');
  if (!t.trim()) return d;
  try { return JSON.parse(t); } catch (e) { throw new Error(`${p} is not valid JSON (${e.message}). Fix it, then run this again.`); }
};
const writeJson = (p, o) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(o, null, 2) + '\n'); };
const tilde = p => (p.startsWith(HOME) ? '~' + p.slice(HOME.length).replace(/\\/g, '/') : p);

const isOurs = h => typeof (h && h.command) === 'string' && /swap\.js"? hook\b/.test(h.command) && /swaphat|claude-swap/i.test(h.command);
const isOurStatus = s => s && typeof s.command === 'string' && /swaphat|claude-swap/i.test(s.command) && /statusline\.js/.test(s.command);

function stripHooks(settings) {
  const hooks = settings.hooks || {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] || []).map(g => ({ ...g, hooks: (g.hooks || []).filter(h => !isOurs(h)) })).filter(g => g.hooks.length);
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (settings.hooks && !Object.keys(settings.hooks).length) delete settings.hooks;
}

function patchSettings(dir, app, wantStatus) {
  const file = path.join(dir, 'settings.json');
  const s = readJson(file, {});
  const before = JSON.stringify(s);
  stripHooks(s);
  const cmd = `node "${slash(path.join(app, 'swap.js'))}" hook`;
  s.hooks = s.hooks || {};
  (s.hooks.UserPromptExpansion = s.hooks.UserPromptExpansion || []).push({ matcher: '^/?swap$', hooks: [{ type: 'command', command: cmd, timeout: 15 }] });
  (s.hooks.StopFailure = s.hooks.StopFailure || []).push({ matcher: 'rate_limit', hooks: [{ type: 'command', command: cmd, timeout: 15 }] });

  let statusNote = '';
  const ours = { type: 'command', command: `node "${slash(path.join(app, 'statusline.js'))}"`, padding: 0 };
  if (wantStatus === false) { if (isOurStatus(s.statusLine)) delete s.statusLine; }
  else if (!s.statusLine || isOurStatus(s.statusLine) || wantStatus === true) s.statusLine = ours;
  else statusNote = ' (kept your own status line; add --statusline to replace it)';

  if (JSON.stringify(s) !== before) {
    if (fs.existsSync(file) && !fs.existsSync(file + '.swaphat-backup')) fs.copyFileSync(file, file + '.swaphat-backup');
    writeJson(file, s);
  }
  return statusNote;
}

function writeCommand(dir, app) {
  const file = path.join(dir, 'commands', 'swap.md');
  if (fs.existsSync(file) && !/<!-- (swaphat|claude-swap) -->/.test(fs.readFileSync(file, 'utf8'))) {
    fs.copyFileSync(file, file + '.swaphat-backup');
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---
description: Swap this session to another Claude account. /swap [name], /swap list, /swap status, /swap auto [on|off|NN]
argument-hint: "[name | list | status | auto [on|off|NN]]"
disable-model-invocation: true
---
${MARK}
A swaphat hook normally handles /swap before you see this. If you are reading it, the hook did not run.
Run this one command, then reply with exactly the line it prints and nothing else:

node "${slash(path.join(app, 'swap.js'))}" $ARGUMENTS
`);
}

function writeLauncher(app) {
  const bin = path.join(HOME, '.local', 'bin');
  const onPath = (process.env.PATH || '').split(path.delimiter).some(p => p && path.resolve(p).toLowerCase() === bin.toLowerCase());
  if (!fs.existsSync(bin) || !onPath) return null;
  const js = path.join(app, 'swap.js');
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, 'swaphat.cmd'), `@node "${js}" %*\r\n`);
  } else {
    const f = path.join(bin, 'swaphat');
    fs.writeFileSync(f, `#!/bin/sh\nexec node "${js}" "$@"\n`);
    fs.chmodSync(f, 0o755);
  }
  return bin;
}

function removeLauncher() {
  const bin = path.join(HOME, '.local', 'bin');
  for (const n of ['swaphat', 'swaphat.cmd', 'claude-swap', 'claude-swap.cmd']) {
    const f = path.join(bin, n);
    try { if (fs.readFileSync(f, 'utf8').includes('swap.js')) fs.unlinkSync(f); } catch {}
  }
}

function runSwap(app, args) {
  return require('child_process').spawnSync(process.execPath, [path.join(app, 'swap.js'), ...args], {
    encoding: 'utf8', env: { ...process.env, SWAPHAT_HOME: app, CLAUDE_CONFIG_DIR: '' },
  });
}

function install(o) {
  const app = appDir();
  fs.mkdirSync(app, { recursive: true });
  if (path.resolve(SRC) !== path.resolve(app)) for (const f of FILES) fs.copyFileSync(path.join(SRC, f), path.join(app, f));

  const cfgFile = path.join(app, 'config.json');
  const stateFile = path.join(app, 'state.json');
  if (readJson(cfgFile, null)) runSwap(app, ['status']);
  let cfg = readJson(cfgFile, null);
  const st = readJson(stateFile, null) || { where: {}, usage: {}, auto: false, lastAuto: 0 };
  const second = o.secondDir ? tilde(expand(o.secondDir)) : null;
  if (!cfg) {
    const names = o.names || ['Main'];
    cfg = { slots: ['~/.claude'], accounts: names.map((name, i) => ({ name, colour: COLOURS[i % COLOURS.length] })), threshold: 95 };
    st.where = { [names[0]]: '~/.claude' };
    if (second) {
      cfg.slots.push(second);
      if (!names[1]) cfg.accounts.push({ name: 'Second', colour: COLOURS[1] });
      st.where[cfg.accounts[1].name] = second;
    }
  } else {
    if (second && !cfg.slots.some(d => expand(d) === expand(second))) cfg.slots.push(second);
    for (const name of o.names || []) if (!cfg.accounts.some(a => a.name.toLowerCase() === name.toLowerCase()))
      cfg.accounts.push({ name, colour: COLOURS[cfg.accounts.length % COLOURS.length] });
  }
  for (const d of cfg.slots) readJson(path.join(expand(d), 'settings.json'), {});
  writeJson(cfgFile, cfg);
  writeJson(stateFile, st);

  let note = '';
  for (const d of cfg.slots.map(expand)) {
    fs.mkdirSync(d, { recursive: true });
    note = patchSettings(d, app, o.statusline) || note;
    writeCommand(d, app);
  }
  const bin = writeLauncher(app);

  const run = bin ? 'swaphat' : `node "${path.join(app, 'swap.js')}"`;
  console.log(`swaphat installed in ${app}${note}
`);
  console.log((runSwap(app, ['doctor']).stdout || '').trimEnd());
  const pending = cfg.accounts.filter(a => !st.where[a.name]);
  console.log('');
  for (const a of pending) console.log(`Next: ${run} add "${a.name}"   (logs that account in and saves it)`);
  if (cfg.accounts.length < 2) console.log(`Next: ${run} add <name>   (log in your other account)`);
  console.log('Then type /swap in Claude Code. Restart any sessions that are already open so they load the hook.');
}

function uninstall() {
  const app = appDir();
  const has = fs.existsSync(path.join(app, 'swap.js'));
  if (has && readJson(path.join(app, 'config.json'), null)) runSwap(app, ['status']);
  const cfg = readJson(path.join(app, 'config.json'), null);
  if (has && cfg) {
    process.env.SWAPHAT_HOME = app;
    const r = require(path.join(app, 'swap.js')).exportSaved();
    if (r.err) throw new Error(`couldnt move your saved logins out (${r.err}), nothing was removed`);
    for (const [name, dir] of r.exported) console.log(`${name} moved to ${dir} (use it with CLAUDE_CONFIG_DIR=${dir} claude)`);
  }
  const dirs = cfg && cfg.slots ? cfg.slots.map(expand) : cfg ? cfg.accounts.map(a => expand(a.dir)) : [path.join(HOME, '.claude')];
  for (const d of dirs) {
    const file = path.join(d, 'settings.json');
    if (fs.existsSync(file)) {
      const s = readJson(file, {});
      stripHooks(s);
      if (isOurStatus(s.statusLine)) delete s.statusLine;
      writeJson(file, s);
    }
    const cmd = path.join(d, 'commands', 'swap.md');
    try { if (/<!-- (swaphat|claude-swap) -->/.test(fs.readFileSync(cmd, 'utf8'))) fs.unlinkSync(cmd); } catch {}
    if (fs.existsSync(cmd + '.swaphat-backup') && !fs.existsSync(cmd)) fs.renameSync(cmd + '.swaphat-backup', cmd);
  }
  removeLauncher();
  fs.rmSync(app, { recursive: true, force: true });
  console.log('swaphat removed. Every login is still where Claude Code can use it.');
}

function main(argv) {
  const o = parseArgs(argv);
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error(`needs node 18 or newer, this is ${process.versions.node}`);
  if (o.help) return console.log('node install.js [--names "A,B,..."] [--second-dir DIR] [--statusline|--no-statusline] | --uninstall');
  return o.uninstall ? uninstall() : install(o);
}

if (require.main === module) {
  try { main(process.argv.slice(2)); } catch (e) { console.error(`swaphat: ${e.message}`); process.exitCode = 1; }
}
module.exports = { main, parseArgs };
