'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'swaphat-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: process.env.PATH };
  delete env.CLAUDE_CONFIG_DIR; delete env.SWAPHAT_HOME; delete env.CLAUDE_CODE_ENTRYPOINT;
  const app = path.join(home, '.swaphat');
  const a = path.join(home, '.claude'), b = path.join(home, '.claude-second');
  const run = (file, args = [], opts = {}) => {
    const r = cp.spawnSync(process.execPath, [file, ...args], { env: { ...env, ...(opts.env || {}) }, input: opts.input, encoding: 'utf8' });
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
  };
  const install = (...args) => run(path.join(ROOT, 'install.js'), args);
  const swap = (args, opts) => run(path.join(app, 'swap.js'), args, opts);
  const login = (dir, token) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: `at-${token}`, refreshToken: `rt-${token}` }, mcpOAuth: { keep: dir } }));
  };
  const token = dir => JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8')).claudeAiOauth.refreshToken;
  const json = p => JSON.parse(fs.readFileSync(p, 'utf8'));
  const done = () => fs.rmSync(home, { recursive: true, force: true });
  return { home, app, a, b, run, install, swap, login, token, json, done };
}

test('install writes config, hooks, command and status line into both dirs', () => {
  const s = sandbox();
  try {
    const r = s.install('--names', 'Personal,Work');
    assert.equal(r.code, 0, r.err);
    const cfg = s.json(path.join(s.app, 'config.json'));
    assert.deepEqual(cfg.accounts.map(x => x.name), ['Personal', 'Work']);
    for (const d of [s.a, s.b]) {
      const st = s.json(path.join(d, 'settings.json'));
      assert.match(st.hooks.UserPromptExpansion[0].hooks[0].command, /swap\.js" hook$/);
      assert.equal(st.hooks.StopFailure[0].matcher, 'rate_limit');
      assert.match(st.statusLine.command, /statusline\.js/);
      assert.ok(fs.readFileSync(path.join(d, 'commands', 'swap.md'), 'utf8').includes('swaphat'));
    }
  } finally { s.done(); }
});

test('install keeps existing settings and is idempotent', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.a, { recursive: true });
    const mine = { model: 'x', statusLine: { type: 'command', command: 'my-status' }, hooks: { StopFailure: [{ matcher: 'other', hooks: [{ type: 'command', command: 'echo hi' }] }] } };
    fs.writeFileSync(path.join(s.a, 'settings.json'), JSON.stringify(mine));
    s.install(); s.install();
    const st = s.json(path.join(s.a, 'settings.json'));
    assert.equal(st.model, 'x');
    assert.equal(st.statusLine.command, 'my-status', 'does not replace a status line it does not own');
    assert.equal(st.hooks.StopFailure.length, 2, 'own hook added once, user hook kept');
    assert.equal(st.hooks.UserPromptExpansion.length, 1);
    assert.ok(fs.existsSync(path.join(s.a, 'settings.json.swaphat-backup')));
  } finally { s.done(); }
});

test('install refuses to overwrite broken settings.json', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.a, { recursive: true });
    fs.writeFileSync(path.join(s.a, 'settings.json'), '{ nope');
    const r = s.install();
    assert.notEqual(r.code, 0);
    assert.equal(fs.readFileSync(path.join(s.a, 'settings.json'), 'utf8'), '{ nope');
  } finally { s.done(); }
});

test('swap exchanges only the claude.ai logins, and swapping twice restores them', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work');
    s.login(s.a, 'A'); s.login(s.b, 'B');
    fs.writeFileSync(path.join(s.home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'a' }, other: 1 }));
    fs.writeFileSync(path.join(s.b, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'b' } }));

    assert.equal(s.swap([]).out, 'swapped to Work');
    assert.equal(s.token(s.a), 'rt-B');
    assert.equal(s.token(s.b), 'rt-A');
    assert.equal(s.json(path.join(s.a, '.credentials.json')).mcpOAuth.keep, s.a, 'other credentials stay with their dir');
    assert.equal(s.json(path.join(s.home, '.claude.json')).oauthAccount.emailAddress, 'b');
    assert.equal(s.json(path.join(s.home, '.claude.json')).other, 1);
    assert.equal(s.swap(['status']).out, 'on Work, auto swap off');
    assert.equal(s.swap(['status'], { env: { CLAUDE_CONFIG_DIR: s.b } }).out, 'on Personal, auto swap off');

    assert.equal(s.swap(['swap']).out, 'swapped to Personal');
    assert.equal(s.token(s.a), 'rt-A');
    assert.equal(s.token(s.b), 'rt-B');
  } finally { s.done(); }
});

