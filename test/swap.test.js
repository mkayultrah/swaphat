'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const MIN = 60 * 1000;

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swaphat-test-'));
  const app = path.join(home, '.swaphat');
  const a = path.join(home, '.claude'), b = path.join(home, '.claude-second');
  const env = { ...process.env, HOME: home, USERPROFILE: home, SWAPHAT_HOME: app };
  for (const k of ['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENTRYPOINT', 'SWAPHAT_KEYCHAIN']) delete env[k];
  const run = (file, args = [], opts = {}) => {
    const r = cp.spawnSync(process.execPath, [file, ...args], { env: { ...env, ...(opts.env || {}) }, input: opts.input, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const install = (...args) => run(path.join(ROOT, 'install.js'), args);
  const swap = (args = [], opts) => run(path.join(ROOT, 'swap.js'), args, opts);
  const hook = (event, opts) => swap(['hook'], { ...opts, input: JSON.stringify(event) });
  const status = (input, opts) => run(path.join(ROOT, 'statusline.js'), [], { ...opts, input: JSON.stringify(input) }).out.replace(/\x1b\[[0-9;]*m/g, '');
  const login = (dir, token, acct) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `at-${token}`, refreshToken: `rt-${token}` }, mcpOAuth: { keep: dir } }));
    if (acct) {
      const g = path.resolve(dir) === path.resolve(a) ? path.join(home, '.claude.json') : path.join(dir, '.claude.json');
      fs.writeFileSync(g, JSON.stringify({ oauthAccount: acct, keepMe: 1 }));
    }
  };
  const token = dir => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken; } catch { return null; } };
  const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const st = () => json(path.join(app, 'state.json'));
  const cfg = () => json(path.join(app, 'config.json'));
  const vaultFile = name => path.join(app, 'vault', `${crypto.createHash('sha256').update(name.toLowerCase()).digest('hex').slice(0, 12)}.json`);
  const extra = (name, token, acct) => {
    const d = path.join(home, `login-${name}`);
    login(d, token, acct);
    const r = swap(['add', name, '--from', d]);
    assert.equal(r.code, 0, r.err);
    return d;
  };
  const done = () => { if (!process.env.KEEP_TEST_HOMES) fs.rmSync(home, { recursive: true, force: true }); };
  return { home, app, a, b, run, install, swap, hook, status, login, token, json, st, cfg, vaultFile, extra, done };
}

const who = (n, org = 'o1') => ({ accountUuid: `u-${n}`, organizationUuid: org, emailAddress: `${n}@example.com`, organizationName: `${n} org` });

