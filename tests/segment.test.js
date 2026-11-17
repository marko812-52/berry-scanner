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
const noise = (i) => ((i * 7919) % 13) - 6;                  // легка детермінована «текстура»
const rnd = (x, y) => { const v = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453; return v - Math.floor(v); };
function scene(w, h, bg) {
  const d = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const c = bg || BERRY, j = noise(i);
    d[i * 4] = c[0] + j; d[i * 4 + 1] = c[1] + j; d[i * 4 + 2] = c[2] + j; d[i * 4 + 3] = 255;
  }
  return { d, w, h };
}
function put(s, x, y, c) {
  if (x < 0 || y < 0 || x >= s.w || y >= s.h) return;
  const p = (y * s.w + x) * 4; s.d[p] = c[0]; s.d[p + 1] = c[1]; s.d[p + 2] = c[2];
}
// гладкий прямокутник з різким краєм (папір, пластик, стіна)
function rect(s, x, y, rw, rh, c) { for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) put(s, xx, yy, c); }
// гладкий диск з різким краєм
function disc(s, cx, cy, r, c) {
  for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) put(s, xx, yy, c);
}
// диск із текстурою (ягода): колір ± шум
function berry(s, cx, cy, r, c, amp) {
  for (let yy = cy - r; yy <= cy + r; yy++) for (let xx = cx - r; xx <= cx + r; xx++) {
    if ((xx - cx) ** 2 + (yy - cy) ** 2 > r * r) continue;
    const j = (rnd(xx, yy) - 0.5) * 2 * (amp || 8);
    put(s, xx, yy, [c[0] + j, c[1] + j, c[2] + j]);
  }
}
// пляма плісняви: нерівна всередині, з м'яким краєм
function mold(s, cx, cy, r, base) {
  for (let yy = cy - r - 3; yy <= cy + r + 3; yy++) for (let xx = cx - r - 3; xx <= cx + r + 3; xx++) {
    if (xx < 0 || yy < 0 || xx >= s.w || yy >= s.h) continue;
    const a = Math.max(0, Math.min(1, (r - Math.hypot(xx - cx, yy - cy)) / 3 + 0.5));
    if (!a) continue;
    const v = (base || 200) + (rnd(xx, yy) - 0.5) * 70, p = (yy * s.w + xx) * 4;
    for (let k = 0; k < 3; k++) s.d[p + k] = s.d[p + k] * (1 - a) + v * a;
  }
}
const withProfile = (profile) => Object.assign(BS.cloneSettings(S), { profile });
const run = (s, opts, settings) => BS.analyze(s.d, s.w, s.h, settings || S, opts);
// клас у точці: найчастіший у вікні 5×5 (окремий піксель залежить від шуму)
const at = (r, x, y) => {
  const votes = new Array(8).fill(0);
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) votes[r.labels[(y + dy) * r.w + (x + dx)]]++;
  return votes.indexOf(Math.max(...votes));
};
const C = BS.CLASSES;

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

test('нерівна біла пляма серед ягід — пліснява', () => {
  const s = scene(640, 480);
  mold(s, 320, 240, 14);
  const r = run(s);
  const expected = 100 * Math.PI * 14 * 14 / (640 * 480);
  assert.equal(r.moldSpots, 1);
  assert.equal(at(r, 320, 240), C.MOLD);
  assert.ok(Math.abs(r.percents.mold - expected) < expected * 0.3, 'пліснява ' + r.percents.mold + ' проти ' + expected);
});

test('гладкий білий папірець серед ягід — фон, а не пліснява', () => {
  const s = scene(640, 480);
  rect(s, 280, 200, 70, 46, WHITE);
  const r = run(s);
  assert.equal(r.percents.mold, 0);
  assert.equal(at(r, 315, 223), C.OTHER);
  assert.ok(r.otherFraction > 0.005);
  assert.ok(Math.abs(Object.values(r.percents).reduce((a, b) => a + b, 0) - 100) < 1e-6, '«фон / інше» не входить у 100 %');
});

