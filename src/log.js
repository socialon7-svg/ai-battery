'use strict';
// Small rotating file logger (userData/logs/ai-battery.log) that also mirrors to the console.
const fs = require('fs');
const path = require('path');

const MAX_BYTES = 1024 * 1024;

function createLogger(dir) {
  const file = path.join(dir, 'ai-battery.log');
  let ready = false;
  const ensure = () => {
    if (ready) return;
    fs.mkdirSync(dir, { recursive: true });
    ready = true;
  };
  const rotate = () => {
    try {
      if (fs.statSync(file).size > MAX_BYTES) fs.renameSync(file, file + '.1');
    } catch { /* no file yet */ }
  };
  const fmt = (v) => (v instanceof Error ? (v.stack || v.message) : typeof v === 'string' ? v : JSON.stringify(v));
  const log = (...args) => {
    const line = `${new Date().toISOString()} ${args.map(fmt).join(' ')}`;
    console.log(line.slice(11, 19), ...args);
    try { ensure(); rotate(); fs.appendFileSync(file, line + '\n'); } catch { /* disk problems never break the app */ }
  };
  log.file = file;
  log.dir = dir;
  return log;
}

module.exports = { createLogger };