test('single dir install: config, hooks, command and status line', () => {
  const s = sandbox();
  try {
    const r = s.install('--names', 'Personal');
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(s.cfg().slots, ['~/.claude']);
    assert.deepEqual(s.cfg().accounts.map(x => x.name), ['Personal']);
    assert.deepEqual(s.st().where, { Personal: '~/.claude' });
    const st = s.json(path.join(s.a, 'settings.json'));
    assert.match(st.hooks.UserPromptExpansion[0].hooks[0].command, /swap\.js" hook$/);
    assert.equal(st.hooks.StopFailure[0].matcher, 'rate_limit');
    assert.match(st.statusLine.command, /statusline\.js/);
    assert.ok(fs.readFileSync(path.join(s.a, 'commands', 'swap.md'), 'utf8').includes('swaphat'));
    assert.match(r.out, /add <name>/);
  } finally { s.done(); }
});

test('two dir install sets up both dirs', () => {
  const s = sandbox();
  try {
    assert.equal(s.install('--names', 'Personal,Work', '--second-dir', s.b).code, 0);
    assert.deepEqual(s.cfg().slots, ['~/.claude', '~/.claude-second']);
    assert.deepEqual(s.st().where, { Personal: '~/.claude', Work: '~/.claude-second' });
    assert.ok(fs.existsSync(path.join(s.b, 'settings.json')));
    assert.ok(fs.existsSync(path.join(s.b, 'commands', 'swap.md')));
  } finally { s.done(); }
});

test('install keeps existing settings and is idempotent', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.a, { recursive: true });
    const mine = { model: 'x', statusLine: { type: 'command', command: 'my-status' }, hooks: { StopFailure: [{ matcher: 'other', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    fs.writeFileSync(path.join(s.a, 'settings.json'), JSON.stringify(mine));
    s.install(); s.install('--names', 'Extra');
    const st = s.json(path.join(s.a, 'settings.json'));
    assert.equal(st.model, 'x');
    assert.equal(st.statusLine.command, 'my-status');
    assert.equal(st.hooks.StopFailure.length, 2);
    assert.equal(st.hooks.UserPromptExpansion.length, 1);
    assert.ok(fs.existsSync(path.join(s.a, 'settings.json.swaphat-backup')));
    assert.deepEqual(s.cfg().accounts.map(x => x.name), ['Main', 'Extra']);
    s.install('--statusline');
    assert.match(s.json(path.join(s.a, 'settings.json')).statusLine.command, /statusline\.js/);
    s.install('--no-statusline');
    assert.equal(s.json(path.join(s.a, 'settings.json')).statusLine, undefined);
  } finally { s.done(); }
});

test('install refuses broken settings.json and bad options', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.a, { recursive: true });
    fs.writeFileSync(path.join(s.a, 'settings.json'), '{ nope');
    assert.notEqual(s.install().code, 0);
    assert.equal(fs.readFileSync(path.join(s.a, 'settings.json'), 'utf8'), '{ nope');
    assert.match(s.install('--bogus').err, /unknown option/);
    assert.match(s.install('--names', '').err, /at least one name/);
    assert.match(s.install('--help').out, /--second-dir/);
  } finally { s.done(); }
});

test('replaces an old claude-swap install in place', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(path.join(s.a, 'commands'), { recursive: true });
    const old = { type: 'command', command: 'node "C:/x/.claude-swap/swap.js" hook' };
    fs.writeFileSync(path.join(s.a, 'settings.json'), JSON.stringify({ hooks: { UserPromptExpansion: [{ matcher: '^/?swap$', hooks: [old] }] }, statusLine: { type: 'command', command: 'node "C:/x/.claude-swap/statusline.js"' } }));
    fs.writeFileSync(path.join(s.a, 'commands', 'swap.md'), '<!-- claude-swap -->\nold');
    s.install();
    const st = s.json(path.join(s.a, 'settings.json'));
    assert.equal(st.hooks.UserPromptExpansion.length, 1);
    assert.match(st.hooks.UserPromptExpansion[0].hooks[0].command, /swaphat/);
    assert.match(st.statusLine.command, /swaphat/);
    assert.ok(!fs.existsSync(path.join(s.a, 'commands', 'swap.md.swaphat-backup')));
  } finally { s.done(); }
});

test('a v1 two dir config is migrated, swapped or not', () => {
  for (const swapped of [false, true]) {
    const s = sandbox();
    try {
      fs.mkdirSync(s.app, { recursive: true });
      fs.writeFileSync(path.join(s.app, 'config.json'), JSON.stringify({ accounts: [{ name: 'Pro', dir: '~/.claude', colour: '35' }, { name: 'Team', dir: '~/.claude-second', colour: '36' }] }));
      fs.writeFileSync(path.join(s.app, 'state.json'), JSON.stringify({ swapped, auto: true }));
      assert.equal(s.swap(['status']).out, `on ${swapped ? 'Team' : 'Pro'}, auto swap on at 95%`);
      assert.deepEqual(s.cfg().slots, ['~/.claude', '~/.claude-second']);
      assert.equal(s.st().where.Pro, swapped ? '~/.claude-second' : '~/.claude');
    } finally { s.done(); }
  }
});

