// Допоміжне для Node: читання JPEG, запис PNG, завантаження ядра. Лише для тестів і налагодження.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const decodeJpeg = require('./vendor/jpeg-decoder.js');

const BS = require('../js/core/defaults.js');
require('../js/core/segment.js');
require('../js/core/verdict.js');

function loadJpeg(file) {
  const img = decodeJpeg(fs.readFileSync(file), { useTArray: true, formatAsRGBA: true });
  return { data: new Uint8ClampedArray(img.data.buffer, img.data.byteOffset, img.data.length), w: img.width, h: img.height };
}

const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type), body]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writePng(file, rgba, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

// Накладає шар (RGBA з прозорістю) на фото того самого розміру.
function composite(photo, overlay, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const p = i * 4, a = overlay[p + 3] / 255;
    out[p] = photo[p] * (1 - a) + overlay[p] * a;
    out[p + 1] = photo[p + 1] * (1 - a) + overlay[p + 1] * a;
    out[p + 2] = photo[p + 2] * (1 - a) + overlay[p + 2] * a;
    out[p + 3] = 255;
  }
  return out;
}

module.exports = { BS, loadJpeg, writePng, composite };
