/*
 * Сегментація v0: колір (HSV) + зона ягід + фільтр бліків за розміром плями.
 * Чисті функції над масивами пікселів, без DOM. Вхід — RGBA, вихід — карта класів і статистика.
 *
 * Послідовність:
 *   1) зменшення до analysisSize;
 *   2) баланс білого за нейтральними світлими пікселями (стіна, блики);
 *   3) зона ягід на грубій сітці (стіна і пліснява мають однаковий колір, тому
 *      спершу шукаємо темну масу ягід і лише всередині неї класифікуємо);
 *   4) класифікація пікселів, 5) відсів дрібних плям, 6) статистика.
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});
  if (typeof module !== 'undefined' && module.exports && !BS.CLASSES) require('./defaults.js');
  var C = BS.CLASSES;
  var WHITE = 6;            // тимчасовий клас: світле нейтральне (пліснява або блик)
  var WEAK_RED = 7;         // тимчасовий клас: темно-червоне, рахується лише поруч із впевнено червоним
  var REF_MEDIAN_V = 0.17;  // типова медіана яскравості зони темних ягід (за зразком)

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  // ---------- 1. Зменшення (усереднення за площею) ----------
  BS.resizeRGBA = function (src, sw, sh, maxSide) {
    var longSide = Math.max(sw, sh);
    if (longSide <= maxSide) return { data: src, w: sw, h: sh };
    var k = maxSide / longSide;
    var dw = Math.max(1, Math.round(sw * k)), dh = Math.max(1, Math.round(sh * k));
    var rx = sw / dw, ry = sh / dh, x, y, s, wgt, p, q, a, b, i0, i1, r, g, bl;
    var tmp = new Float32Array(dw * sh * 3);
    for (x = 0; x < dw; x++) {
      a = x * rx; b = a + rx; i0 = Math.floor(a); i1 = Math.min(sw, Math.ceil(b));
      for (y = 0; y < sh; y++) {
        r = g = bl = 0;
        for (s = i0; s < i1; s++) {
          wgt = Math.min(b, s + 1) - Math.max(a, s);
          p = (y * sw + s) * 4;
          r += src[p] * wgt; g += src[p + 1] * wgt; bl += src[p + 2] * wgt;
        }
        q = (y * dw + x) * 3;
        tmp[q] = r / rx; tmp[q + 1] = g / rx; tmp[q + 2] = bl / rx;
      }
    }
    var out = new Uint8ClampedArray(dw * dh * 4);
    for (y = 0; y < dh; y++) {
      a = y * ry; b = a + ry; i0 = Math.floor(a); i1 = Math.min(sh, Math.ceil(b));
      for (x = 0; x < dw; x++) {
        r = g = bl = 0;
        for (s = i0; s < i1; s++) {
          wgt = Math.min(b, s + 1) - Math.max(a, s);
          p = (s * dw + x) * 3;
          r += tmp[p] * wgt; g += tmp[p + 1] * wgt; bl += tmp[p + 2] * wgt;
        }
        q = (y * dw + x) * 4;
        out[q] = r / ry; out[q + 1] = g / ry; out[q + 2] = bl / ry; out[q + 3] = 255;
      }
    }
    return { data: out, w: dw, h: dh };
  };

  // ---------- 2. Баланс білого ----------
  // Нейтральні світлі пікселі (стіна, пліснява, дзеркальні блики) відбивають колір лампи,
  // тож за ними можна оцінити відтінок освітлення. Корекція обмежена, щоб не нашкодити.
  function whiteBalance(data, n) {
    var sr = 0, sg = 0, sb = 0, cnt = 0, i, p, r, g, b, mx, mn;
    for (i = 0; i < n; i++) {
      p = i * 4; r = data[p]; g = data[p + 1]; b = data[p + 2];
      mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < 150 || mx > 250) continue;
      mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if ((mx - mn) > 0.25 * mx) continue;
      sr += r; sg += g; sb += b; cnt++;
    }
    var info = { applied: false, gainR: 1, gainB: 1, clamped: false, refFraction: cnt / n };
    if (cnt < n * 0.003) return info;
    var gr = sg / sr, gb = sg / sb;
    var cr = clamp(gr, 0.87, 1.15), cb = clamp(gb, 0.87, 1.15);
    info.clamped = cr !== gr || cb !== gb;
    info.applied = true; info.gainR = cr; info.gainB = cb;
    if (Math.abs(cr - 1) < 0.01 && Math.abs(cb - 1) < 0.01) return info;
    for (i = 0; i < n; i++) {
      p = i * 4;
      data[p] = data[p] * cr;         // Uint8ClampedArray сам обмежує до 255
      data[p + 2] = data[p + 2] * cb;
    }
    return info;
  }

  function toHSV(data, n, H, S, V) {
    for (var i = 0; i < n; i++) {
      var p = i * 4, r = data[p], g = data[p + 1], b = data[p + 2];
      var mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      var mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      var d = mx - mn, h = 0;
      if (d > 0) {
        if (mx === r) h = 60 * ((g - b) / d); else if (mx === g) h = 60 * ((b - r) / d + 2); else h = 60 * ((r - g) / d + 4);
        if (h < 0) h += 360;
      }
      H[i] = h; S[i] = mx ? d / mx : 0; V[i] = mx / 255;
    }
  }

  function inHue(h, lo, hi) { return lo <= hi ? (h >= lo && h <= hi) : (h >= lo || h <= hi); }

  function otsu(hist, total) {
    var sum = 0, i;
    for (i = 0; i < 256; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, best = 0, thr = 110;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (!wB) continue;
      var wF = total - wB; if (!wF) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF, v = wB * wF * (mB - mF) * (mB - mF);
      if (v > best) { best = v; thr = i; }
    }
    return thr / 255;
  }

  // ---------- 3. Операції на грубій сітці ----------
  function dilate(g, gw, gh, r) {
    var t = new Uint8Array(gw * gh), o = new Uint8Array(gw * gh), x, y, k, v;
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      v = 0;
      for (k = Math.max(0, x - r); k <= Math.min(gw - 1, x + r) && !v; k++) v = g[y * gw + k];
      t[y * gw + x] = v;
    }
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      v = 0;
      for (k = Math.max(0, y - r); k <= Math.min(gh - 1, y + r) && !v; k++) v = t[k * gw + x];
      o[y * gw + x] = v;
    }
    return o;
  }
  // Ерозія; за межами кадру вважаємо «ягоди», щоб зона не відступала від краю фото.
  function erode(g, gw, gh, r) {
    var t = new Uint8Array(gw * gh), o = new Uint8Array(gw * gh), x, y, k, v;
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      v = 1;
      for (k = Math.max(0, x - r); k <= Math.min(gw - 1, x + r) && v; k++) v = g[y * gw + k];
      t[y * gw + x] = v;
    }
    for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
      v = 1;
      for (k = Math.max(0, y - r); k <= Math.min(gh - 1, y + r) && v; k++) v = t[k * gw + x];
      o[y * gw + x] = v;
    }
    return o;
  }
  function largestComponent(g, gw, gh) {
    var n = gw * gh, lab = new Int32Array(n), queue = new Int32Array(n), best = 0, bestId = 0, id = 0, i;
    for (i = 0; i < n; i++) {
      if (!g[i] || lab[i]) continue;
      id++; var head = 0, tail = 0; queue[tail++] = i; lab[i] = id;
      while (head < tail) {
        var p = queue[head++], x = p % gw, y = (p - x) / gw;
        if (x > 0 && g[p - 1] && !lab[p - 1]) { lab[p - 1] = id; queue[tail++] = p - 1; }
        if (x < gw - 1 && g[p + 1] && !lab[p + 1]) { lab[p + 1] = id; queue[tail++] = p + 1; }
        if (y > 0 && g[p - gw] && !lab[p - gw]) { lab[p - gw] = id; queue[tail++] = p - gw; }
        if (y < gh - 1 && g[p + gw] && !lab[p + gw]) { lab[p + gw] = id; queue[tail++] = p + gw; }
      }
      if (tail > best) { best = tail; bestId = id; }
    }
    var o = new Uint8Array(n);
    if (bestId) for (i = 0; i < n; i++) o[i] = lab[i] === bestId ? 1 : 0;
    return o;
  }
  function fillHoles(g, gw, gh) {
    var n = gw * gh, outside = new Uint8Array(n), queue = new Int32Array(n), head = 0, tail = 0, x, y, i;
    function push(p) { if (!g[p] && !outside[p]) { outside[p] = 1; queue[tail++] = p; } }
    for (x = 0; x < gw; x++) { push(x); push((gh - 1) * gw + x); }
    for (y = 0; y < gh; y++) { push(y * gw); push(y * gw + gw - 1); }
    while (head < tail) {
      var p = queue[head++]; x = p % gw; y = (p - x) / gw;
      if (x > 0) push(p - 1); if (x < gw - 1) push(p + 1);
      if (y > 0) push(p - gw); if (y < gh - 1) push(p + gw);
    }
    var o = new Uint8Array(n);
    for (i = 0; i < n; i++) o[i] = outside[i] ? 0 : 1;
    return o;
  }

  // ---------- 5. Зв'язні плями на рівні пікселів ----------
  // Плями класу target площею >= minArea стають keepAs, менші — dropAs.
  // Якщо задано inside (маска зони ягід), пляма, що помітно межує із зовнішнім (стіна, лоток),
  // вважається тлом і стає OUT: біле на межі зони не відрізнити від стіни.
  function filterComponents(labels, w, h, target, minArea, keepAs, dropAs, queue, inside) {
    var TMP = 255, KEEP = 128 | keepAs, n = w * h, kept = 0, dropped = 0, maxArea = 0, edgePx = 0, i, j;
    for (i = 0; i < n; i++) {
      if (labels[i] !== target) continue;
      var head = 0, tail = 0, touch = 0; queue[tail++] = i; labels[i] = TMP;
      while (head < tail) {
        var p = queue[head++], x = p % w, y = (p - x) / w, t = 0;
        var x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0;
        for (var dy = y0; dy <= y1; dy++) for (var dx = x0; dx <= x1; dx++) {
          var q = p + dy * w + dx;
          if (labels[q] === target) { labels[q] = TMP; queue[tail++] = q; }
          else if (inside && !inside[q]) t = 1;
        }
        touch += t;
      }
      var out;
      if (inside && touch >= 3 && touch >= 0.08 * tail) { out = 0; edgePx += tail; }
      else if (tail >= minArea) { out = KEEP; kept++; if (tail > maxArea) maxArea = tail; }
      else { out = dropAs; dropped += tail; }
      for (j = 0; j < tail; j++) labels[queue[j]] = out;
    }
    for (i = 0; i < n; i++) if (labels[i] & 128) labels[i] &= 127;
    return { kept: kept, droppedPx: dropped, maxArea: maxArea, edgePx: edgePx };
  }

  // Гістерезис: впевнені пікселі класу strong «розростаються» на сусідні слабкі кандидати weak.
  // Слабкі, що не торкаються впевнених, стають rest.
  function growInto(labels, w, h, strong, weak, rest, queue) {
    var n = w * h, head = 0, tail = 0, i;
    for (i = 0; i < n; i++) if (labels[i] === strong) queue[tail++] = i;
    while (head < tail) {
      var p = queue[head++], x = p % w, y = (p - x) / w;
      var x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0;
      for (var dy = y0; dy <= y1; dy++) for (var dx = x0; dx <= x1; dx++) {
        var q = p + dy * w + dx;
        if (labels[q] === weak) { labels[q] = strong; queue[tail++] = q; }
      }
    }
    for (i = 0; i < n; i++) if (labels[i] === weak) labels[i] = rest;
  }

  // Розмикання 3×3 для одного класу: прибирає тонкі «нитки» (1–2 px), зберігаючи тіло плями.
  function openClass(labels, w, h, cls, rest) {
    var n = w * h, core = new Uint8Array(n), x, y, i, dx, dy, ok;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x; if (labels[i] !== cls) continue;
      ok = 1;
      for (dy = -1; dy <= 1 && ok; dy++) for (dx = -1; dx <= 1; dx++) if (labels[i + dy * w + dx] !== cls) { ok = 0; break; }
      core[i] = ok;
    }
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      i = y * w + x; if (labels[i] !== cls || core[i]) continue;
      ok = 0;
      for (dy = -1; dy <= 1 && !ok; dy++) for (dx = -1; dx <= 1; dx++) {
        var xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h && core[yy * w + xx]) { ok = 1; break; }
      }
      if (!ok) labels[i] = rest === cls ? cls : 200;   // 200 — тимчасова позначка «прибрати»
    }
    for (i = 0; i < n; i++) if (labels[i] === 200) labels[i] = rest;
  }

  // ---------- Головна функція ----------
  // rgba: Uint8ClampedArray (RGBA), opts.roiRect: {x0,y0,x1,y1} у частках кадру — ручна зона.
  BS.analyze = function (rgba, srcW, srcH, settings, opts) {
    settings = settings || BS.DEFAULT_SETTINGS;
    opts = opts || {};
    var cs = settings.color;
    var small = BS.resizeRGBA(rgba, srcW, srcH, settings.analysisSize || 1024);
    var w = small.w, h = small.h, n = w * h;
    var data = new Uint8ClampedArray(small.data);     // копія: баланс білого змінює пікселі
    var wb = whiteBalance(data, n);

    var H = new Float32Array(n), S = new Float32Array(n), V = new Float32Array(n);
    toHSV(data, n, H, S, V);

    var i, x, y, hist = new Uint32Array(256), histN = 0;
    var crate = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      if (cs.crateEnabled && S[i] >= cs.crateSatMin && V[i] >= 0.15 && inHue(H[i], cs.crateHueMin, cs.crateHueMax)) { crate[i] = 1; continue; }
      hist[(V[i] * 255) | 0]++; histN++;
    }
    var darkT = clamp(otsu(hist, histN), 0.30, 0.50);

    // --- зона ягід ---
    var cell = Math.max(4, Math.round(Math.max(w, h) / 128));
    var gw = Math.ceil(w / cell), gh = Math.ceil(h / cell);
    var roi, manual = false;
    if (opts.roiRect) {
      manual = true;
      roi = new Uint8Array(gw * gh);
      var r = opts.roiRect;
      for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
        var fx = (x + 0.5) * cell / w, fy = (y + 0.5) * cell / h;
        roi[y * gw + x] = (fx >= r.x0 && fx <= r.x1 && fy >= r.y0 && fy <= r.y1) ? 1 : 0;
      }
    } else {
      var seedCnt = new Uint16Array(gw * gh), cellCnt = new Uint16Array(gw * gh), gi;
      for (y = 0; y < h; y++) {
        var gy = ((y / cell) | 0) * gw;
        for (x = 0; x < w; x++) {
          i = y * w + x; gi = gy + ((x / cell) | 0);
          cellCnt[gi]++;
          if (crate[i]) continue;
          // «схоже на ягоду»: темне або червонувато-пурпурове
          if (V[i] < darkT || ((H[i] >= 320 || H[i] <= 12) && S[i] >= 0.2 && V[i] < 0.7)) seedCnt[gi]++;
        }
      }
      var grid = new Uint8Array(gw * gh);
      for (gi = 0; gi < gw * gh; gi++) grid[gi] = seedCnt[gi] >= 0.35 * cellCnt[gi] ? 1 : 0;
      grid = erode(dilate(grid, gw, gh, 3), gw, gh, 3);   // змикання: закриває плями плісняви, зелені ягоди
      grid = largestComponent(grid, gw, gh);
      grid = fillHoles(grid, gw, gh);
      roi = erode(grid, gw, gh, 1);                        // відступ від стіни/лотка
    }

    // --- експозиція: медіана яскравості зони ---
    var vh = new Uint32Array(256), roiN = 0;
    for (y = 0; y < h; y++) {
      var gy2 = ((y / cell) | 0) * gw;
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (!roi[gy2 + ((x / cell) | 0)] || crate[i]) continue;
        vh[(V[i] * 255) | 0]++; roiN++;
      }
    }
    var medianV = 0, acc = 0;
    for (i = 0; i < 256; i++) { acc += vh[i]; if (acc >= roiN / 2) { medianV = i / 255; break; } }
    var rawGain = medianV > 0 ? REF_MEDIAN_V / medianV : 1;
    var gain = clamp(rawGain, 0.75, 1.4);

    // --- класифікація ---
    var labels = new Uint8Array(n), inside = new Uint8Array(n), uncertain = 0, clipped = 0;
    for (y = 0; y < h; y++) {
      var gy3 = ((y / cell) | 0) * gw;
      for (x = 0; x < w; x++) {
        i = y * w + x;
        if (!roi[gy3 + ((x / cell) | 0)] || crate[i]) continue;      // OUT
        inside[i] = 1;
        var hh = H[i], s = S[i], v = V[i] * gain; if (v > 1) v = 1;
        if (V[i] >= 0.98) clipped++;
        var lab = C.GOOD;
        if (s < cs.moldSatMax && v >= cs.moldValMin) lab = WHITE;
        else if (s >= cs.greenSatMin && v >= cs.greenValMin && inHue(hh, cs.greenHueMin, cs.greenHueMax)) lab = C.GREEN;
        else if (s >= cs.debrisSatMin && v >= cs.debrisValMin && hh >= cs.debrisHueMin && hh < cs.greenHueMin) lab = C.DEBRIS;
        else if (s >= cs.redSatMin && v >= cs.redValMin && inHue(hh, cs.redHueMin, cs.redHueMax)) lab = C.RED;
        else if (s >= cs.redSatMin - 0.04 && v >= cs.redValMin - 0.06 && inHue(hh, cs.redHueMin - 8, cs.redHueMax + 4)) lab = WEAK_RED;
        else if (s < 0.15 && v >= 0.36) uncertain++;                  // сіре: тонкий наліт чи розсіяний блик — не знаємо
        labels[i] = lab;
      }
    }

    // --- плями: блик (дрібне) проти плісняви (більше) ---
    var scale2 = (Math.max(w, h) / 1024) * (Math.max(w, h) / 1024);
    var queue = new Int32Array(n);
    var mold = filterComponents(labels, w, h, WHITE, Math.max(4, cs.moldMinSpot * scale2), C.MOLD, C.GOOD, queue, inside);
    var speck = Math.max(3, cs.minSpeck * scale2);
    filterComponents(labels, w, h, C.RED, speck, C.RED, C.GOOD, queue);
    growInto(labels, w, h, C.RED, WEAK_RED, C.GOOD, queue);   // темніші краї тієї самої червоної ягоди
    openClass(labels, w, h, C.RED, C.GOOD);
    filterComponents(labels, w, h, C.RED, speck, C.RED, C.GOOD, queue);
    filterComponents(labels, w, h, C.GREEN, speck, C.GREEN, C.GOOD, queue);
    filterComponents(labels, w, h, C.DEBRIS, speck, C.DEBRIS, C.GOOD, queue);

    // --- статистика ---
    var cnt = [0, 0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) cnt[labels[i]]++;
    var roiPx = n - cnt[0];
    var counts = {}, percents = {};
    BS.CATEGORIES.forEach(function (c) {
      counts[c.key] = cnt[c.id];
      percents[c.key] = roiPx ? 100 * cnt[c.id] / roiPx : 0;
    });

    // різкість: середній модуль лапласіана яскравості в зоні ягід
    var lap = 0, lapN = 0;
    for (y = 1; y < h - 1; y += 2) for (x = 1; x < w - 1; x += 2) {
      i = y * w + x; if (!labels[i]) continue;
      lap += Math.abs(4 * V[i] - V[i - 1] - V[i + 1] - V[i - w] - V[i + w]); lapN++;
    }

    return {
      algo: BS.ALGO_VERSION,
      w: w, h: h, cell: cell, labels: labels,
      counts: counts, percents: percents,
      roiPx: roiPx, roiFraction: roiPx / n, manualRoi: manual,
      moldSpots: mold.kept,
      moldMaxSpotFraction: roiPx ? mold.maxArea / roiPx : 0,
      glareFraction: roiPx ? mold.droppedPx / roiPx : 0,
      uncertainFraction: roiPx ? uncertain / roiPx : 0,
      quality: {
        medianV: medianV, gain: gain, gainClamped: gain !== rawGain,
        clipped: roiPx ? clipped / roiPx : 0,
        sharpness: lapN ? 255 * lap / lapN : 0,
        wb: wb, darkThreshold: darkT,
        analysisLongSide: Math.max(w, h), srcLongSide: Math.max(srcW, srcH)
      }
    };
  };

  // ---------- 6. Шар поверх фото ----------
  // Повертає RGBA розміром result.w × result.h з прозорістю (малюється над фото).
  // mode: 'classes' — кольори категорій; 'heat' — теплова карта щільності дефектів.
  BS.renderOverlay = function (res, mode, hidden) {
    var w = res.w, h = res.h, n = w * h, labels = res.labels;
    var out = new Uint8ClampedArray(n * 4), i, p, lab;
    hidden = hidden || {};
    var pal = [], alpha = [];
    BS.CATEGORIES.forEach(function (c) { pal[c.id] = c.color; alpha[c.id] = hidden[c.key] ? 0 : (c.key === 'good' ? 46 : 200); });

    if (mode !== 'heat') {
      for (i = 0; i < n; i++) {
        p = i * 4; lab = labels[i];
        if (!lab) { out[p + 3] = 120; continue; }       // поза зоною — затемнити
        out[p] = pal[lab][0]; out[p + 1] = pal[lab][1]; out[p + 2] = pal[lab][2]; out[p + 3] = alpha[lab];
      }
      return out;
    }

    // щільність дефектів на грубій сітці → розмиття → плавне збільшення
    var cell = res.cell, gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), x, y, k;
    var wt = [0, 0, 0.7, 0.7, 1, 0.5];
    var num = new Float32Array(gw * gh), den = new Float32Array(gw * gh);
    for (y = 0; y < h; y++) for (x = 0; x < w; x++) {
      lab = labels[y * w + x]; if (!lab) continue;
      var gi = ((y / cell) | 0) * gw + ((x / cell) | 0);
      den[gi]++; num[gi] += wt[lab];
    }
    var d = new Float32Array(gw * gh), t = new Float32Array(gw * gh);
    for (i = 0; i < gw * gh; i++) d[i] = den[i] ? num[i] / (cell * cell) : 0;
    for (var pass = 0; pass < 2; pass++) {
      for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
        var s1 = 0, c1 = 0;
        for (k = Math.max(0, x - 2); k <= Math.min(gw - 1, x + 2); k++) { s1 += d[y * gw + k]; c1++; }
        t[y * gw + x] = s1 / c1;
      }
      for (y = 0; y < gh; y++) for (x = 0; x < gw; x++) {
        var s2 = 0, c2 = 0;
        for (k = Math.max(0, y - 2); k <= Math.min(gh - 1, y + 2); k++) { s2 += t[k * gw + x]; c2++; }
        d[y * gw + x] = s2 / c2;
      }
    }
    for (y = 0; y < h; y++) {
      var fy = y / cell - 0.5, y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(gh - 1, y0 + 1), ty = clamp(fy - y0, 0, 1);
      for (x = 0; x < w; x++) {
        p = (y * w + x) * 4;
        if (!labels[y * w + x]) { out[p + 3] = 120; continue; }
        var fx = x / cell - 0.5, x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(gw - 1, x0 + 1), tx = clamp(fx - x0, 0, 1);
        var v = (d[y0 * gw + x0] * (1 - tx) + d[y0 * gw + x1] * tx) * (1 - ty) + (d[y1 * gw + x0] * (1 - tx) + d[y1 * gw + x1] * tx) * ty;
        var u = clamp(v / 0.30, 0, 1);                  // 30 % дефектів навколо = максимум шкали
        if (u < 0.02) continue;
        // жовтий → помаранчевий → червоний; слабка щільність майже прозора
        out[p] = 255; out[p + 1] = Math.round(225 * (1 - u)); out[p + 2] = 0;
        out[p + 3] = Math.round(230 * Math.min(1, u * 1.4));
      }
    }
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BS;
})(typeof self !== 'undefined' ? self : globalThis);