test('дуже яскрава пляма з різким краєм — блик, а не пліснява', () => {
  const s = scene(640, 480);
  berry(s, 320, 240, 7, [244, 244, 244], 10);
  const r = run(s);
  assert.equal(r.percents.mold, 0);
  assert.equal(at(r, 320, 240), C.GOOD);
});

test('біла стіна поруч із ягодами не стає пліснявою', () => {
  const s = scene(640, 480);
  rect(s, 0, 0, 220, 480, WHITE);
  const r = run(s);
  assert.ok(Math.abs(r.roiFraction - 420 / 640) < 0.06, 'зона ' + r.roiFraction);
  assert.ok(r.percents.mold < 0.3, 'пліснява ' + r.percents.mold);
});

test('білий лоток, що просвічує між ягодами, не стає пліснявою', () => {
  const s = scene(640, 480, WHITE);
  for (let y = 26; y < 480; y += 46) for (let x = 26 + (((y / 46) | 0) % 2) * 23; x < 640; x += 46) berry(s, x, y, 21, BERRY, 6);
  const r = run(s);
  assert.ok(r.berryFraction > 0.4, 'ягоди знайдено: ' + r.berryFraction);
  assert.ok(r.percents.mold < 0.3, 'пліснява ' + r.percents.mold);
  assert.ok(r.percents.good > 99, 'якісні ' + r.percents.good);
});

test('біла зона, обведена разом зі стіною, не дає плісняви', () => {
  const s = scene(640, 480);
  rect(s, 0, 0, 220, 480, WHITE);
  mold(s, 430, 240, 12);
  const r = run(s, { roiRect: { x0: 0, y0: 0, x1: 1, y1: 1 } });
  assert.equal(r.moldSpots, 1);
  assert.equal(at(r, 100, 240), C.OTHER);
  assert.ok(r.otherFraction > 0.3);
});

test('гладка темна поверхня (стіл, тінь) не потрапляє в зону ягід', () => {
  const s = scene(640, 480);
  rect(s, 0, 0, 300, 480, BERRY);                // той самий колір, але без текстури
  const r = run(s);
  assert.ok(Math.abs(r.roiFraction - 340 / 640) < 0.07, 'зона ' + r.roiFraction);
  assert.equal(at(r, 100, 240), C.OUT);
});

test('синій лоток виключається із зони', () => {
  const s = scene(640, 480);
  rect(s, 0, 0, 640, 120, CRATE);
  const r = run(s);
  assert.ok(Math.abs(r.roiFraction - 0.75) < 0.05);
  assert.equal(at(r, 320, 60), C.OUT);
});

test('ожина: червоні й зелені — недостиглі, чашолистик — домішки', () => {
  const s = scene(640, 480);
  disc(s, 150, 240, 16, [135, 87, 87]);     // червона
  disc(s, 320, 240, 16, [192, 196, 105]);   // зелена
  disc(s, 490, 240, 16, [181, 137, 97]);    // чашолистик
  const r = run(s);
  assert.equal(at(r, 150, 240), C.UNRIPE);
  assert.equal(at(r, 320, 240), C.UNRIPE);
  assert.equal(at(r, 490, 240), C.DEBRIS);
  assert.ok(r.percents.unripe > 0.4 && r.percents.unripe < 0.7, 'недостиглі ' + r.percents.unripe);
  assert.ok(r.percents.debris > 0.2 && r.percents.debris < 0.35, 'домішки ' + r.percents.debris);
  assert.equal(r.percents.damaged, 0, 'кольоровий метод пошкоджені не визначає');
});

// ---------- ручна зона ----------
test('ручна зона: прямокутник зі старих записів', () => {
  const s = scene(640, 480);
  mold(s, 100, 100, 14);                        // поза зоною
  const r = run(s, { roiRect: { x0: 0.5, y0: 0.5, x1: 1, y1: 1 } });
  assert.ok(r.manualRoi);
  assert.ok(Math.abs(r.roiFraction - 0.25) < 0.03);
  assert.equal(r.percents.mold, 0);
});

