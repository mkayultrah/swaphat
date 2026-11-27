'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const ROOT = path.join(__dirname, '..');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-swap-test-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: process.env.PATH };
  delete env.CLAUDE_CONFIG_DIR; delete env.CLAUDE_SWAP_HOME; delete env.CLAUDE_CODE_ENTRYPOINT;
  const app = path.join(home, '.claude-swap');
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
      assert.ok(fs.readFileSync(path.join(d, 'commands', 'swap.md'), 'utf8').includes('claude-swap'));
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
    assert.ok(fs.existsSync(path.join(s.a, 'settings.json.claude-swap-backup')));
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
    assert.match(r.out, process.platform === 'darwin' ? /^cant swap: on macOS/ : /^cant swap: no claude\.ai login/);
    assert.equal(s.token(s.a), 'rt-A');
    assert.equal(s.json(path.join(s.app, 'state.json')).swapped, false);
  } finally { s.done(); }
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
