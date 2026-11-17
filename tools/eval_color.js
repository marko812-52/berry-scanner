#!/usr/bin/env node
/*
 * Проганяє кольоровий метод (той самий код, що в браузері) на підготовлених даних для порівняння з моделлю.
 *   node tools/eval_color.js [test|val]
 * Читає datasets/prepared/<split>/meta.jsonl, пише datasets/eval/color/<split>/<ім'я>.png — карта класів
 * єдиної таксономії (0 фон, 1..5), де «поза зоною» і «фон / інше» = 0. Профіль ягоди береться з meta.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BS, loadJpeg } = require('./lib.js');

const split = process.argv[2] || 'test';
const root = path.join(__dirname, '..');
const src = path.join(root, 'datasets', 'prepared', split);
const out = path.join(root, 'datasets', 'eval', 'color', split);
fs.mkdirSync(out, { recursive: true });

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
function writeGrayPng(file, data, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

const meta = fs.readFileSync(path.join(src, 'meta.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const t0 = Date.now();
const summary = {};
meta.forEach((m, i) => {
  const img = loadJpeg(path.join(src, m.file + '.jpg'));
  const settings = Object.assign(BS.cloneSettings(BS.DEFAULT_SETTINGS), { profile: BS.PROFILES[m.species] ? m.species : 'blackberry' });
  // плитки синтетичних лотків і RaspberrySet вирізано з кадру масштабу 1024 px — масштаб пікселя 1
  const opts = (m.source === 'synth' || m.source === 'raspberryset' || m.source === 'custom') ? { pxScale: 1 } : {};
  const r = BS.analyze(img.data, img.w, img.h, settings, opts);
  if (r.w !== img.w || r.h !== img.h) throw new Error('розмір змінився: ' + m.file);
  const lab = new Uint8Array(r.labels.length);
  for (let k = 0; k < lab.length; k++) { const v = r.labels[k]; lab[k] = v === BS.CLASSES.OTHER ? 0 : v; }
  writeGrayPng(path.join(out, m.file + '.png'), lab, r.w, r.h);
  summary[m.file] = { percents: r.percents, berryFraction: r.berryFraction, moldSpots: r.moldSpots };
  if ((i + 1) % 200 === 0) console.log(`${i + 1}/${meta.length} · ${((Date.now() - t0) / 1000).toFixed(0)} с`);
});
fs.writeFileSync(path.join(out, 'summary.json'), JSON.stringify(summary));
console.log(`Готово: ${meta.length} зображень → ${out}`);
