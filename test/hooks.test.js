// Hook / notify installer: idempotency, user data preservation, TOML edge cases, backups, staleness.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-hooks-'));
process.env.CLAUDE_CONFIG_DIR = path.join(tmp, 'claude');
process.env.CODEX_HOME = path.join(tmp, 'codex');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });

const h = require('../src/hooks');
const PORT = 47831;
const TOKEN = 'a'.repeat(32);
const sf = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const cf = path.join(process.env.CODEX_HOME, 'config.toml');
const read = (f) => fs.readFileSync(f, 'utf8');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };

// ---------- Claude ----------
test('claude: fresh install creates both hooks and reports installed', () => {
  fs.rmSync(sf, { force: true });
  const st = h.installClaude(PORT, TOKEN);
  assert.strictEqual(st.installed, true);
  const s = JSON.parse(read(sf));
  assert.strictEqual(s.hooks.Stop.length, 1);
  assert.strictEqual(s.hooks.Notification.length, 1);
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes(`X-AI-Battery: ${TOKEN}`));
});

test('claude: install is idempotent', () => {
  h.installClaude(PORT, TOKEN);
  const s = JSON.parse(read(sf));
  assert.strictEqual(s.hooks.Stop.length, 1);
});

test('claude: user hooks in the same group and other keys survive install/uninstall; indent + CRLF kept', () => {
  const orig = JSON.stringify({
    model: 'opus',
    hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo pre' }] }] },
  }, null, '\t').replace(/\n/g, '\r\n');
  fs.writeFileSync(sf, orig);
  h.installClaude(PORT, TOKEN);
  let raw = read(sf);
  assert.ok(raw.includes('\r\n') && raw.includes('\n\t"'), 'tab indent and CRLF preserved');
  let s = JSON.parse(raw);
  assert.strictEqual(s.model, 'opus');
  assert.strictEqual(s.hooks.Stop.length, 2);
  assert.strictEqual(s.hooks.Stop[0].hooks[0].command, 'echo mine');
  assert.strictEqual(s.hooks.PreToolUse.length, 1);
  h.uninstallClaude(PORT, TOKEN);
  s = JSON.parse(read(sf));
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
  assert.strictEqual(s.hooks.Notification, undefined);
  assert.strictEqual(h.claudeStatus(PORT, TOKEN).ours, false);
});

test('claude: hooks for an old port/token are "stale" and get replaced, not duplicated', () => {
  fs.rmSync(sf, { force: true });
  h.installClaude(50000, 'b'.repeat(32));
  const st = h.claudeStatus(PORT, TOKEN);
  assert.strictEqual(st.installed, false);
  assert.strictEqual(st.stale, true);
  h.installClaude(PORT, TOKEN);
  const s = JSON.parse(read(sf));
  assert.strictEqual(s.hooks.Stop.length, 1);
  assert.ok(s.hooks.Stop[0].hooks[0].command.includes(`127.0.0.1:${PORT}/`));
  assert.strictEqual(h.claudeStatus(PORT, TOKEN).installed, true);
});

test('claude: our hook inside a group with user hooks is removed alone', () => {
  const ours = h.command(PORT, TOKEN, 'stop');
  fs.writeFileSync(sf, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }, { type: 'command', command: ours }] }] } }));
  h.uninstallClaude(PORT, TOKEN);
  const s = JSON.parse(read(sf));
  assert.deepStrictEqual(s.hooks.Stop, [{ hooks: [{ type: 'command', command: 'echo mine' }] }]);
});

test('claude: malformed settings.json reports an error and install throws (file untouched)', () => {
  fs.writeFileSync(sf, '{ not json');
  const st = h.claudeStatus(PORT, TOKEN);
  assert.ok(st.error);
  assert.throws(() => h.installClaude(PORT, TOKEN));
  assert.strictEqual(read(sf), '{ not json');
});

test('claude: the first backup is the original and is never overwritten', () => {
  fs.rmSync(sf + h.BAK, { force: true });
  fs.writeFileSync(sf, '{"model":"first"}');
  h.installClaude(PORT, TOKEN);
  h.uninstallClaude(PORT, TOKEN);
  h.installClaude(PORT, TOKEN);
  assert.strictEqual(read(sf + h.BAK), '{"model":"first"}');
});

