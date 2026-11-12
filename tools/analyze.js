#!/usr/bin/env node
/*
 * Налагодження сегментації з командного рядка (той самий код, що й у браузері).
 *   node tools/analyze.js фото.jpg                       — статистика
 *   node tools/analyze.js фото.jpg --out шар.png         — фото з накладеними категоріями
 *   ... --mode heat                                      — теплова карта
 *   ... --crop x,y,w,h --zoom 3 --pair                   — фрагмент (координати аналізу), поруч оригінал
 */
'use strict';
const { BS, loadJpeg, writePng, composite } = require('./lib.js');

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
if (!file) { console.error('Вкажи шлях до фото (JPEG).'); process.exit(1); }

const img = loadJpeg(file);
const t0 = Date.now();
const res = BS.analyze(img.data, img.w, img.h, BS.DEFAULT_SETTINGS);
const ms = Date.now() - t0;
const batch = BS.evaluateBatch([res], BS.DEFAULT_SETTINGS);
const r1 = (v) => Math.round(v * 10) / 10;

console.log(JSON.stringify({
  source: img.w + 'x' + img.h, analysis: res.w + 'x' + res.h, ms,
  roiPercent: r1(res.roiFraction * 100),
  percents: Object.fromEntries(Object.entries(res.percents).map(([k, v]) => [k, r1(v)])),
  moldSpots: res.moldSpots, moldMaxSpotPercent: r1(res.moldMaxSpotFraction * 100),
  glarePercent: r1(res.glareFraction * 100), uncertainPercent: r1(res.uncertainFraction * 100),
  quality: res.quality,
  verdict: batch.verdict.code, confidence: batch.confidence.score, needsReview: batch.needsReview,
  issues: batch.issues.map((i) => i.text), reasons: batch.verdict.reasons
}, null, 1));

const out = opt('out');
if (out) {
  const small = BS.resizeRGBA(img.data, img.w, img.h, BS.DEFAULT_SETTINGS.analysisSize);
  const n = res.w * res.h;
  let pic = composite(small.data, BS.renderOverlay(res, opt('mode', 'classes')), n), base = small.data;
  let w = res.w, h = res.h;
  const crop = opt('crop'), zoom = parseInt(opt('zoom', '1'), 10), pair = opt('pair', false);
  const cut = (src) => {
    if (!crop) return { d: src, w: res.w, h: res.h };
    const [cx, cy, cw, ch] = crop.split(',').map(Number);
    const d = new Uint8ClampedArray(cw * zoom * ch * zoom * 4);
    for (let y = 0; y < ch * zoom; y++) for (let x = 0; x < cw * zoom; x++) {
      const sx = Math.min(res.w - 1, cx + ((x / zoom) | 0)), sy = Math.min(res.h - 1, cy + ((y / zoom) | 0));
      const s = (sy * res.w + sx) * 4, q = (y * cw * zoom + x) * 4;
      d[q] = src[s]; d[q + 1] = src[s + 1]; d[q + 2] = src[s + 2]; d[q + 3] = 255;
      // сітка кожні 20 px аналізу — щоб знімати координати контрольних точок
      if (opt('grid', false) && (((cx + x / zoom) % 20) < 1 / zoom || ((cy + y / zoom) % 20) < 1 / zoom)) { d[q] = d[q] * 0.5 + 127; d[q + 1] = d[q + 1] * 0.5 + 127; d[q + 2] = d[q + 2] * 0.5 + 127; }
    }
    return { d, w: cw * zoom, h: ch * zoom };
  };
  let a = cut(pic);
  if (pair) {
    const b = cut(base), W = a.w + b.w + 6, d = new Uint8ClampedArray(W * a.h * 4).fill(255);
    for (let y = 0; y < a.h; y++) {
      d.set(b.d.subarray(y * b.w * 4, (y + 1) * b.w * 4), y * W * 4);
      d.set(a.d.subarray(y * a.w * 4, (y + 1) * a.w * 4), (y * W + b.w + 6) * 4);
    }
    a = { d, w: W, h: a.h };
  }
  writePng(out, a.d, a.w, a.h);
  console.log('Збережено:', out);
}