test('add moves a login into the vault and refuses duplicates', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    s.login(s.a, 'A', who('a'));
    const d = path.join(s.home, 'login-work');
    s.login(d, 'W', who('w'));
    const r = s.swap(['add', 'Work', '--from', d]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /added Work \(w@example\.com\)/);
    assert.equal(s.token(d), null, 'login is moved, not copied');
    assert.equal(s.json(path.join(d, '.credentials.json')).mcpOAuth.keep, d);
    const v = s.json(s.vaultFile('Work'));
    assert.equal(v.claudeAiOauth.refreshToken, 'rt-W');
    assert.equal(v.oauthAccount.emailAddress, 'w@example.com');
    assert.equal(s.st().where.Work, 'vault');

    s.login(d, 'W2', who('w'));
    assert.match(s.swap(['add', 'Again', '--from', d]).err, /already saved as Work/);
    s.login(d, 'A');
    assert.match(s.swap(['add', 'Again', '--from', d]).err, /already saved as Personal/);
    assert.match(s.swap(['add', 'Work', '--from', d]).err, /already added/);
    assert.match(s.swap(['add', 'status', '--from', d]).err, /is a command/);
    assert.match(s.swap(['add', '', '--from', d]).err, /names can be/);
    assert.match(s.swap(['add', 'X', '--from', s.a]).err, /already managed/);
    assert.match(s.swap(['add', 'Y', '--from', path.join(s.home, 'nothing')]).err, /no claude\.ai login/);
  } finally { s.done(); }
});

test('swap with a saved account moves the login and the account info', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    s.login(s.a, 'A', who('a'));
    s.extra('Work', 'W', who('w'));
    assert.equal(s.swap().out, 'swapped to Work');
    assert.equal(s.token(s.a), 'rt-W');
    const g = s.json(path.join(s.home, '.claude.json'));
    assert.equal(g.oauthAccount.emailAddress, 'w@example.com');
    assert.equal(g.keepMe, 1);
    assert.equal(s.json(path.join(s.a, '.credentials.json')).mcpOAuth.keep, s.a);
    assert.equal(s.json(s.vaultFile('Personal')).claudeAiOauth.refreshToken, 'rt-A');
    assert.ok(!fs.existsSync(s.vaultFile('Work')), 'nothing is left behind in the vault');
    assert.equal(s.swap(['status']).out, 'on Work, auto swap off');
    assert.equal(s.swap().out, 'swapped to Personal');
    assert.equal(s.token(s.a), 'rt-A');
    assert.equal(s.json(path.join(s.home, '.claude.json')).oauthAccount.emailAddress, 'a@example.com');
  } finally { s.done(); }
});

test('three accounts: rotate in order, jump by name or prefix', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    s.login(s.a, 'A', who('a'));
    s.extra('Work', 'W', who('w'));
    s.extra('Spare', 'S', who('s'));
    assert.equal(s.swap().out, 'swapped to Work');
    assert.equal(s.swap().out, 'swapped to Spare');
    assert.equal(s.swap().out, 'swapped to Personal');
    assert.equal(s.swap(['spare']).out, 'swapped to Spare');
    assert.equal(s.token(s.a), 'rt-S');
    assert.equal(s.swap(['next', 'wo']).out, 'swapped to Work');
    assert.equal(s.swap(['Work']).out, 'already on Work');
    assert.match(s.swap(['nobody']).out, /no account called "nobody"/);
    const hookOut = JSON.parse(s.hook({ hook_event_name: 'UserPromptExpansion', command_name: 'swap', command_args: 'personal' }).out);
    assert.equal(hookOut.stopReason, 'swapped to Personal');
  } finally { s.done(); }
});

test('two dirs swap with each other', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work', '--second-dir', s.b);
    s.login(s.a, 'A', who('a'));
    s.login(s.b, 'B', who('b'));
    assert.equal(s.swap().out, 'swapped to Work');
    assert.equal(s.token(s.a), 'rt-B');
    assert.equal(s.token(s.b), 'rt-A');
    assert.equal(s.json(path.join(s.home, '.claude.json')).oauthAccount.emailAddress, 'b@example.com');
    assert.equal(s.json(path.join(s.b, '.claude.json')).oauthAccount.emailAddress, 'a@example.com');
    assert.equal(s.swap(['status'], { env: { CLAUDE_CONFIG_DIR: s.b } }).out, 'on Personal, auto swap off');
    assert.equal(s.swap([], { env: { CLAUDE_CONFIG_DIR: s.b } }).out, 'swapped to Work');
    assert.equal(s.token(s.b), 'rt-B');
    assert.match(s.swap(['status'], { env: { CLAUDE_CONFIG_DIR: path.join(s.home, 'elsewhere') } }).out, /isnt managed/);
    assert.match(s.swap([], { env: { CLAUDE_CONFIG_DIR: path.join(s.home, 'elsewhere') } }).out, /isnt one of the dirs/);
  } finally { s.done(); }
});