test('claude: BOM is tolerated', () => {
  fs.writeFileSync(sf, '﻿{"model":"x"}');
  const st = h.installClaude(PORT, TOKEN);
  assert.strictEqual(st.installed, true);
  assert.strictEqual(JSON.parse(read(sf)).model, 'x');
});

// ---------- Codex ----------
test('codex: install into an empty/missing config, then idempotent', () => {
  fs.rmSync(cf, { force: true });
  let st = h.installCodex(PORT, TOKEN);
  assert.strictEqual(st.installed, true);
  st = h.installCodex(PORT, TOKEN);
  assert.strictEqual(read(cf).split('notify').length, 2, 'exactly one notify line');
});

test('codex: notify goes before the first table, after top-level keys, not inside a multi-line array', () => {
  fs.writeFileSync(cf, 'model = "gpt-5"\nmatrix = [\n  [1, 2],\n  [3, 4],\n]\nname = "x [not a table]"\n\n# MCP servers\n[mcp_servers.x]\ncommand = "y"\n');
  h.installCodex(PORT, TOKEN);
  const lines = read(cf).split('\n');
  const i = lines.findIndex((l) => l.startsWith('notify = '));
  assert.ok(i > lines.indexOf(']'), 'after the array closes');
  assert.ok(i < lines.indexOf('# MCP servers'), 'before the comment that belongs to the table');
  assert.strictEqual(lines.filter((l) => l.startsWith('notify')).length, 1);
  h.uninstallCodex(PORT, TOKEN);
  assert.strictEqual(read(cf), 'model = "gpt-5"\nmatrix = [\n  [1, 2],\n  [3, 4],\n]\nname = "x [not a table]"\n\n# MCP servers\n[mcp_servers.x]\ncommand = "y"\n');
});

test('codex: a foreign notify (even multi-line) is left alone and reported', () => {
  fs.writeFileSync(cf, '﻿model = "gpt-5"\r\nnotify = [\r\n  "python3",\r\n  "n.py",\r\n]\r\n\r\n[mcp_servers.x]\r\ncommand = "y"\r\n');
  const st = h.codexStatus(PORT, TOKEN);
  assert.strictEqual(st.foreign, true);
  assert.strictEqual(st.installed, false);
  assert.throws(() => h.installCodex(PORT, TOKEN), /다른 notify/);
});

test('codex: CRLF files stay CRLF through install and uninstall', () => {
  const orig = 'model = "gpt-5"\r\n\r\n[mcp_servers.x]\r\ncommand = "y"\r\n';
  fs.writeFileSync(cf, orig);
  h.installCodex(PORT, TOKEN);
  assert.ok(!/[^\r]\n/.test(read(cf)), 'no bare LF after install');
  h.uninstallCodex(PORT, TOKEN);
  assert.strictEqual(read(cf), orig);
});

test('codex: a notify inside a table is not top-level and does not count', () => {
  fs.writeFileSync(cf, 'model = "gpt-5"\n[profiles.a]\nnotify = ["x"]\n');
  const st = h.codexStatus(PORT, TOKEN);
  assert.strictEqual(st.foreign, false);
  h.installCodex(PORT, TOKEN);
  const lines = read(cf).split('\n');
  assert.ok(lines.indexOf('[profiles.a]') > lines.findIndex((l) => l.startsWith('notify = ["curl"')));
});

test('codex: our stale notify (other port/token) is replaced in place', () => {
  fs.writeFileSync(cf, 'model = "gpt-5"\n');
  h.installCodex(50000, 'b'.repeat(32));
  let st = h.codexStatus(PORT, TOKEN);
  assert.strictEqual(st.stale, true);
  assert.strictEqual(st.foreign, false);
  h.installCodex(PORT, TOKEN);
  st = h.codexStatus(PORT, TOKEN);
  assert.strictEqual(st.installed, true);
  assert.strictEqual(read(cf).split('notify').length, 2);
});

test('codex: scanner ignores brackets inside strings and comments, and multi-line strings', () => {
  const { tableAt, notify } = h.scanToml('a = "[not]" # [no]\nb = """\n[nope]\n"""\nnotify = ["x"]\n[real]\n');
  assert.strictEqual(tableAt, 5);
  assert.strictEqual(notify.index, 4);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`hooks: ${n} tests passed`);