test('ручна зона: обведений контур', () => {
  const s = scene(640, 480);
  mold(s, 100, 400, 14);                        // у лівому нижньому куті — поза трикутником
  mold(s, 480, 160, 14);                        // усередині
  const r = run(s, { roiPoly: [{ x: 0.2, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 0.8 }] });
  assert.ok(r.manualRoi);
  assert.ok(Math.abs(r.roiFraction - 0.32) < 0.02, 'площа трикутника: ' + r.roiFraction);
  assert.equal(r.moldSpots, 1);
  assert.equal(at(r, 100, 400), C.OUT);
});

test('растеризація контуру: площа й невипукла форма', () => {
  const m = BS.rasterPolygon([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0.5, y: 0.5 }, { x: 0, y: 1 }], 100, 100);
  const area = m.reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(area - 7500) < 150, 'площа ' + area);
  assert.equal(m[90 * 100 + 50], 0, 'виріз знизу порожній');
  assert.equal(m[20 * 100 + 50], 1);
  assert.equal(BS.rasterPolygon([{ x: 0, y: 0 }, { x: 1, y: 1 }], 10, 10).reduce((a, b) => a + b, 0), 0, 'двох точок замало');
});

test('фото без ягід: вердикт не визначено, потрібна перевірка', () => {
  const r = run(scene(640, 480, WHITE));
  const b = BS.evaluateBatch([r], S);
  assert.ok(r.berryFraction < 0.05);
  assert.equal(b.verdict.code, 'unknown');
  assert.ok(b.needsReview);
});

// ---------- профілі ягід ----------
test('лохина: природний наліт — не пліснява; біла нерівна пляма — пліснява', () => {
  const st = withProfile('blueberry'), s = scene(640, 480, [45, 55, 90]);
  for (let k = 0; k < 12; k++) berry(s, 60 + (k % 6) * 100, 120 + ((k / 6) | 0) * 220, 18, [125, 138, 165], 10);   // сизий наліт
  const clean = run(s, null, st);
  assert.ok(clean.roiFraction > 0.9);
  assert.equal(clean.percents.mold, 0, 'наліт став пліснявою');
  mold(s, 320, 240, 14, 215);
  disc(s, 110, 240, 14, [150, 190, 90]);        // зелена
  disc(s, 530, 240, 14, [190, 105, 150]);       // рожева
  const r = run(s, null, st);
  assert.equal(at(r, 320, 240), C.MOLD);
  assert.equal(at(r, 110, 240), C.UNRIPE);
  assert.equal(at(r, 530, 240), C.UNRIPE);
  assert.equal(r.profile, 'blueberry');
});

test('малина: червоне — якісне, бліде й зелене — недостигле, біла пляма — пліснява', () => {
  const st = withProfile('raspberry'), s = scene(640, 480, [190, 40, 60]);
  rect(s, 0, 0, 160, 480, WHITE);               // біла стіна
  disc(s, 300, 240, 15, [228, 205, 150]);       // бліда жовтувата
  disc(s, 420, 240, 15, [170, 200, 95]);        // зелена
  mold(s, 540, 240, 14, 215);
  const r = run(s, null, st);
  assert.ok(Math.abs(r.roiFraction - 0.75) < 0.07, 'зона ' + r.roiFraction);
  assert.equal(at(r, 80, 240), C.OUT);
  assert.equal(at(r, 360, 100), C.GOOD);
  assert.equal(at(r, 300, 240), C.UNRIPE);
  assert.equal(at(r, 420, 240), C.UNRIPE);
  assert.equal(at(r, 540, 240), C.MOLD);
  assert.equal(r.moldSpots, 1);
});

test('полуниця: червоне — якісне, блідо-біле — недостигле, чашолистик — не домішка', () => {
  const st = withProfile('strawberry'), s = scene(640, 480, [200, 35, 40]);
  disc(s, 200, 240, 15, [236, 216, 190]);       // блідо-кремова
  disc(s, 320, 240, 15, [60, 120, 40]);         // чашолистик
  disc(s, 440, 240, 15, [205, 215, 160]);       // зеленувато-біла
  const r = run(s, null, st);
  assert.equal(at(r, 100, 100), C.GOOD);
  assert.equal(at(r, 200, 240), C.UNRIPE);
  assert.equal(at(r, 320, 240), C.OTHER);
  assert.equal(at(r, 440, 240), C.UNRIPE);
  assert.equal(r.percents.debris, 0);
  assert.equal(r.percents.mold, 0);
});