test('refuses to swap between two copies of the same account', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work', '--second-dir', s.b);
    s.login(s.a, 'A'); s.login(s.b, 'A');
    assert.match(s.swap().out, /same account/);
    s.login(s.a, 'A', who('a')); s.login(s.b, 'B', who('a'));
    assert.match(s.swap().out, /same account/);
    s.login(s.b, 'B', who('a', 'o2'));
    assert.equal(s.swap().out, 'swapped to Work', 'same person in two orgs is two accounts');
  } finally { s.done(); }
});

test('missing logins and unknown state give clear errors', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work');
    assert.match(s.swap().out, /Work isnt logged in yet/);
    s.install('--names', 'Personal');
    s.swap(['remove', 'Work']);
    assert.match(s.swap().out, /no other account yet/);
    s.extra('Work', 'W');
    assert.match(s.swap().out, /no claude\.ai login in ~\/\.claude/);
    s.login(s.a, 'A');
    fs.rmSync(s.vaultFile('Work'));
    assert.match(s.swap().out, /saved login for Work is missing/);
    const st = s.st(); st.where = {}; fs.writeFileSync(path.join(s.app, 'state.json'), JSON.stringify(st));
    assert.match(s.swap().out, /doesnt know which account/);
    assert.match(s.swap(['status']).out, /unknown account/);
    fs.writeFileSync(path.join(s.app, 'config.json'), '{}');
    assert.match(s.swap(['status']).err, /config\.json missing or broken/);
  } finally { s.done(); }
});

test('a fresh lock blocks a swap, a stale one is cleared', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    const lock = path.join(s.app, 'swap.lock');
    fs.writeFileSync(lock, '');
    assert.match(s.swap().out, /another swap is running/);
    assert.equal(s.token(s.a), 'rt-A');
    const old = new Date(Date.now() - MIN);
    fs.utimesSync(lock, old, old);
    assert.equal(s.swap().out, 'swapped to Work');
    assert.ok(!fs.existsSync(lock));
  } finally { s.done(); }
});

function inProcess(s, fn) {
  const saved = { ...process.env };
  const rename = fs.renameSync;
  Object.assign(process.env, { HOME: s.home, USERPROFILE: s.home, SWAPHAT_HOME: s.app });
  delete process.env.CLAUDE_CONFIG_DIR;
  const file = path.join(ROOT, 'swap.js');
  delete require.cache[require.resolve(file)];
  try { return fn(require(file), f => { fs.renameSync = f(rename); }); } finally {
    fs.renameSync = rename;
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    Object.assign(process.env, saved);
    delete require.cache[require.resolve(file)];
  }
}

test('a failed write between two dirs is rolled back', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work', '--second-dir', s.b);
    s.login(s.a, 'A'); s.login(s.b, 'B');
    const target = path.resolve(s.b, '.credentials.json');
    const r = inProcess(s, (mod, patch) => {
      patch(orig => (from, to) => { if (path.resolve(to) === target) throw new Error('disk full'); return orig(from, to); });
      return mod.swap();
    });
    assert.match(r.err, /disk full\. Nothing was changed/);
    assert.equal(s.token(s.a), 'rt-A');
    assert.equal(s.token(s.b), 'rt-B');
    assert.equal(s.st().where.Personal, '~/.claude');
  } finally { s.done(); }
});

