'use strict';
// Dependency-free PNG encoder + battery icon drawing (used for tray / window icons).
const zlib = require('zlib');

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePNG(w, h, rgba) {
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

class Canvas {
  constructor(w, h) { this.w = w; this.h = h; this.data = Buffer.alloc(w * h * 4); }
  px(x, y, c) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0]; this.data[i + 1] = c[1]; this.data[i + 2] = c[2];
    this.data[i + 3] = c[3] === undefined ? 255 : c[3];
  }
  rect(x, y, w, h, c) { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.px(i, j, c); }
  png() { return encodePNG(this.w, this.h, this.data); }
}

const COLORS = {
  ok: [61, 220, 132],
  warn: [245, 185, 66],
  low: [255, 92, 92],
  unknown: [120, 128, 140],
  line: [170, 178, 190],
  working: [96, 165, 250],
};

function levelColor(remaining) {
  if (remaining === null || remaining === undefined || Number.isNaN(remaining)) return COLORS.unknown;
  if (remaining <= 20) return COLORS.low;
  if (remaining <= 50) return COLORS.warn;
  return COLORS.ok;
}

// Draws a horizontal battery on a 16x16 grid scaled to `size`. opts.outline overrides the shell colour.
function drawBattery(size, remaining, working, opts = {}) {
  const k = size / 16;
  const S = (v) => Math.round(v * k);
  const c = new Canvas(size, size);
  const t = Math.max(1, S(1));
  const bx = S(1), by = S(4), bw = S(12), bh = S(8);
  const line = opts.outline || COLORS.line; // light menu bars (macOS) want a dark outline
  c.rect(bx, by, bw, t, line);
  c.rect(bx, by + bh - t, bw, t, line);
  c.rect(bx, by, t, bh, line);
  c.rect(bx + bw - t, by, t, bh, line);
  c.rect(bx + bw, by + S(2), Math.max(1, S(1)), bh - S(4), line); // nub
  const gap = Math.max(0, S(0.5));
  const ix = bx + t + gap, iy = by + t + gap, iw = bw - 2 * (t + gap), ih = bh - 2 * (t + gap);
  if (remaining !== null && remaining !== undefined && !Number.isNaN(remaining)) {
    const r = Math.max(0, Math.min(100, remaining));
    const fw = r > 0 ? Math.max(1, Math.round((iw * r) / 100)) : 0;
    c.rect(ix, iy, fw, ih, levelColor(r));
  } else {
    // unknown: a dim centre dot
    c.rect(ix + Math.floor(iw / 2) - S(0.5), iy + Math.floor(ih / 2) - S(0.5), Math.max(1, S(1)), Math.max(1, S(1)), COLORS.unknown);
  }
  if (working) {
    const d = Math.max(2, S(3));
    c.rect(size - d - Math.max(0, S(0.5)), Math.max(0, S(0.5)), d, d, COLORS.working);
  }
  return c.png();
}

module.exports = { encodePNG, drawBattery, levelColor, COLORS };
