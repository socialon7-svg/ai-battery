const path = require('path');
const root = path.join(__dirname, '..');
const red = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'string' && v.length > 120 ? v.slice(0, 120) + '...' : v)));
(async () => {
  for (const id of ['claude', 'codex', 'antigravity']) {
    const t = Date.now();
    const p = require(path.join(root, 'src/providers', id + '.js'));
    const r = await p.fetchUsage();
    console.log(`\n=== ${id} (${Date.now() - t} ms)`);
    console.log(JSON.stringify(red(r), null, 1).slice(0, 1500));
  }
})();