test('a failed write with the vault is rolled back', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    const target = path.resolve(s.a, '.credentials.json');
    const r = inProcess(s, (mod, patch) => {
      patch(orig => (from, to) => { if (path.resolve(to) === target) throw new Error('read only'); return orig(from, to); });
      return mod.swap();
    });
    assert.match(r.err, /read only\. Nothing was changed/);
    assert.equal(s.token(s.a), 'rt-A');
    assert.ok(!fs.existsSync(s.vaultFile('Main')), 'the half parked login is cleaned up');
    assert.ok(fs.existsSync(s.vaultFile('Work')));
    assert.equal(s.st().where.Work, 'vault');
  } finally { s.done(); }
});

test('list shows every account, where it is and its last usage', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Later');
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    s.status({ rate_limits: { five_hour: { used_percentage: 42 }, seven_day: { used_percentage: 7 } } });
    const out = s.swap(['list']).out.split('\n');
    assert.match(out[0], /^\* Personal\s+~\/\.claude\s+5h 42%\s+7d 7%\s+\(just now\)$/);
    assert.match(out[1], /^ {2}Later\s+not logged in$/);
    assert.match(out[2], /^ {2}Work\s+saved$/);
    assert.equal(out[3], 'auto swap off');
  } finally { s.done(); }
});

test('remove deletes a saved account but not one in use', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    assert.match(s.swap(['remove', 'Personal']).err, /in use in ~\/\.claude/);
    assert.match(s.swap(['remove', 'nobody']).err, /no account called/);
    assert.equal(s.swap(['remove', 'work']).out, 'removed Work');
    assert.ok(!fs.existsSync(s.vaultFile('Work')));
    assert.deepEqual(s.cfg().accounts.map(a => a.name), ['Personal']);
  } finally { s.done(); }
});

test('auto: on, off and threshold', () => {
  const s = sandbox();
  try {
    s.install();
    assert.match(s.swap(['auto', 'on']).out, /^auto swap on: swaps when an account passes 95%/);
    assert.equal(s.swap(['auto', 'off']).out, 'auto swap off');
    assert.match(s.swap(['auto']).out, /^auto swap on/);
    assert.match(s.swap(['auto', '80']).out, /passes 80%/);
    assert.equal(s.cfg().threshold, 80);
    assert.match(s.swap(['auto', '20']).out, /between 50 and 100/);
    assert.equal(s.swap(['status']).out, 'on Main, auto swap on at 80%');
  } finally { s.done(); }
});

test('hitting a limit swaps to the least used account, once per 5 minutes', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    s.login(s.a, 'A');
    s.extra('Busy', 'B');
    s.extra('Fresh', 'F');
    const limit = err => s.hook({ hook_event_name: 'StopFailure', error: err });
    const st = s.st();
    st.usage = { Busy: { five_hour: { pct: 60, resets: Date.now() + 60 * MIN }, seen: Date.now() }, Fresh: { five_hour: { pct: 10, resets: Date.now() + 60 * MIN }, seen: Date.now() } };
    fs.writeFileSync(path.join(s.app, 'state.json'), JSON.stringify(st));

    limit('rate_limit');
    assert.equal(s.token(s.a), 'rt-A', 'auto is off by default');
    s.swap(['auto', 'on']);
    limit('server_error');
    assert.equal(s.token(s.a), 'rt-A', 'ignores other errors');
    limit('rate_limit');
    assert.equal(s.token(s.a), 'rt-F', 'went to the least used account');
    assert.equal(s.st().usage.Personal.five_hour.pct, 100, 'the limited account is marked full');
    limit('rate_limit');
    assert.equal(s.token(s.a), 'rt-F', 'guard stops ping-pong');
    assert.match(fs.readFileSync(path.join(s.app, 'swap.log'), 'utf8'), /less than 5 min ago/);
  } finally { s.done(); }
});

