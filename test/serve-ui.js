// Static server for previewing the renderer (mock mode) in a normal browser. PORT env overrides 47899.
const http = require('http');
const fs = require('fs');
const path = require('path');
const dir = path.join(__dirname, '..', 'src', 'renderer');
const PORT = Number(process.env.PORT) || 47899;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' };
http.createServer((req, res) => {
  const p = path.join(dir, req.url === '/' ? 'index.html' : decodeURIComponent(req.url.split('?')[0]));
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('nope'); }
    res.writeHead(200, { 'Content-Type': types[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}).listen(PORT, '127.0.0.1', () => console.log('ui preview on http://127.0.0.1:' + PORT));