test('swap without a second login fails cleanly and changes nothing', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A');
    const r = s.swap([]);
    assert.match(r.out, /^cant swap: no claude\.ai login/);
    assert.equal(s.token(s.a), 'rt-A');
    assert.equal(s.json(path.join(s.app, 'state.json')).swapped, false);
  } finally { s.done(); }
});

test('refuses to swap when both dirs hold the same account', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A'); s.login(s.b, 'A');
    assert.match(s.swap([]).out, /same account/);
    s.login(s.b, 'B');
    fs.writeFileSync(path.join(s.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u1', organizationUuid: 'o1' } }));
    fs.writeFileSync(path.join(s.b, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u1', organizationUuid: 'o1' } }));
    assert.match(s.swap([]).out, /same account/);
    assert.equal(s.token(s.a), 'rt-A');
    fs.writeFileSync(path.join(s.b, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'u1', organizationUuid: 'o2' } }));
    assert.match(s.swap([]).out, /^swapped to/, 'same person in two orgs is two accounts');
    assert.equal(s.token(s.a), 'rt-B');
  } finally { s.done(); }
});

test('a fresh lock blocks a second swap, a stale one is cleared', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A'); s.login(s.b, 'B');
    const lock = path.join(s.app, 'swap.lock');
    fs.writeFileSync(lock, '');
    assert.match(s.swap([]).out, /another swap is running/);
    assert.equal(s.token(s.a), 'rt-A');
    const old = new Date(Date.now() - 60 * 1000);
    fs.utimesSync(lock, old, old);
    assert.match(s.swap([]).out, /^swapped to/);
    assert.equal(s.token(s.a), 'rt-B');
    assert.ok(!fs.existsSync(lock));
  } finally { s.done(); }
});

test('a failed second write is rolled back', () => {
  const s = sandbox();
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, SWAPHAT_HOME: process.env.SWAPHAT_HOME, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR };
  const rename = fs.renameSync;
  try {
    s.install();
    s.login(s.a, 'A'); s.login(s.b, 'B');
    Object.assign(process.env, { HOME: s.home, USERPROFILE: s.home, SWAPHAT_HOME: s.app });
    delete process.env.CLAUDE_CONFIG_DIR;
    const file = path.join(s.app, 'swap.js');
    delete require.cache[require.resolve(file)];
    const mod = require(file);
    const target = path.join(s.b, '.credentials.json');
    fs.renameSync = (from, to) => { if (path.resolve(to) === path.resolve(target)) throw new Error('disk full'); return rename(from, to); };
    const r = mod.swap();
    fs.renameSync = rename;
    assert.match(r.err, /disk full\. Nothing was changed/);
    assert.equal(s.token(s.a), 'rt-A');
    assert.equal(s.token(s.b), 'rt-B');
    assert.equal(s.json(path.join(s.app, 'state.json')).swapped, false);
  } finally {
    fs.renameSync = rename;
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    s.done();
  }
});

test('doctor reports what is missing', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work');
    s.login(s.a, 'A');
    let out = s.swap(['doctor']).out;
    assert.match(out, /^ok {3}node /m);
    assert.match(out, /^FIX .*\.claude-second holds Work: not signed in, run swaphat login/m);
    assert.match(out, /^ok {3}.*settings\.json has the \/swap hook/m);
    s.login(s.b, 'B');
    out = s.swap(['doctor']).out;
    assert.doesNotMatch(out, /^FIX/m);
    assert.match(out, /the two dirs hold different accounts/);
  } finally { s.done(); }
});

test('macOS keychain logins are swapped', { skip: process.platform !== 'darwin' }, () => {
  const s = sandbox();
  const kc = path.join(s.home, 'swap-test.keychain-db');
  const sec = (...args) => cp.spawnSync('security', args, { encoding: 'utf8' });
  try {
    assert.equal(sec('create-keychain', '-p', 'test', kc).status, 0);
    sec('unlock-keychain', '-p', 'test', kc);
    s.install();
    const hash = p => require('crypto').createHash('sha256').update(path.resolve(p).normalize('NFC')).digest('hex').slice(0, 8);
    const services = { [s.a]: 'Claude Code-credentials', [s.b]: `Claude Code-credentials-${hash(s.b)}` };
    for (const [dir, tok] of [[s.a, 'A'], [s.b, 'B']])
      assert.equal(sec('add-generic-password', '-a', 'claude-code-user', '-s', services[dir], '-w', JSON.stringify({ claudeAiOauth: { refreshToken: `rt-${tok}` } }), kc).status, 0);
    const read = dir => {
      const t = sec('find-generic-password', '-s', services[dir], '-w', kc).stdout.trim();
      return JSON.parse(/^[0-9a-f]+$/i.test(t) ? Buffer.from(t, 'hex').toString('utf8') : t).claudeAiOauth.refreshToken;
    };
    const env = { SWAPHAT_KEYCHAIN: kc };
    assert.match(s.swap(['doctor'], { env }).out, /signed in, keychain/);
    assert.equal(s.swap([], { env }).out, 'swapped to Second');
    assert.equal(read(s.a), 'rt-B');
    assert.equal(read(s.b), 'rt-A');
    assert.equal(s.swap([], { env }).out, 'swapped to Main');
    assert.equal(read(s.a), 'rt-A');
  } finally { sec('delete-keychain', kc); s.done(); }
});

