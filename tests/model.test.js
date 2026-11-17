/* Режими аналізу «Гібрид / Модель» і відкат на кольоровий метод. Модель тут не запускається:
 * ймовірності класів задаються вручну, перевіряється логіка поєднання. */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { BS } = require('../tools/lib.js');
require('../js/core/analyzer.js');
require('../js/ml/model.js');

const C = BS.CLASSES, S = BS.DEFAULT_SETTINGS;
const root = path.join(__dirname, '..');

function scene(w, h, c) {
  c = c || [30, 22, 35];
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { const j = ((i * 7919) % 13) - 6; d[i * 4] = c[0] + j; d[i * 4 + 1] = c[1] + j; d[i * 4 + 2] = c[2] + j; d[i * 4 + 3] = 255; }
  return d;
}
function mold(d, w, cx, cy, r) {
  for (let y = cy - r - 3; y <= cy + r + 3; y++) for (let x = cx - r - 3; x <= cx + r + 3; x++) {
    const a = Math.max(0, Math.min(1, (r - Math.hypot(x - cx, y - cy)) / 3 + 0.5)); if (!a) continue;
    const v = 200 + (Math.sin(x * 12.99 + y * 78.23) * 43758.5 % 1) * 70, p = (y * w + x) * 4;
    for (let k = 0; k < 3; k++) d[p + k] = d[p + k] * (1 - a) + v * a;
  }
}
// Штучні ймовірності моделі: усе «якісна», окремо задані кола.
function fakePred(w, h, discs) {
  const st = 4, gw = Math.ceil(w / 32) * 8, gh = Math.ceil(h / 32) * 8, n = gw * gh, prob = new Float32Array(6 * n);
  for (let i = 0; i < n; i++) {
    const x = (i % gw) * st + 2, y = Math.floor(i / gw) * st + 2;
    let p = [0.02, 0.9, 0.02, 0.02, 0.02, 0.02];
    for (const d of discs) if (Math.hypot(x - d.x, y - d.y) <= d.r) p = d.p;
    for (let k = 0; k < 6; k++) prob[k * n + i] = p[k];
  }
  return { prob, gw, gh, w, h, stride: st, species: [0.9, 0.04, 0.03, 0.03], speciesHint: true, speciesKeys: ['blackberry', 'blueberry', 'raspberry', 'strawberry'], version: 'test', ms: 1 };
}
const at = (r, x, y) => r.labels[y * r.w + x];

test('гібрид: модель знімає «плісняву», яку вважає фоном, і додає пропущену', () => {
  const w = 640, h = 480, d = scene(w, h);
  mold(d, w, 160, 240, 14);                     // колір: пліснява; модель: фон → «фон / інше»
  mold(d, w, 480, 240, 14);                     // колір: пліснява; модель: пліснява → лишається
  mold(d, w, 320, 380, 14);                     // колір: пліснява; модель: «якісна» → пліснява лишається (пропуск гірший)
  const color = BS.analyze(d, w, h, S);
  assert.equal(color.moldSpots, 3);
  const pred = fakePred(w, h, [
    { x: 160, y: 240, r: 20, p: [0.9, 0.04, 0.01, 0.01, 0.02, 0.02] },
    { x: 320, y: 380, r: 20, p: [0.02, 0.9, 0.02, 0.02, 0.02, 0.02] },   // модель «не бачить» плісняву, але й фону не бачить
    { x: 480, y: 240, r: 20, p: [0.02, 0.1, 0.01, 0.01, 0.85, 0.01] },
    { x: 320, y: 100, r: 12, p: [0.02, 0.1, 0.01, 0.01, 0.85, 0.01] }   // сірий наліт, який колір пропустив
  ]);
  const r = BS.model.combine(color, pred, 'hybrid', S);
  assert.equal(r.method, 'hybrid');
  assert.equal(at(r, 160, 240), C.OTHER);
  assert.equal(at(r, 480, 240), C.MOLD);
  assert.equal(at(r, 320, 100), C.MOLD);
  assert.equal(at(r, 320, 380), C.MOLD, "модель не знімає плісняву, якщо не бачить там фону");
  assert.equal(r.moldSpots, 3);
  assert.ok(Math.abs(Object.values(r.percents).reduce((a, b) => a + b, 0) - 100) < 1e-6);
  assert.equal(r.modelVersion, 'test');
  assert.ok(r.modelConfidence > 0.8);
});

