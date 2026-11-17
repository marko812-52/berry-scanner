#!/usr/bin/env node
/*
 * Автопідказка розмітки для власних фото в data/custom (кольоровим методом, той самий код, що в браузері).
 *   node tools/autolabel.js                    — усі JPEG без розмітки, профіль «ожина»
 *   node tools/autolabel.js --profile raspberry --force
 * Для кожного фото <ім'я>.jpg створює:
 *   <ім'я>.label.png    — карта класів (0 фон, 1 якісна, 2 недостигла, 3 пошкоджена, 4 пліснява, 5 домішки);
 *   <ім'я>.preview.png  — фото з кольоровим шаром, щоб оком перевірити підказку.
 * Підказка не є правдою: перегляньте превʼю і видаліть .label.png там, де вона погана, — таке фото в навчання не піде.
 * Профіль можна задати і в імені папки: data/custom/raspberry/*.jpg.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { BS, loadJpeg, writePng, composite } = require('./lib.js');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const force = !!opt('force', false);
const root = path.join(__dirname, '..', 'data', 'custom');
if (!fs.existsSync(root)) { console.error('Немає папки data/custom'); process.exit(1); }

function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) { c ^= buf[i]; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; } return (c ^ 0xffffffff) >>> 0; }
function chunk(type, body) {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type), body]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function writeGrayPng(file, data, w, h) {
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(data.buffer, data.byteOffset + y * w, w).copy(raw, y * (w + 1) + 1);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 0;
  fs.writeFileSync(file, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

let done = 0, skipped = 0;
for (const file of walk(root).filter((f) => /\.jpe?g$/i.test(f))) {
  const base = file.replace(/\.jpe?g$/i, '');
  if (!force && fs.existsSync(base + '.label.png')) { skipped++; continue; }
  const folder = path.basename(path.dirname(file));
  const profile = BS.PROFILES[folder] ? folder : opt('profile', 'blackberry');
  const img = loadJpeg(file);
  const settings = Object.assign(BS.cloneSettings(BS.DEFAULT_SETTINGS), { profile });
  const r = BS.analyze(img.data, img.w, img.h, settings);
  const lab = new Uint8Array(r.labels.length);
  for (let k = 0; k < lab.length; k++) lab[k] = r.labels[k] === BS.CLASSES.OTHER ? 0 : r.labels[k];
  writeGrayPng(base + '.label.png', lab, r.w, r.h);
  const small = BS.resizeRGBA(img.data, img.w, img.h, settings.analysisSize);
  writePng(base + '.preview.png', composite(small.data, BS.renderOverlay(r, 'classes'), r.w * r.h), r.w, r.h);
  console.log(path.relative(root, file), '·', profile, '·', Object.entries(r.percents).map(([k, v]) => k + ' ' + v.toFixed(1)).join(', '));
  done++;
}
console.log(`Готово: розмічено ${done}, пропущено (уже є розмітка) ${skipped}. Далі: .venv\\Scripts\\python.exe training\\prepare.py`);