test('експериментальний профіль знижує впевненість', () => {
  const a = BS.evaluateBatch([run(scene(640, 480))], S);
  const b = BS.evaluateBatch([run(scene(640, 480, [190, 40, 60]), null, withProfile('raspberry'))], S);
  assert.ok(b.issues.some((i) => i.code === 'profile'));
  assert.ok(!a.issues.some((i) => i.code === 'profile'));
  assert.ok(b.confidence.score < a.confidence.score);
});

// ---------- якість фото до аналізу ----------
test('перевірка якості фото: нормальне, темне, засвічене, розмите', () => {
  const codes = (s) => BS.photoQuality(s.d, s.w, s.h).issues.map((i) => i.code);
  const ok = scene(800, 600); for (let k = 0; k < 60; k++) berry(ok, 40 + (k % 10) * 78, 50 + ((k / 10) | 0) * 95, 30, [70, 40, 80], 30);
  assert.deepEqual(codes(ok), []);
  assert.ok(codes(scene(800, 600, [8, 8, 8])).includes('dark'));
  const bright = scene(800, 600, [120, 90, 110]); rect(bright, 0, 0, 800, 200, [255, 255, 255]);
  assert.ok(codes(bright).includes('bright'));
  const blur = scene(800, 600); rect(blur, 0, 0, 800, 600, [70, 50, 80]);
  assert.ok(codes(blur).includes('blur'));
  assert.ok(codes(scene(400, 300)).includes('lowres'));
});

// ---------- вердикт ----------
test('пороги вердикту', () => {
  const v = S.verdict, d = (p) => BS.decide(Object.assign({ mold: 0.5, unripe: 3, damaged: 1, debris: 1 }, p), v);
  assert.equal(d({}).code, 'freeze');
  assert.equal(d({ mold: 2.5 }).code, 'process');
  assert.equal(d({ unripe: 12 }).code, 'process');
  assert.equal(d({ damaged: 8 }).code, 'process');
  assert.equal(d({ damaged: 20 }).code, 'reject');
  assert.equal(d({ mold: 6 }).code, 'reject');
  assert.ok(d({ mold: 6 }).reasons[0].includes('Пліснява'));
  // пороги зі старого запису (без «пошкоджених») теж працюють
  assert.equal(BS.decide({ mold: 0.5, unripe: 3, debris: 1 }, { freezeMold: 1.5, freezeUnripe: 8, freezeDebris: 2, processMold: 4, processUnripe: 25, processDebris: 6 }).code, 'freeze');
});

test('результат біля порога позначається для перевірки людиною', () => {
  const s = scene(640, 480);
  const fake = (m) => Object.assign({}, run(s), { percents: { good: 100 - m, unripe: 0, damaged: 0, mold: m, debris: 0 } });
  assert.ok(BS.evaluateBatch([fake(1.4)], S).needsReview, '1,4 % при порозі 1,5 %');
  assert.ok(!BS.evaluateBatch([fake(0.2)], S).needsReview, '0,2 % далеко від порога');
});

test('кілька фото: зважене середнє і позначка розбіжності', () => {
  const a = run(scene(640, 480));
  const s = scene(640, 480); for (let k = 0; k < 12; k++) mold(s, 60 + k * 45, 240, 16);
  const b = run(s);
  const batch = BS.evaluateBatch([a, b], S);
  assert.ok(b.percents.mold > 2);
  assert.ok(Math.abs(batch.percents.mold - b.percents.mold / 2) < 0.2);
  assert.ok(batch.issues.some((i) => i.code === 'spread'));
  assert.equal(batch.photos, 2);
});

