'use strict';
// Local-only HTTP endpoint that the installed Claude Code hooks and Codex notify POST to.
// Accepts only: POST /hook/<provider>/<kind>, JSON body, our shared token, and no browser Origin.
const http = require('http');

const MAX_BODY = 256 * 1024;
const ROUTE = /^\/hook\/(claude|codex|antigravity)\/([a-z]+)$/;

function startServer({ port, token, onEvent, log = () => {} }) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const done = (code, text) => { res.writeHead(code, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(text || ''); };
      const url = (req.url || '').split('?')[0];
      if (req.method === 'GET' && url === '/health') return done(200, 'ok');
      const m = req.method === 'POST' && ROUTE.exec(url);
      if (!m) return done(404, 'not found');
      // A browser page cannot set a custom header without CORS, and always sends Origin: reject both.
      if (req.headers.origin !== undefined || req.headers['sec-fetch-site'] !== undefined) return done(403, 'forbidden');
      if (token && req.headers['x-ai-battery'] !== token) return done(401, 'unauthorized');
      if (!/^application\/json\b/i.test(String(req.headers['content-type'] || ''))) return done(415, 'json only');

      const chunks = [];
      let size = 0;
      let rejected = false;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { rejected = true; done(413, 'too large'); req.destroy(); return; }
        chunks.push(c);
      });
      req.on('error', () => { /* client went away */ });
      req.on('end', () => {
        if (rejected) return;
        let payload = {};
        try {
          const j = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          if (j && typeof j === 'object' && !Array.isArray(j)) payload = j;
        } catch { /* not JSON: still a valid "something happened" ping */ }
        try { onEvent({ provider: m[1], kind: m[2], payload }); } catch (e) { log('hook handler failed:', e.message); }
        done(200, 'ok');
      });
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { startServer, MAX_BODY };