test('hook: /swap stops the prompt with one line, other commands pass through', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work');
    s.login(s.a, 'A'); s.login(s.b, 'B');
    const ev = (name, args) => JSON.stringify({ hook_event_name: 'UserPromptExpansion', command_name: name, command_args: args });
    const out = JSON.parse(s.swap(['hook'], { input: ev('swap', '') }).out);
    assert.deepEqual(out, { continue: false, stopReason: 'swapped to Work', suppressOutput: true });
    assert.equal(JSON.parse(s.swap(['hook'], { input: ev('swap', 'status') }).out).stopReason, 'on Work, auto swap off');
    assert.equal(s.swap(['hook'], { input: ev('review', '') }).out, '');
    assert.equal(s.swap(['hook'], { input: 'not json' }).out, '');
    assert.equal(JSON.parse(s.swap(['hook'], { input: '\uFEFF' + ev('swap', 'status') }).out).stopReason, 'on Work, auto swap off', 'tolerates a BOM');
  } finally { s.done(); }
});

test('auto swap: only when on, only on rate limits, never twice within 5 minutes', () => {
  const s = sandbox();
  try {
    s.install();
    s.login(s.a, 'A'); s.login(s.b, 'B');
    const fail = err => s.swap(['hook'], { input: JSON.stringify({ hook_event_name: 'StopFailure', error: err }) });
    fail('rate_limit');
    assert.equal(s.token(s.a), 'rt-A', 'auto is off by default');
    assert.match(s.swap(['auto', 'on']).out, /^auto swap on/);
    fail('server_error');
    assert.equal(s.token(s.a), 'rt-A', 'ignores other errors');
    fail('rate_limit');
    assert.equal(s.token(s.a), 'rt-B');
    fail('rate_limit');
    assert.equal(s.token(s.a), 'rt-B', 'guard stops ping-pong');
    assert.equal(s.swap(['auto', 'off']).out, 'auto swap off');
  } finally { s.done(); }
});

test('status line shows the account in this dir', () => {
  const s = sandbox();
  try {
    s.install('--names', 'Personal,Work');
    const strip = t => t.replace(/\x1b\[[0-9;]*m/g, '');
    const line = s.run(path.join(s.app, 'statusline.js'), [], { input: JSON.stringify({ rate_limits: { five_hour: { used_percentage: 42 } }, context_window: { used_percentage: 10 } }) }).out;
    assert.equal(strip(line), 'Personal | 5h 42% | ctx 10%');
  } finally { s.done(); }
});

test('uninstall swaps back and removes only its own entries', () => {
  const s = sandbox();
  try {
    fs.mkdirSync(s.a, { recursive: true });
    fs.writeFileSync(path.join(s.a, 'settings.json'), JSON.stringify({ model: 'x' }));
    s.install();
    s.login(s.a, 'A'); s.login(s.b, 'B');
    s.swap([]);
    const r = s.install('--uninstall');
    assert.equal(r.code, 0, r.err);
    assert.equal(s.token(s.a), 'rt-A', 'logins put back');
    assert.deepEqual(s.json(path.join(s.a, 'settings.json')), { model: 'x' });
    assert.ok(!fs.existsSync(path.join(s.a, 'commands', 'swap.md')));
    assert.ok(!fs.existsSync(s.app));
  } finally { s.done(); }
});

test('cli passes commands through to the installed copy', () => {
  const s = sandbox();
  try {
    assert.match(s.run(path.join(ROOT, 'cli.js'), ['status']).err, /not installed/);
    s.run(path.join(ROOT, 'cli.js'), ['install', '--names', 'One,Two']);
    assert.equal(s.run(path.join(ROOT, 'cli.js'), ['status']).out, 'on One, auto swap off');
  } finally { s.done(); }
});