test('гібрид: «пошкоджені» береться з моделі лише для ягід, де вона їх бачила в навчанні', () => {
  const w = 320, h = 240, d = scene(w, h), disc = [{ x: 160, y: 120, r: 30, p: [0.02, 0.2, 0.02, 0.7, 0.03, 0.03] }];
  const straw = BS.analyze(scene(w, h, [200, 35, 40]), w, h, Object.assign(BS.cloneSettings(S), { profile: 'strawberry' }));
  const r = BS.model.combine(straw, fakePred(w, h, disc), 'hybrid', S);
  assert.equal(at(r, 160, 120), C.DAMAGED);
  assert.ok(r.percents.damaged > 3);
  const black = BS.model.combine(BS.analyze(d, w, h, S), fakePred(w, h, disc), 'hybrid', S);
  assert.equal(black.percents.damaged, 0, 'для ожини модель «пошкоджених» не бачила');
  const m = BS.model.combine(BS.analyze(d, w, h, S), fakePred(w, h, disc), 'model', S);
  assert.equal(at(m, 160, 120), C.GOOD, 'режим «Модель»: замість «пошкоджених» — другий за ймовірністю клас');
});

test('модель: клас кожного пікселя від моделі, ручна зона обмежує', () => {
  const w = 320, h = 240, d = scene(w, h);
  const pred = fakePred(w, h, [{ x: 60, y: 60, r: 25, p: [0.95, 0.01, 0.01, 0.01, 0.01, 0.01] }]);
  const r = BS.model.combine(BS.analyze(d, w, h, S), pred, 'model', S);
  assert.equal(at(r, 60, 60), C.OUT);
  assert.equal(at(r, 200, 150), C.GOOD);
  const m = BS.model.combine(BS.analyze(d, w, h, S, { roiRect: { x0: 0.5, y0: 0, x1: 1, y1: 1 } }), pred, 'model', S);
  assert.equal(at(m, 100, 150), C.OUT, 'поза ручною зоною');
  assert.ok(Math.abs(m.roiFraction - 0.5) < 0.02);
});

test('підказка виду ягоди: лише при високій упевненості й іншому профілі', () => {
  const w = 320, h = 240, d = scene(w, h), color = BS.analyze(d, w, h, Object.assign(BS.cloneSettings(S), { profile: 'raspberry' }));
  const pred = fakePred(w, h, []);
  assert.equal(BS.model.combine(color, pred, 'hybrid', S).speciesHint, 'blackberry');
  pred.species = [0.6, 0.2, 0.1, 0.1];
  assert.equal(BS.model.combine(color, pred, 'hybrid', S).speciesHint, undefined);
  pred.speciesHint = false; pred.species = [0.99, 0, 0, 0.01];
  assert.equal(BS.model.combine(color, pred, 'hybrid', S).speciesHint, undefined);
});

test('розбіжність кольорового методу й моделі знижує впевненість', () => {
  const w = 320, h = 240, d = scene(w, h), color = BS.analyze(d, w, h, S);
  const r = BS.model.combine(color, fakePred(w, h, [{ x: 160, y: 120, r: 40, p: [0.02, 0.1, 0.01, 0.01, 0.85, 0.01] }]), 'model', S);
  const ev = BS.evaluateBatch([r], S);
  assert.ok(ev.issues.some((i) => i.code === 'disagree'), JSON.stringify(ev.issues));
  assert.ok(ev.needsReview, 'розбіжність щодо плісняви — завжди до людини');
});

test('без моделі (сторінка як файл, Node) — відкат на кольоровий метод із позначкою', async () => {
  const w = 320, h = 240, d = scene(w, h);
  const r = await BS.analyzer.run(d, w, h, Object.assign(BS.cloneSettings(S), { mode: 'hybrid' }));
  assert.equal(r.method, 'color');
  assert.equal(r.requestedMode, 'hybrid');
  assert.ok(r.fallback);
  assert.ok(BS.evaluateBatch([r], S).issues.some((i) => i.code === 'fallback'));
  const c = await BS.analyzer.run(d, w, h, Object.assign(BS.cloneSettings(S), { mode: 'color' }));
  assert.equal(c.fallback, undefined);
});

test('файли для деплою менші за ліміт Cloudflare (25 МіБ) і модель описана', () => {
  const limit = 25 * 1024 * 1024;
  for (const dir of ['vendor', 'models', 'js', 'css', 'icons', 'data/samples']) {
    const p = path.join(root, dir);
    if (!fs.existsSync(p)) continue;
    const walk = (q) => fs.readdirSync(q, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(q, e.name)) : [path.join(q, e.name)]);
    for (const f of walk(p)) assert.ok(fs.statSync(f).size < limit, 'завеликий файл: ' + f);
  }
  const info = path.join(root, 'models', 'berry-seg.json');
  if (fs.existsSync(info)) {
    const j = JSON.parse(fs.readFileSync(info, 'utf8'));
    assert.ok(fs.existsSync(path.join(root, 'models', j.file)), 'немає файлу моделі ' + j.file);
    assert.deepEqual(j.classes, ['background', 'good', 'unripe', 'damaged', 'mold', 'debris']);
    assert.equal(j.stride, 4);
  }
});
