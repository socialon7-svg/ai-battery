// Local hook server: routing, token, browser-origin rejection, body limits.
const assert = require('assert');
const http = require('http');
const { startServer, MAX_BODY } = require('../src/server');

const TOKEN = 'c'.repeat(32);

function req(port, { method = 'POST', path = '/hook/claude/stop', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { 'Content-Length': Buffer.byteLength(body), ...headers } }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: s }));
    });
    r.on('error', reject);
    r.end(body);
  });
}

(async () => {
  const events = [];
  const server = await startServer({ port: 0, token: TOKEN, onEvent: (e) => events.push(e) });
  const port = server.address().port;
  const json = { 'Content-Type': 'application/json', 'X-AI-Battery': TOKEN };
  let n = 0;
  const test = async (name, fn) => { await fn(); n++; console.log('  ok', name); };

  await test('valid hook POST is accepted and parsed', async () => {
    const r = await req(port, { headers: json, body: JSON.stringify({ notification_type: 'permission_prompt', message: '한글 메시지' }) });
    assert.strictEqual(r.status, 200);
    assert.deepStrictEqual(events.pop(), { provider: 'claude', kind: 'stop', payload: { notification_type: 'permission_prompt', message: '한글 메시지' } });
  });

  await test('multi-byte body split across chunks still parses', async () => {
    const big = JSON.stringify({ message: '가'.repeat(40000) });
    const r = await req(port, { headers: json, body: big });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(events.pop().payload.message.length, 40000);
  });

  await test('missing or wrong token → 401, no event', async () => {
    const before = events.length;
    assert.strictEqual((await req(port, { headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.strictEqual((await req(port, { headers: { ...json, 'X-AI-Battery': 'nope' }, body: '{}' })).status, 401);
    assert.strictEqual(events.length, before);
  });

  await test('browser-style request (Origin / Sec-Fetch-Site) → 403 even with the token', async () => {
    const before = events.length;
    assert.strictEqual((await req(port, { headers: { ...json, Origin: 'https://evil.example' }, body: '{}' })).status, 403);
    assert.strictEqual((await req(port, { headers: { ...json, 'Sec-Fetch-Site': 'cross-site' }, body: '{}' })).status, 403);
    assert.strictEqual(events.length, before);
  });

  await test('non-JSON content type → 415', async () => {
    assert.strictEqual((await req(port, { headers: { 'Content-Type': 'text/plain', 'X-AI-Battery': TOKEN }, body: '{}' })).status, 415);
  });

  await test('unknown route / method → 404; /health → 200', async () => {
    assert.strictEqual((await req(port, { headers: json, path: '/hook/claude/stop/extra', body: '{}' })).status, 404);
    assert.strictEqual((await req(port, { headers: json, path: '/hook/other/stop', body: '{}' })).status, 404);
    assert.strictEqual((await req(port, { method: 'GET', path: '/health' })).status, 200);
    assert.strictEqual((await req(port, { method: 'GET', path: '/' })).status, 404);
  });

  await test('invalid JSON or non-object JSON still counts as a ping with empty payload', async () => {
    await req(port, { headers: json, body: 'not json' });
    assert.deepStrictEqual(events.pop().payload, {});
    await req(port, { headers: json, body: '[1,2]' });
    assert.deepStrictEqual(events.pop().payload, {});
  });

  await test('oversized body → 413 and no event', async () => {
    const before = events.length;
    const r = await req(port, { headers: json, body: '{"a":"' + 'x'.repeat(MAX_BODY + 10) + '"}' }).catch((e) => ({ status: 'err', body: e.message }));
    assert.ok(r.status === 413 || r.status === 'err', `got ${r.status}`);
    assert.strictEqual(events.length, before);
  });

  await test('a throwing handler does not break the response', async () => {
    const s2 = await startServer({ port: 0, token: null, onEvent: () => { throw new Error('boom'); } });
    const r = await req(s2.address().port, { headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.strictEqual(r.status, 200);
    s2.close();
  });

  server.close();
  console.log(`server: ${n} tests passed`);
})().catch((e) => { console.error(e); process.exit(1); });
