'use strict';
// Optional vibration through SteelSeries GameSense: tactile mice such as the Rival 700/710
// expose a "vibrate" handler on the local SteelSeries GG / Engine HTTP API. Everything here fails
// silently when the software or device is absent. Gamepad rumble is handled in the renderer.
const fs = require('fs');
const path = require('path');
const http = require('http');

const GAME = 'AI_BATTERY';
const PATTERNS = {
  done: [{ type: 'ti_predefined_strongclick_100' }, { type: 'ti_predefined_strongclick_100', 'delay-ms': 150 }],
  attention: [
    { type: 'ti_predefined_buzz_100' }, { type: 'ti_predefined_buzz_100', 'delay-ms': 220 }, { type: 'ti_predefined_buzz_100', 'delay-ms': 220 },
  ],
};

function propsFile() {
  if (process.platform === 'win32') {
    return path.join(process.env.PROGRAMDATA || 'C:\\ProgramData', 'SteelSeries', 'SteelSeries Engine 3', 'coreProps.json');
  }
  return '/Library/Application Support/SteelSeries Engine 3/coreProps.json';
}

function address() {
  try { return JSON.parse(fs.readFileSync(propsFile(), 'utf8')).address || null; } catch { return null; }
}

function post(addr, route, body) {
  return new Promise((resolve) => {
    const i = addr.lastIndexOf(':');
    const host = addr.slice(0, i) || '127.0.0.1';
    const port = Number(addr.slice(i + 1));
    const data = JSON.stringify(body);
    const req = http.request({
      host, port, path: route, method: 'POST', timeout: 1500,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.end(data);
  });
}

let counter = 0;

async function register(addr) {
  await post(addr, '/game_metadata', { game: GAME, game_display_name: 'AI Battery', developer: 'local', deinitialize_timer_length_ms: 60000 });
  for (const ev of Object.keys(PATTERNS)) {
    await post(addr, '/bind_game_event', {
      game: GAME, event: ev.toUpperCase(), min_value: 0, max_value: 100, icon_id: 0, value_optional: true,
      handlers: [{ 'device-type': 'tactile', zone: 'one', mode: 'vibrate', pattern: PATTERNS[ev] }],
    });
  }
}

// Returns true when a SteelSeries device acknowledged the event.
async function vibrate(kind) {
  const addr = address();
  if (!addr) return false;
  await register(addr); // cheap local calls; re-binding each time survives GG restarts
  counter = (counter % 100) + 1;
  const ev = (PATTERNS[kind] ? kind : 'done').toUpperCase();
  const status = await post(addr, '/game_event', { game: GAME, event: ev, data: { value: counter } });
  return status === 200;
}

function available() { return !!address(); }

module.exports = { vibrate, available };