test('no auto swap when every other account is over the line', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    s.swap(['auto', 'on']);
    const st = s.st();
    st.usage = { Work: { five_hour: { pct: 99, resets: Date.now() + 60 * MIN }, seen: Date.now() } };
    fs.writeFileSync(path.join(s.app, 'state.json'), JSON.stringify(st));
    s.hook({ hook_event_name: 'StopFailure', error: 'rate_limit' });
    assert.equal(s.token(s.a), 'rt-A');
    assert.match(fs.readFileSync(path.join(s.app, 'swap.log'), 'utf8'), /every other account is over the limit/);
    st.usage.Work.five_hour.resets = Date.now() - MIN;
    st.usage.Main = { five_hour: { pct: 100, resets: Date.now() + 60 * MIN }, seen: Date.now() };
    fs.writeFileSync(path.join(s.app, 'state.json'), JSON.stringify(st));
    s.hook({ hook_event_name: 'StopFailure', error: 'rate_limit' });
    assert.equal(s.token(s.a), 'rt-W', 'a window that has reset counts as empty');
  } finally { s.done(); }
});

test('status line records usage and swaps before the limit', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    const at = pct => ({ rate_limits: { five_hour: { used_percentage: pct, resets_at: Math.floor(Date.now() / 1000) + 3600 } }, context_window: { used_percentage: 10 } });
    assert.match(s.status(at(50)), /^Personal \| 5h 50% (59m|1h00) \| ctx 10%$/);
    assert.equal(s.st().usage.Personal.five_hour.pct, 50);
    assert.equal(s.status(at(96)).split(' | ')[0], 'Personal', 'auto is off');
    s.swap(['auto', 'on']);
    assert.equal(s.status(at(96)), 'Personal -> Work auto | swapped before the limit | ctx 10%');
    assert.equal(s.token(s.a), 'rt-W');
    assert.match(s.status({ rate_limits: { five_hour: { utilization: 0.2 } } }), /^Work auto \| 5h 20%/);
    assert.match(s.status({}), /usage after first reply/);
    assert.equal(s.status({}, { env: { CLAUDE_CONFIG_DIR: path.join(s.home, 'x') } }), '? auto | usage after first reply');
  } finally { s.done(); }
});

test('doctor reports what is missing', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work', '--second-dir', s.b);
    s.login(s.a, 'A', who('a'));
    let out = s.swap(['doctor']).out;
    assert.match(out, /^ok {3}node /m);
    assert.match(out, /^ok {3}~\/\.claude: Personal \(a@example\.com, a org\), signed in \(file\)$/m);
    assert.match(out, /^FIX +~\/\.claude-second: Work, not signed in/m);
    s.login(s.b, 'B');
    s.extra('Spare', 'S', who('s'));
    out = s.swap(['doctor']).out;
    assert.doesNotMatch(out, /^FIX/m);
    assert.match(out, /^ok {3}Spare: saved \(s@example\.com, s org\), ready \(file\)$/m);
    assert.match(out, /every account holds its own login/);
    s.login(s.b, 'A');
    assert.match(s.swap(['doctor']).out, /^FIX +Personal and Work hold the same login$/m);
  } finally { s.done(); }
});

test('hook: /swap stops the prompt with one line, everything else passes', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A');
    s.extra('Work', 'W');
    const ev = (name, args) => ({ hook_event_name: 'UserPromptExpansion', command_name: name, command_args: args });
    assert.deepEqual(JSON.parse(s.hook(ev('swap', '')).out), { continue: false, stopReason: 'swapped to Work', suppressOutput: true });
    assert.equal(JSON.parse(s.hook(ev('swap', 'status')).out).stopReason, 'on Work, auto swap off');
    assert.match(JSON.parse(s.hook(ev('swap', 'add x')).out).stopReason, /from a terminal/);
    assert.equal(s.hook(ev('review', '')).out, '');
    assert.equal(s.swap(['hook'], { input: 'not json' }).out, '');
    assert.equal(JSON.parse(s.swap(['hook'], { input: '\uFEFF' + JSON.stringify(ev('swap', 'status')) }).out).stopReason, 'on Work, auto swap off');
    fs.writeFileSync(path.join(s.app, 'config.json'), 'nope');
    assert.match(JSON.parse(s.hook(ev('swap', '')).out).stopReason, /^cant swap: config\.json/);
  } finally { s.done(); }
});

test('login adds the account that is waiting, help and unknown input', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal');
    assert.match(s.swap(['login']).err, /already logged in/);
    assert.match(s.swap(['help']).out, /add <name>/);
    assert.match(s.swap(['remove']).err, /no account called/);
  } finally { s.done(); }
});

