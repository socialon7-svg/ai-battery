// Runs every test/*.test.js in its own process and reports. `--unit` skips the slow watcher test.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const unitOnly = process.argv.includes('--unit');
const dir = __dirname;
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.js')).sort()
  .filter((f) => !(unitOnly && f === 'watchers.test.js'))
  .sort((a, b) => (a === 'watchers.test.js') - (b === 'watchers.test.js')); // slow one last

let failed = 0;
for (const f of files) {
  const t = Date.now();
  const r = spawnSync(process.execPath, [path.join(dir, f)], { stdio: 'inherit' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}  (${Date.now() - t} ms)\n`);
}
console.log(failed ? `${failed} test file(s) failed` : `all ${files.length} test files passed`);
process.exit(failed ? 1 : 0);
