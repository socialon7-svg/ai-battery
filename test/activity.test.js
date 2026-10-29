// Activity state machine: the "attention" (permission prompt) flag must survive periodic transcript
// recomputes and clear only when the transcript moves on, the turn ends, or it goes stale.
const assert = require('assert');
const { Activity } = require('../src/watchers');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };

test('attention survives a repeated recompute with the same (older) transcript state', () => {
  const a = new Activity('claude');
  const t0 = Date.now() - 5000;
  a.set('working', '도구 실행 중', t0);
  a.markAttention('허가 대기 중');
  assert.strictEqual(a.attention, true);
  assert.strictEqual(a.detail, '허가 대기 중');
  a.set('working', '도구 실행 중', t0);           // periodic recompute, nothing new
  a.set('working', '도구 실행 중', t0);
  assert.strictEqual(a.attention, true);
  assert.strictEqual(a.snapshot().attentionDetail, '허가 대기 중');
});

test('attention clears when the transcript shows the tool result (newer, different detail)', () => {
  const a = new Activity('claude');
  a.set('working', '도구 실행 중', Date.now() - 5000);
  a.markAttention();
  a.set('working', '생각 중', Date.now() + 10);
  assert.strictEqual(a.attention, false);
  assert.strictEqual(a.detail, '생각 중');
});

test('attention clears on done() and on idle', () => {
  const a = new Activity('claude');
  a.markAttention();
  a.done({ detail: 'x' });
  assert.strictEqual(a.attention, false);
  assert.strictEqual(a.status, 'done');
  a.markAttention();
  a.set('idle');
  assert.strictEqual(a.attention, false);
});

test('attention without any transcript state (hooks only) is kept until done', () => {
  const a = new Activity('claude');
  a.markAttention();
  a.set('working', '', null);
  assert.strictEqual(a.attention, true);
  a.done();
  assert.strictEqual(a.attention, false);
});

test('change events fire once per real change', () => {
  const a = new Activity('codex');
  let changes = 0;
  a.on('change', () => changes++);
  a.set('working', '작업 중', 1);
  a.set('working', '작업 중', 2);
  a.set('done');
  assert.strictEqual(changes, 2);
});

console.log(`activity: ${n} tests passed`);
