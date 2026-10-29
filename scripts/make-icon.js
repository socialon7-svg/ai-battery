'use strict';
// Writes build/icon.png (512x512) for electron-builder, which turns it into .ico / .icns.
const fs = require('fs');
const path = require('path');
const { drawBattery } = require('../src/png');

const dir = path.join(__dirname, '..', 'build');
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, 'icon.png');
fs.writeFileSync(out, drawBattery(512, 80, false));
console.log('wrote', out);
