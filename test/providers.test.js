// Pure normalisation functions of the three providers (no network, no processes).
const assert = require('assert');
const claude = require('../src/providers/claude');
const codex = require('../src/providers/codex');
const ag = require('../src/providers/antigravity');

let n = 0;
const test = (name, fn) => { fn(); n++; console.log('  ok', name); };

test('claude.pickMain picks the lowest remaining window (weekly can beat 5h)', () => {
  const w = [{ key: 'five_hour', remaining: 90, order: 0 }, { key: 'seven_day', remaining: 12, order: 1 }, { key: 'seven_day_opus', remaining: 12, order: 2 }];
  assert.strictEqual(claude.pickMain(w).key, 'seven_day');
});

test('codex.normalizeApi: shortest window wins ties, resets computed from reset_after_seconds', () => {
  const now = Date.now();
  const r = codex.normalizeApi({
    plan_type: 'plus',
    rate_limit: {
      primary_window: { used_percent: 40, limit_window_seconds: 18000, reset_after_seconds: 600 },
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: Math.floor(now / 1000) + 86400 },
    },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.connected, true);
  assert.strictEqual(r.main.label, '5시간');
  assert.strictEqual(r.main.remaining, 60);
  assert.ok(Math.abs(r.main.resetsAt - (now + 600000)) < 5000);
  assert.strictEqual(r.extra[0].label, '주간');
  assert.strictEqual(r.meta.plan, 'Plus');
});

test('codex.normalizeApi: the more depleted window becomes main even when it is the long one', () => {
  const r = codex.normalizeApi({ rate_limit: {
    primary_window: { used_percent: 10, limit_window_seconds: 18000 },
    secondary_window: { used_percent: 95, limit_window_seconds: 604800 },
  } });
  assert.strictEqual(r.main.label, '주간');
  assert.strictEqual(r.main.remaining, 5);
});

test('codex.normalizeApi returns null without rate_limit or windows', () => {
  assert.strictEqual(codex.normalizeApi({}), null);
  assert.strictEqual(codex.normalizeApi({ rate_limit: {} }), null);
});

test('codex.normalizeRollout: an elapsed reset means 100% again and is flagged', () => {
  const ts = Date.now() - 2 * 3600 * 1000;
  const r = codex.normalizeRollout({ plan_type: 'pro', primary: { used_percent: 80, window_minutes: 300, resets_in_seconds: 600 }, secondary: { used_percent: 30, window_minutes: 10080, resets_in_seconds: 500000 } }, ts);
  assert.strictEqual(r.meta.stale, true);
  assert.strictEqual(r.meta.asOf, ts);
  const five = [r.main, ...r.extra].find((w) => w.label === '5시간');
  assert.strictEqual(five.remaining, 100);
  assert.strictEqual(five.reset, true);
  assert.strictEqual(r.main.label, '주간'); // 70% left beats the reset 100%
});

test('codex.labelForMinutes', () => {
  assert.strictEqual(codex.labelForMinutes(300), '5시간');
  assert.strictEqual(codex.labelForMinutes(10080), '주간');
  assert.strictEqual(codex.labelForMinutes(2880), '2일');
  assert.strictEqual(codex.labelForMinutes(90), '90분');
  assert.strictEqual(codex.labelForMinutes(0), '한도');
});

test('antigravity.normalize: families merge to the lowest pool, missing remainingFraction = 0, recommended breaks ties', () => {
  const r = ag.normalize({ userStatus: {
    userTier: { name: 'Pro' },
    cascadeModelConfigData: { clientModelConfigs: [
      { label: 'Gemini 3 Pro (High)', quotaInfo: { remainingFraction: 0.9, resetTime: '2030-01-01T00:00:00Z' } },
      { label: 'Gemini 3 Pro (Low)', quotaInfo: { remainingFraction: 0.4, resetTime: '2030-01-01T00:00:00Z' } },
      { label: 'Claude Opus', isRecommended: true, quotaInfo: { resetTime: '2030-01-02T00:00:00Z' } },
      { label: 'Claude Sonnet', quotaInfo: { remainingFraction: 0.0 } },
      { label: 'No quota model' },
    ] },
  } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.main.label, 'Claude Opus'); // 0% and recommended
  assert.strictEqual(r.main.remaining, 0);
  const gem = r.extra.find((x) => x.label === 'Gemini 3 Pro');
  assert.strictEqual(gem.remaining, 40);
  assert.strictEqual(r.extra.length, 2);
  assert.strictEqual(r.meta.plan, 'Pro');
  assert.strictEqual(r.meta.models, 5);
});

test('antigravity.normalize returns null with no quota data', () => {
  assert.strictEqual(ag.normalize({}), null);
  assert.strictEqual(ag.familyOf('Gemini 3 Flash (Fast)'), 'Gemini 3 Flash');
});

console.log(`providers: ${n} tests passed`);