test('uninstall keeps every login and removes only its own entries', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.a, { recursive: true });
    fs.writeFileSync(path.join(s.a, 'settings.json'), JSON.stringify({ model: 'x' }));
    s.install('--names', 'Personal');
    s.login(s.a, 'A');
    s.extra('Work', 'W', who('w'));
    s.swap();
    const r = s.install('--uninstall');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /Personal moved to ~\/\.claude-personal/);
    assert.equal(s.token(s.a), 'rt-W', 'the active login stays active');
    assert.equal(s.token(path.join(s.home, '.claude-personal')), 'rt-A', 'the saved login is moved out, not lost');
    assert.deepEqual(s.json(path.join(s.a, 'settings.json')), { model: 'x' });
    assert.ok(!fs.existsSync(path.join(s.a, 'commands', 'swap.md')));
    assert.ok(!fs.existsSync(s.app));
  } finally { s.done(); }
});

test('cli passes commands through to the installed copy', () => {
  const s = sandbox();
  try {
    const env = { SWAPHAT_HOME: '' };
    assert.match(s.run(path.join(ROOT, 'cli.js'), ['status'], { env }).err, /not installed/);
    s.run(path.join(ROOT, 'cli.js'), ['install', '--names', 'One'], { env });
    assert.equal(s.run(path.join(ROOT, 'cli.js'), ['status'], { env }).out, 'on One, auto swap off');
    assert.equal(s.run(path.join(ROOT, 'cli.js'), ['uninstall'], { env }).code, 0);
  } finally { s.done(); }
});

test('macOS keychain logins are swapped and saved', { skip: process.platform !== 'darwin' }, () => {
  const s = sandbox();
  const kc = path.join(s.home, 'swap-test.keychain-db');
  const sec = (...args) => cp.spawnSync('security', args, { encoding: 'utf8' });
  try {
    assert.equal(sec('create-keychain', '-p', 'test', kc).status, 0);
    sec('unlock-keychain', '-p', 'test', kc);
    const env = { SWAPHAT_KEYCHAIN: kc };
    s.install('--names', 'Personal,Work', '--second-dir', s.b);
    const hash = p => crypto.createHash('sha256').update(path.resolve(p).normalize('NFC')).digest('hex').slice(0, 8);
    const svc = { a: 'Claude Code-credentials', b: `Claude Code-credentials-${hash(s.b)}`, c: `Claude Code-credentials-${hash(path.join(s.home, 'login-spare'))}` };
    const put = (service, tok) => assert.equal(sec('add-generic-password', '-a', 'claude-code-user', '-s', service, '-w', JSON.stringify({ claudeAiOauth: { refreshToken: `rt-${tok}` } }), kc).status, 0);
    const read = service => {
      const t = sec('find-generic-password', '-s', service, '-w', kc).stdout.trim();
      return JSON.parse(/^[0-9a-f]+$/i.test(t) ? Buffer.from(t, 'hex').toString('utf8') : t).claudeAiOauth.refreshToken;
    };
    put(svc.a, 'A'); put(svc.b, 'B'); put(svc.c, 'S');
    assert.match(s.swap(['doctor'], { env }).out, /signed in \(keychain\)/);
    assert.equal(s.swap([], { env }).out, 'swapped to Work');
    assert.equal(read(svc.a), 'rt-B');
    assert.equal(read(svc.b), 'rt-A');
    const added = s.swap(['add', 'Spare', '--from', path.join(s.home, 'login-spare')], { env });
    assert.equal(added.code, 0, added.err);
    assert.notEqual(sec('find-generic-password', '-s', svc.c, kc).status, 0, 'the login was moved out of its old item');
    assert.equal(s.swap(['spare'], { env }).out, 'swapped to Spare');
    assert.equal(read(svc.a), 'rt-S');
    assert.equal(s.swap(['work'], { env }).out, 'swapped to Work');
    assert.equal(read(svc.a), 'rt-B');
  } finally { sec('delete-keychain', kc); s.done(); }
});
