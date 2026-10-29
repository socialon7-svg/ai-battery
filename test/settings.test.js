// Settings store: defaults, migration, validation, corrupt file, atomic write.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Settings = require('../src/settings');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aib-settings-'));
const file = path.join(tmp, 'settings.json');
let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };

test('first run: defaults, a hook token, and the file is written', () => {
  const s = new Settings(file);
  const d = s.get();
  assert.strictEqual(d.v, Settings.VERSION);
  assert.strictEqual(d.alwaysOnTop, true);
  assert.match(d.hookToken, /^[a-f0-9]{32}$/);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).hookToken, d.hookToken);
});

test('token is stable across restarts', () => {
  const a = new Settings(file).get().hookToken;
  const b = new Settings(file).get().hookToken;
  assert.strictEqual(a, b);
});

test('v1 file migrates: alwaysOnTop forced on, unknown keys dropped, alerts merged', () => {
  fs.writeFileSync(file, JSON.stringify({ sound: false, alwaysOnTop: false, startHidden: true, alerts: { codex: false } }));
  const d = new Settings(file).get();
  assert.strictEqual(d.v, Settings.VERSION);
  assert.strictEqual(d.sound, false);
  assert.strictEqual(d.alwaysOnTop, true);
  assert.strictEqual(d.startHidden, undefined);
  assert.deepStrictEqual(d.alerts, { claude: true, codex: false, antigravity: true });
});

test('save validates: clamps numbers, ignores junk, keeps partial objects merged', () => {
  const s = new Settings(file);
  s.save({ pollSeconds: 1, quietSeconds: 99999, hookOptOut: { claude: true }, bounds: { x: 10.4, y: 'nope' }, evil: 1, sound: 'yes' });
  const d = s.get();
  assert.strictEqual(d.pollSeconds, 15);
  assert.strictEqual(d.quietSeconds, 300);
  assert.deepStrictEqual(d.hookOptOut, { claude: true, codex: false });
  assert.strictEqual(d.bounds, null);
  assert.strictEqual(d.evil, undefined);
  assert.strictEqual(d.sound, false); // junk ignored, previous value kept
  s.save({ bounds: { x: 10.4, y: 20 } });
  assert.deepStrictEqual(s.get().bounds, { x: 10, y: 20 });
  s.save({ bounds: null });
  assert.strictEqual(s.get().bounds, null);
});

test('corrupt file → defaults, then rewritten cleanly', () => {
  fs.writeFileSync(file, '{ broken');
  const d = new Settings(file).get();
  assert.strictEqual(d.pollSeconds, 60);
  assert.doesNotThrow(() => JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.ok(!fs.existsSync(file + '.tmp'), 'temp file renamed away');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`settings: ${n} tests passed`);