test('збережені налаштування доповнюються стандартними', () => {
  const m = BS.mergeSettings({ verdict: { freezeMold: 3, bogus: 1 }, color: { moldValMin: 'x' }, profile: 'raspberry', mode: 'щось' });
  assert.equal(m.verdict.freezeMold, 3);
  assert.equal(m.verdict.processMold, S.verdict.processMold);
  assert.equal(m.verdict.freezeDamaged, S.verdict.freezeDamaged);
  assert.equal(m.color.moldValMin, S.color.moldValMin);
  assert.equal(m.verdict.bogus, undefined);
  assert.equal(m.profile, 'raspberry');
  assert.equal(m.mode, S.mode, 'невідомий режим → стандартний');
  assert.equal(BS.mergeSettings({ profile: 'кавун' }).profile, 'blackberry');
});

test('старі записи (v0: червоні + зелені) зводяться до єдиної таксономії', () => {
  const p = BS.normalizePercents({ good: 90, red: 3.5, green: 0.5, mold: 4, debris: 2 });
  assert.deepEqual(p, { good: 90, unripe: 4, damaged: 0, mold: 4, debris: 2 });
  const ev = BS.normalizeEvaluation({ percents: { good: 90, red: 3.5, green: 0.5, mold: 4, debris: 2 }, unripe: 4, verdict: { code: 'process' } });
  assert.equal(ev.percents.unripe, 4);
  assert.equal(ev.verdict.code, 'process');
  const batch = BS.evaluateBatch([Object.assign({}, run(scene(640, 480)), { percents: { good: 90, red: 3.5, green: 0.5, mold: 4, debris: 2 }, berryPx: undefined })], S);
  assert.equal(BS.round1(batch.percents.unripe), 4);
});

// ---------- реальне фото ----------
const img = loadJpeg(SAMPLE);
const base = BS.analyze(img.data, img.w, img.h, S);

// Контрольні точки (координати аналізу 768×1024), клас визначено оком по фото.
const POINTS = [
  [100, 100, C.OUT, 'стіна'], [60, 300, C.OUT, 'стіна'], [400, 80, C.OUT, 'лоток'], [150, 450, C.OUT, 'ребра лотка'],
  [20, 690, C.OUT, 'ребра лотка'], [434, 120, C.OUT, 'лоток'],
  [596, 617, C.MOLD, 'велика пляма'], [485, 653, C.MOLD, 'пляма'], [466, 728, C.MOLD, 'пляма'], [315, 772, C.MOLD, 'пляма'],
  [67, 930, C.MOLD, 'пляма'], [80, 735, C.MOLD, 'пляма'], [511, 302, C.MOLD, 'пляма'], [541, 350, C.MOLD, 'пляма'],
  [399, 580, C.UNRIPE, 'червона ягода'], [621, 642, C.UNRIPE, 'бордова ягода'], [486, 792, C.UNRIPE, 'червона ягода'],
  [147, 767, C.UNRIPE, 'червона ягода'], [85, 895, C.UNRIPE, 'червона ягода'],
  [586, 551, C.UNRIPE, 'зелена ягода'], [713, 484, C.UNRIPE, 'зелена ягода'],
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
  inRange(p.unripe, 1.5, 8, 'недостиглі');
  assert.equal(p.damaged, 0);
  inRange(base.otherFraction * 100, 0, 2, 'фон усередині зони, %');
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

test('зразок: зона на весь кадр (разом зі стіною й лотком) не додає плісняви', () => {
  const full = BS.analyze(img.data, img.w, img.h, S, { roiRect: { x0: 0, y0: 0, x1: 1, y1: 1 } });
  let mold = 0;
  for (let y = 0; y < 500; y++) for (let x = 0; x < 180; x++) if (full.labels[y * full.w + x] === C.MOLD) mold++;
  assert.equal(mold, 0, 'пліснява на стіні або лотку');
  assert.ok(Math.abs(full.percents.mold - base.percents.mold) < 1, 'пліснява ' + base.percents.mold.toFixed(2) + ' → ' + full.percents.mold.toFixed(2));
  assert.ok(full.otherFraction > 0.1, 'стіна має стати «фоном / іншим»');
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
