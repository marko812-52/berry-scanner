/*
 * Базові тести сегментації. Запуск:  node --test tests/
 * Без залежностей: потрібен лише Node 18+.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { BS, loadJpeg } = require('../tools/lib.js');

const S = BS.DEFAULT_SETTINGS;
const SAMPLE = path.join(__dirname, '..', 'data', 'samples', 'photo_2026-11-12_18-39-37.jpg');

// ---------- синтетичні сцени ----------
const BERRY = [30, 22, 35], WHITE = [235, 235, 235], CRATE = [58, 124, 140];
function scene(w, h, bg) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = bg || BERRY, j = ((i * 7919) % 13) - 6;          // легка детермінована «текстура»
    d[i * 4] = c[0] + j; d[i * 4 + 1] = c[1] + j; d[i * 4 + 2] = c[2] + j; d[i * 4 + 3] = 255;
  }
  return { d, w, h };
}
function rect(s, x, y, rw, rh, c) {
  for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) {
    const p = (yy * s.w + xx) * 4; s.d[p] = c[0]; s.d[p + 1] = c[1]; s.d[p + 2] = c[2];
  }
}
function disc(s, cx, cy, r, c) {
  for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
    if ((xx - cx) * (xx - cx) + (yy - cy) * (yy - cy) > r * r) continue;
    const p = (yy * s.w + xx) * 4; s.d[p] = c[0]; s.d[p + 1] = c[1]; s.d[p + 2] = c[2];
  }
}
const run = (s, opts) => BS.analyze(s.d, s.w, s.h, S, opts);

test('чисті темні ягоди: усе якісне, вердикт — заморожування', () => {
  const r = run(scene(640, 480));
  assert.ok(r.roiFraction > 0.95);
  assert.ok(r.percents.good > 99.5);
  assert.equal(BS.evaluateBatch([r], S).verdict.code, 'freeze');
});

test('дрібні відблиски не рахуються пліснявою', () => {
  const s = scene(640, 480);
  for (let k = 0; k < 40; k++) rect(s, 30 + (k % 8) * 70, 40 + ((k / 8) | 0) * 80, 3, 3, WHITE);
  const r = run(s);
  assert.equal(r.percents.mold, 0);
  assert.equal(r.moldSpots, 0);
  assert.ok(r.glareFraction > 0);
});

test('велика біла пляма серед ягід — пліснява', () => {
  const s = scene(640, 480);
  disc(s, 320, 240, 14, WHITE);
  const r = run(s);
  const expected = 100 * Math.PI * 14 * 14 / (640 * 480);
  assert.equal(r.moldSpots, 1);
  assert.ok(Math.abs(r.percents.mold - expected) < expected * 0.25, 'пліснява ' + r.percents.mold + ' проти ' + expected);
});

test('біла стіна поруч із ягодами не стає пліснявою', () => {
  const s = scene(640, 480);
  rect(s, 0, 0, 220, 480, WHITE);
  const r = run(s);
  assert.ok(Math.abs(r.roiFraction - 420 / 640) < 0.06, 'зона ' + r.roiFraction);
  assert.ok(r.percents.mold < 0.3, 'пліснява ' + r.percents.mold);
});

test('синій лоток виключається із зони', () => {
  const s = scene(640, 480);
  rect(s, 0, 0, 640, 120, CRATE);
  const r = run(s);
  assert.ok(Math.abs(r.roiFraction - 0.75) < 0.05);
  assert.equal(r.labels[60 * r.w + 320], BS.CLASSES.OUT);
});

test('червоні, зелені ягоди та домішки потрапляють у свої категорії', () => {
  const s = scene(640, 480);
  disc(s, 150, 240, 16, [135, 87, 87]);     // недостигла
  disc(s, 320, 240, 16, [192, 196, 105]);   // зелена
  disc(s, 490, 240, 16, [181, 137, 97]);    // чашолистик
  const r = run(s), at = (x) => r.labels[240 * r.w + x];
  assert.equal(at(150), BS.CLASSES.RED);
  assert.equal(at(320), BS.CLASSES.GREEN);
  assert.equal(at(490), BS.CLASSES.DEBRIS);
  for (const k of ['red', 'green', 'debris']) assert.ok(r.percents[k] > 0.2 && r.percents[k] < 0.35, k + ' ' + r.percents[k]);
});

test('ручна зона обмежує аналіз прямокутником', () => {
  const s = scene(640, 480);
  disc(s, 100, 100, 14, WHITE);                 // поза зоною
  const r = run(s, { roiRect: { x0: 0.5, y0: 0.5, x1: 1, y1: 1 } });
  assert.ok(r.manualRoi);
  assert.ok(Math.abs(r.roiFraction - 0.25) < 0.03);
  assert.equal(r.percents.mold, 0);
});

test('фото без ягід: вердикт не визначено, потрібна перевірка', () => {
  const r = run(scene(640, 480, WHITE));
  const b = BS.evaluateBatch([r], S);
  assert.ok(r.roiFraction < 0.05);
  assert.equal(b.verdict.code, 'unknown');
  assert.ok(b.needsReview);
});

// ---------- вердикт ----------
test('пороги вердикту', () => {
  const v = S.verdict;
  assert.equal(BS.decide({ mold: 0.5, unripe: 3, debris: 1 }, v).code, 'freeze');
  assert.equal(BS.decide({ mold: 2.5, unripe: 3, debris: 1 }, v).code, 'process');
  assert.equal(BS.decide({ mold: 0.5, unripe: 12, debris: 1 }, v).code, 'process');
  assert.equal(BS.decide({ mold: 6, unripe: 3, debris: 1 }, v).code, 'reject');
  assert.ok(BS.decide({ mold: 6, unripe: 3, debris: 1 }, v).reasons[0].includes('Пліснява'));
});

test('результат біля порога позначається для перевірки людиною', () => {
  const s = scene(640, 480);
  const fake = (mold) => Object.assign({}, run(s), { percents: { good: 100 - mold, red: 0, green: 0, mold, debris: 0 } });
  assert.ok(BS.evaluateBatch([fake(1.4)], S).needsReview, '1,4 % при порозі 1,5 %');
  assert.ok(!BS.evaluateBatch([fake(0.2)], S).needsReview, '0,2 % далеко від порога');
});

test('кілька фото: зважене середнє і позначка розбіжності', () => {
  const a = run(scene(640, 480));
  const s = scene(640, 480); for (let k = 0; k < 12; k++) disc(s, 60 + k * 45, 240, 16, WHITE);
  const b = run(s);
  const batch = BS.evaluateBatch([a, b], S);
  assert.ok(Math.abs(batch.percents.mold - b.percents.mold / 2) < 0.2);
  assert.ok(batch.issues.some((i) => i.code === 'spread'));
});

test('збережені налаштування доповнюються стандартними', () => {
  const m = BS.mergeSettings({ verdict: { freezeMold: 3, bogus: 1 }, color: { moldValMin: 'x' } });
  assert.equal(m.verdict.freezeMold, 3);
  assert.equal(m.verdict.processMold, S.verdict.processMold);
  assert.equal(m.color.moldValMin, S.color.moldValMin);
  assert.equal(m.verdict.bogus, undefined);
});

// ---------- реальне фото ----------
const img = loadJpeg(SAMPLE);
const base = BS.analyze(img.data, img.w, img.h, S);
const C = BS.CLASSES;

// Контрольні точки (координати аналізу 768×1024), клас визначено оком по фото.
const POINTS = [
  [100, 100, C.OUT, 'стіна'], [60, 300, C.OUT, 'стіна'], [400, 80, C.OUT, 'лоток'], [150, 450, C.OUT, 'ребра лотка'],
  [20, 690, C.OUT, 'ребра лотка'], [434, 120, C.OUT, 'лоток'],
  [596, 617, C.MOLD, 'велика пляма'], [485, 653, C.MOLD, 'пляма'], [466, 728, C.MOLD, 'пляма'], [315, 772, C.MOLD, 'пляма'],
  [67, 930, C.MOLD, 'пляма'], [80, 735, C.MOLD, 'пляма'], [511, 302, C.MOLD, 'пляма'], [541, 350, C.MOLD, 'пляма'],
  [399, 580, C.RED, 'червона ягода'], [621, 642, C.RED, 'бордова ягода'], [486, 792, C.RED, 'червона ягода'],
  [147, 767, C.RED, 'червона ягода'], [85, 895, C.RED, 'червона ягода'],
  [586, 551, C.GREEN, 'зелена ягода'], [713, 484, C.GREEN, 'зелена ягода'],
  [92, 962, C.DEBRIS, 'чашолистик'], [696, 142, C.DEBRIS, 'чашолистик'],
  [519, 620, C.GOOD, 'темна ягода'], [694, 665, C.GOOD, 'темна ягода'], [634, 760, C.GOOD, 'темна ягода'],
  [250, 960, C.GOOD, 'темна ягода'], [300, 710, C.GOOD, 'темна ягода'], [654, 290, C.GOOD, 'темна ягода'], [450, 900, C.GOOD, 'темна ягода']
];
// Клас у точці: найчастіший у вікні 7×7 (точку ставили оком, піксель у піксель не влучити).
function labelAt(res, x, y) {
  const votes = new Array(8).fill(0);
  for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) votes[res.labels[(y + dy) * res.w + (x + dx)]]++;
  return votes.indexOf(Math.max(...votes));
}

test('зразок: контрольні точки збігаються щонайменше на 90 %', () => {
  const miss = POINTS.filter(([x, y, cls]) => labelAt(base, x, y) !== cls);
  const outside = POINTS.filter((p) => p[2] === C.OUT);
  assert.ok(outside.every(([x, y]) => labelAt(base, x, y) === C.OUT), 'стіна або лоток потрапили в зону ягід');
  assert.ok(miss.length <= POINTS.length * 0.1, 'не збіглися: ' + miss.map((m) => m[3] + ' (' + m[0] + ',' + m[1] + ') → ' + labelAt(base, m[0], m[1])).join('; '));
});

test('зразок: частки в очікуваних діапазонах', () => {
  const p = base.percents, inRange = (v, lo, hi, n) => assert.ok(v >= lo && v <= hi, n + ' = ' + v.toFixed(2) + ', очікувано ' + lo + '–' + hi);
  inRange(base.roiFraction * 100, 55, 75, 'зона ягід, % кадру');
  inRange(p.good, 80, 97, 'якісні');
  inRange(p.mold, 1, 8, 'пліснява');
  inRange(p.red, 1, 8, 'червоні');
  inRange(p.green, 0.05, 1.5, 'зелені');
  inRange(p.debris, 0.3, 4, 'домішки');
  const sum = Object.values(p).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(sum - 100) < 1e-6);
});

test('зразок: стіна не «протікає» у плісняву', () => {
  // Без зони ягід біле займає близько 19 % кадру. Перевіряємо, що в лівій третині кадру (стіна, лоток) плісняви немає.
  let mold = 0;
  for (let y = 0; y < 500; y++) for (let x = 0; x < 180; x++) if (base.labels[y * base.w + x] === C.MOLD) mold++;
  assert.equal(mold, 0);
});

test('зразок: результат детермінований і швидкий', () => {
  const t0 = Date.now();
  const again = BS.analyze(img.data, img.w, img.h, S);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(again.percents, base.percents);
});

// ---------- стійкість ----------
function mapPixels(fn) {
  const d = new Uint8ClampedArray(img.data.length);
  for (let i = 0; i < d.length; i += 4) { const c = fn(img.data[i], img.data[i + 1], img.data[i + 2]); d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2]; d[i + 3] = 255; }
  return { d, w: img.w, h: img.h };
}
function rotate90() {
  const d = new Uint8ClampedArray(img.data.length), w = img.h, h = img.w;
  for (let y = 0; y < img.h; y++) for (let x = 0; x < img.w; x++) {
    const s = (y * img.w + x) * 4, q = (x * w + (w - 1 - y)) * 4;
    d[q] = img.data[s]; d[q + 1] = img.data[s + 1]; d[q + 2] = img.data[s + 2]; d[q + 3] = 255;
  }
  return { d, w, h };
}
const VARIANTS = {
  'темніше на 20 %': () => mapPixels((r, g, b) => [r * 0.8, g * 0.8, b * 0.8]),
  'світліше на 20 %': () => mapPixels((r, g, b) => [r * 1.2, g * 1.2, b * 1.2]),
  'тепліше світло': () => mapPixels((r, g, b) => [r * 1.08, g, b * 0.92]),
  'холодніше світло': () => mapPixels((r, g, b) => [r * 0.93, g, b * 1.07]),
  'менше фото (640 px)': () => { const s = BS.resizeRGBA(img.data, img.w, img.h, 640); return { d: s.data, w: s.w, h: s.h }; },
  'поворот на 90°': rotate90
};
const baseBatch = BS.evaluateBatch([base], S);
for (const [name, make] of Object.entries(VARIANTS)) {
  test('стійкість: ' + name, () => {
    const v = make(), r = BS.analyze(v.d, v.w, v.h, S), b = BS.evaluateBatch([r], S);
    for (const k of Object.keys(base.percents)) {
      const diff = Math.abs(r.percents[k] - base.percents[k]);
      assert.ok(diff <= 3, k + ': ' + base.percents[k].toFixed(1) + ' → ' + r.percents[k].toFixed(1));
    }
    assert.ok(b.verdict.code === baseBatch.verdict.code || b.needsReview, 'вердикт змінився без позначки перевірки');
  });
}
