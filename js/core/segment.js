/*
 * Кольоровий метод (HSV) v1: зона ягід + класи за кольором + розбір білих плям (пліснява / блик / фон).
 * Чисті функції над масивами пікселів, без DOM. Вхід — RGBA, вихід — карта класів і статистика.
 *
 * Послідовність:
 *   1) зменшення до analysisSize;
 *   2) баланс білого за нейтральними світлими пікселями (стіна, блики);
 *   3) зона ягід: автоматично (маса «схожих на ягоду» пікселів на грубій сітці) або обведена вручну;
 *      біла стіна і біла пліснява мають однаковий колір, тому класи шукаємо лише всередині зони;
 *   4) класифікація пікселів за правилами профілю ягоди;
 *   5) кожна біла пляма окремо: пліснява, блик чи фон — за розміром, оточенням, гладкістю й різкістю краю;
 *   6) відсів дрібних кольорових цяток, статистика.
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});
  if (typeof module !== 'undefined' && module.exports && !BS.CLASSES) require('./defaults.js');
  var C = BS.CLASSES;
  // тимчасові класи (у результат не потрапляють)
  var WHITE = 100;          // світле нейтральне: пліснява, блик або фон — вирішується по плямах
  var WEAK = 101;           // слабкий кандидат у «недостиглі»: рахується лише поруч із впевненим
  var GLARE = 102;          // блик: після розбору плям стає «якісною» ягодою

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
  function whiteBalance(data, n, satMax) {
    var sr = 0, sg = 0, sb = 0, cnt = 0, i, p, r, g, b, mx, mn;
    for (i = 0; i < n; i++) {
      p = i * 4; r = data[p]; g = data[p + 1]; b = data[p + 2];
      mx = r > g ? (r > b ? r : b) : (g > b ? g : b);
      if (mx < 150 || mx > 250) continue;
      mn = r < g ? (r < b ? r : b) : (g < b ? g : b);
      if ((mx - mn) > satMax * mx) continue;
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

  // ---------- 4. Зона ягід ----------
  // Ручна зона: багатокутник (обведення пальцем) у частках кадру → маска пікселів.
  BS.rasterPolygon = function (points, w, h) {
    var mask = new Uint8Array(w * h), n = points.length, xs = [], y, i, j, k;
    if (n < 3) return mask;
    for (y = 0; y < h; y++) {
      var py = y + 0.5; xs.length = 0;
      for (i = 0, j = n - 1; i < n; j = i++) {
        var ay = points[i].y * h, by = points[j].y * h;
        if ((ay > py) !== (by > py)) xs.push(points[i].x * w + (py - ay) / (by - ay) * (points[j].x * w - points[i].x * w));
      }
      xs.sort(function (a, b) { return a - b; });
      for (k = 0; k + 1 < xs.length; k += 2) {
        var x0 = Math.max(0, Math.ceil(xs[k] - 0.5)), x1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
        for (var x = x0; x <= x1; x++) mask[y * w + x] = 1;
      }
    }
    return mask;
  };

  function isSeed(seed, h, s, v, darkT) {
    if (seed.dark && v < darkT) return true;
    return inHue(h, seed.hue[0], seed.hue[1]) && s >= seed.satMin && v < seed.valMax;
  }

  // Автоматична зона: маса «схожих на ягоду» пікселів на грубій сітці.
  // Гладкі ділянки того самого кольору (темний стіл, тінь, чорний пластик) відсіюються за текстурою:
  // маса ягід завжди рясніє дрібними перепадами яскравості.
  function autoZone(H, S, V, crate, w, h, cell, seed, darkT) {
    var gw = Math.ceil(w / cell), gh = Math.ceil(h / cell), gn = gw * gh;
    var seedCnt = new Uint16Array(gn), cellCnt = new Uint16Array(gn), tex = new Float32Array(gn), x, y, i, gi;
    for (y = 0; y < h; y++) {
      var gy = ((y / cell) | 0) * gw;
      for (x = 0; x < w; x++) {
        i = y * w + x; gi = gy + ((x / cell) | 0);
        cellCnt[gi]++;
        if (x > 0 && y > 0 && x < w - 1 && y < h - 1) tex[gi] += Math.abs(4 * V[i] - V[i - 1] - V[i + 1] - V[i - w] - V[i + w]);
        if (!crate[i] && isSeed(seed, H[i], S[i], V[i], darkT)) seedCnt[gi]++;
      }
    }
    var grid = new Uint8Array(gn), vals = [];
    for (gi = 0; gi < gn; gi++) {
      grid[gi] = seedCnt[gi] >= 0.35 * cellCnt[gi] ? 1 : 0;
      tex[gi] /= cellCnt[gi] || 1;
      if (grid[gi]) vals.push(tex[gi]);
    }
    if (vals.length > 8) {
      vals.sort(function (a, b) { return a - b; });
      var texMin = 0.2 * vals[Math.floor(vals.length * 0.75)];
      for (gi = 0; gi < gn; gi++) if (grid[gi] && tex[gi] < texMin) grid[gi] = 0;
    }
    grid = erode(dilate(grid, gw, gh, 3), gw, gh, 3);   // змикання: закриває плями плісняви, недостиглі ягоди
    grid = largestComponent(grid, gw, gh);
    grid = fillHoles(grid, gw, gh);
    grid = erode(grid, gw, gh, 1);                      // відступ від стіни/лотка
    var zone = new Uint8Array(w * h);
    for (y = 0; y < h; y++) {
      var gy2 = ((y / cell) | 0) * gw;
      for (x = 0; x < w; x++) zone[y * w + x] = grid[gy2 + ((x / cell) | 0)];
    }
    return zone;
  }

  // ---------- 5. Зв'язні плями на рівні пікселів ----------
  // Плями класу target площею >= minArea стають keepAs, менші — dropAs.
  function filterComponents(labels, w, h, target, minArea, keepAs, dropAs, queue) {
    var TMP = 255, KEEP = 128 | keepAs, n = w * h, i, j;
    for (i = 0; i < n; i++) {
      if (labels[i] !== target) continue;
      var head = 0, tail = 0; queue[tail++] = i; labels[i] = TMP;
      while (head < tail) {
        var p = queue[head++], x = p % w, y = (p - x) / w;
        var x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0;
        for (var dy = y0; dy <= y1; dy++) for (var dx = x0; dx <= x1; dx++) {
          var q = p + dy * w + dx;
          if (labels[q] === target) { labels[q] = TMP; queue[tail++] = q; }
        }
      }
      var out = tail >= minArea ? KEEP : dropAs;
      for (j = 0; j < tail; j++) labels[queue[j]] = out;
    }
    for (i = 0; i < n; i++) if (labels[i] & 128) labels[i] &= 127;
  }

  /*
   * Білі (світлі нейтральні) плями: пліснява, блик чи фон?
   * Колір у них однаковий, тому дивимось на форму й оточення кожної плями:
   *   - торкається краю зони або межує з лотком/стіною     → поза зоною (OUT);
   *   - дуже мала                                           → блик (рахується як ягода);
   *   - надто велика, або навколо мало ягід                 → фон / інше (OTHER);
   *   - дуже яскрава з різким краєм і невелика              → блик;
   *   - усередині гладка, як папір чи пластик               → фон / інше;
   *   - решта: нерівна, з м'якшим краєм, серед ягід         → пліснява.
   * V — яскравість 0..1 (після балансу білого, без вирівнювання експозиції).
   */
  function classifyWhiteSpots(labels, w, h, V, inside, zonePx, minSpot, sp, scale, queue, debug) {
    var n = w * h, TMP = 255, stamp = new Int32Array(n), ringQ = new Int32Array(n), id = 0, i, j;
    var R = Math.max(2, Math.round(sp.ring * scale));
    var st = { mold: 0, moldPx: 0, maxMold: 0, glarePx: 0, otherPx: 0, edgePx: 0, spots: debug ? [] : null };
    for (i = 0; i < n; i++) {
      if (labels[i] !== WHITE) continue;
      id++;
      var head = 0, tail = 0, touch = 0, sumV = 0, border = 0;
      queue[tail++] = i; labels[i] = TMP;
      while (head < tail) {
        var p = queue[head++], x = p % w, y = (p - x) / w, t = 0;
        var x0 = x > 0 ? -1 : 0, x1 = x < w - 1 ? 1 : 0, y0 = y > 0 ? -1 : 0, y1 = y < h - 1 ? 1 : 0;
        if (x0 === 0 || x1 === 0 || y0 === 0 || y1 === 0) border++;
        for (var dy = y0; dy <= y1; dy++) for (var dx = x0; dx <= x1; dx++) {
          var q = p + dy * w + dx;
          if (labels[q] === WHITE) { labels[q] = TMP; queue[tail++] = q; }
          else if (!inside[q]) t = 1;
        }
        touch += t; sumV += V[p];
      }
      var area = tail, meanV = sumV / area;

      // край плями (різкість) і її нутрощі (гладкість)
      var gB = 0, nB = 0, gI = 0, nI = 0;
      for (j = 0; j < area; j++) {
        p = queue[j]; x = p % w; y = (p - x) / w;
        if (x < 1 || y < 1 || x > w - 2 || y > h - 2) continue;
        var gx = (V[p + 1] - V[p - 1]) * 0.5, gy = (V[p + w] - V[p - w]) * 0.5, g = Math.sqrt(gx * gx + gy * gy);
        if (labels[p - 1] !== TMP || labels[p + 1] !== TMP || labels[p - w] !== TMP || labels[p + w] !== TMP) { gB += g; nB++; }
        else if (labels[p - w - 1] === TMP && labels[p - w + 1] === TMP && labels[p + w - 1] === TMP && labels[p + w + 1] === TMP) { gI += g; nI++; }
      }

      // кільце навколо плями: що її оточує
      var rHead = 0, rTail = 0, nBerry = 0, nOut = border * R, nWhite = 0, sumRing = 0;
      for (j = 0; j < area; j++) { stamp[queue[j]] = id; ringQ[rTail++] = queue[j]; }
      for (var layer = 0; layer < R; layer++) {
        var end = rTail;
        for (; rHead < end; rHead++) {
          p = ringQ[rHead]; x = p % w; y = (p - x) / w;
          for (var d = 0; d < 4; d++) {
            if (d === 0) { if (x === 0) continue; q = p - 1; }
            else if (d === 1) { if (x === w - 1) continue; q = p + 1; }
            else if (d === 2) { if (y === 0) continue; q = p - w; }
            else { if (y === h - 1) continue; q = p + w; }
            if (stamp[q] === id) continue;
            stamp[q] = id; ringQ[rTail++] = q;
            if (!inside[q]) nOut++;
            else if (labels[q] === WHITE || labels[q] === C.MOLD || labels[q] === C.OTHER || labels[q] === GLARE) nWhite++;
            else { nBerry++; sumRing += V[q]; }
          }
        }
      }
      var surround = nBerry / Math.max(1, nBerry + nOut + 0.5 * nWhite);
      var contrast = meanV - (nBerry ? sumRing / nBerry : 0);
      var edge = nB ? (gB / nB) / Math.max(0.08, contrast) : 0;
      var flat = nI >= 8 ? gI / nI : -1;                       // -1: пляма замала, нутрощів немає

      var kind;
      if (touch >= 3 && touch >= 0.08 * area) kind = 'edge';
      else if (area < minSpot) kind = 'glare';
      else if (area > sp.bigFraction * zonePx) kind = 'other';
      else if (surround < sp.surroundMin) kind = 'other';
      else if (meanV >= sp.glareV && edge >= sp.glareEdge && area <= sp.glareMaxSpots * minSpot) kind = 'glare';
      else if (flat >= 0 && flat < sp.flatMax) kind = 'other';
      else kind = 'mold';

      var out = kind === 'edge' ? C.OUT : kind === 'glare' ? GLARE : kind === 'other' ? C.OTHER : C.MOLD;
      for (j = 0; j < area; j++) labels[queue[j]] = out;
      if (kind === 'edge') { st.edgePx += area; for (j = 0; j < area; j++) inside[queue[j]] = 0; }
      else if (kind === 'glare') st.glarePx += area;
      else if (kind === 'other') st.otherPx += area;
      else { st.mold++; st.moldPx += area; if (area > st.maxMold) st.maxMold = area; }
      if (debug) st.spots.push({ x: i % w, y: (i / w) | 0, area: area, kind: kind, meanV: meanV, edge: edge, flat: flat, surround: surround, contrast: contrast });
    }
    for (i = 0; i < n; i++) if (labels[i] === GLARE) labels[i] = C.GOOD;

    // дірочки всередині плям плісняви (темніші волокна, шум): піксель, оточений пліснявою з 5+ боків, теж пліснява
    var fill = [];
    for (var yy = 1; yy < h - 1; yy++) for (var xx = 1; xx < w - 1; xx++) {
      i = yy * w + xx;
      if (labels[i] === C.MOLD || !inside[i]) continue;
      var m = 0;
      if (labels[i - 1] === C.MOLD) m++; if (labels[i + 1] === C.MOLD) m++;
      if (labels[i - w] === C.MOLD) m++; if (labels[i + w] === C.MOLD) m++;
      if (m < 2) continue;
      if (labels[i - w - 1] === C.MOLD) m++; if (labels[i - w + 1] === C.MOLD) m++;
      if (labels[i + w - 1] === C.MOLD) m++; if (labels[i + w + 1] === C.MOLD) m++;
      if (m >= 5) fill.push(i);
    }
    for (j = 0; j < fill.length; j++) labels[fill[j]] = C.MOLD;
    st.moldPx += fill.length;
    return st;
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
      if (!ok) labels[i] = 200;                         // 200 — тимчасова позначка «прибрати»
    }
    for (i = 0; i < n; i++) if (labels[i] === 200) labels[i] = rest;
  }

  // Правила профілю → плоскі масиви для швидкого циклу по пікселях.
  function compileRules(rules) {
    return rules.map(function (r) {
      return {
        cls: r.weak ? WEAK : C[r.cls], h0: r.hue[0], h1: r.hue[1],
        s0: r.satMin == null ? 0 : r.satMin, s1: r.satMax == null ? 2 : r.satMax,
        v0: r.valMin == null ? 0 : r.valMin, v1: r.valMax == null ? 2 : r.valMax
      };
    });
  }

  // ---------- Головна функція ----------
  // rgba: Uint8ClampedArray (RGBA).
  // opts.roiPoly: [{x,y},…] у частках кадру — зона, обведена вручну; opts.roiRect: {x0,y0,x1,y1} — прямокутна (старі записи).
  // opts.debug: додати до результату список білих плям з ознаками (для налагодження порогів).
  // opts.pxScale: масштаб пікселя відносно фото, зменшеного до 1024 px (для плиток, вирізаних з такого фото, — 1).
  //   Типово — довша сторона / 1024: пороги площі плям і розмір сітки зони рахуються від нього.
  BS.analyze = function (rgba, srcW, srcH, settings, opts) {
    settings = settings || BS.DEFAULT_SETTINGS;
    opts = opts || {};
    var prof = BS.profileOf(settings), sp = settings.spot || BS.DEFAULT_SETTINGS.spot;
    var small = BS.resizeRGBA(rgba, srcW, srcH, settings.analysisSize || 1024);
    var w = small.w, h = small.h, n = w * h;
    var data = new Uint8ClampedArray(small.data);     // копія: баланс білого змінює пікселі
    var wb = whiteBalance(data, n, prof.wbSatMax || 0.25);

    var H = new Float32Array(n), S = new Float32Array(n), V = new Float32Array(n);
    toHSV(data, n, H, S, V);

    var i, x, y, hist = new Uint32Array(256), histN = 0;
    var crate = new Uint8Array(n), cr = prof.crate;
    for (i = 0; i < n; i++) {
      if (cr.enabled && S[i] >= cr.satMin && V[i] >= cr.valMin && inHue(H[i], cr.hue[0], cr.hue[1])) { crate[i] = 1; continue; }
      hist[(V[i] * 255) | 0]++; histN++;
    }
    var darkT = clamp(otsu(hist, histN), 0.30, 0.50);

    // --- зона ягід ---
    var scale = opts.pxScale || Math.max(w, h) / 1024, scale2 = scale * scale;
    var cell = Math.max(4, Math.round(8 * scale));
    var zone, manual = false;
    if (opts.roiPoly && opts.roiPoly.length >= 3) {
      manual = true; zone = BS.rasterPolygon(opts.roiPoly, w, h);
    } else if (opts.roiRect) {
      manual = true;
      var r = opts.roiRect;
      zone = BS.rasterPolygon([{ x: r.x0, y: r.y0 }, { x: r.x1, y: r.y0 }, { x: r.x1, y: r.y1 }, { x: r.x0, y: r.y1 }], w, h);
    } else {
      zone = autoZone(H, S, V, crate, w, h, cell, prof.seed, darkT);
    }

    // --- експозиція: медіана яскравості «тіла ягід» у зоні ---
    // Лише пікселі, схожі на ягоду: так результат не залежить від того, скільки стіни чи лотка
    // потрапило в зону, обведену вручну.
    var vh = new Uint32Array(256), zoneN = 0, bodyN = 0;
    for (i = 0; i < n; i++) {
      if (!zone[i] || crate[i]) continue;
      zoneN++;
      if (isSeed(prof.seed, H[i], S[i], V[i], darkT)) { vh[(V[i] * 255) | 0]++; bodyN++; }
    }
    var medianV = 0, acc = 0;
    for (i = 0; i < 256; i++) { acc += vh[i]; if (acc >= bodyN / 2) { medianV = i / 255; break; } }
    var rawGain = medianV > 0 ? prof.refV / medianV : 1;
    var gain = clamp(rawGain, prof.gainMin, prof.gainMax);

    // --- класифікація пікселів ---
    var labels = new Uint8Array(n), inside = new Uint8Array(n), uncertain = 0, clipped = 0;
    var rules = compileRules(prof.rules), nr = rules.length, wh = prof.white, k, rule;
    var skip = wh.skipHue, hasWeak = rules.some(function (q) { return q.cls === WEAK; });
    for (i = 0; i < n; i++) {
      if (!zone[i] || crate[i]) continue;                            // OUT
      inside[i] = 1;
      var hh = H[i], s = S[i], v = V[i] * gain; if (v > 1) v = 1;
      if (V[i] >= 0.98) clipped++;
      var lab = C.GOOD;
      if (s < wh.satMax && v >= wh.valMin && !(skip && s >= wh.skipSatMin && inHue(hh, skip[0], skip[1]))) lab = WHITE;
      else {
        for (k = 0; k < nr; k++) {
          rule = rules[k];
          if (s >= rule.s0 && s < rule.s1 && v >= rule.v0 && v < rule.v1 && inHue(hh, rule.h0, rule.h1)) { lab = rule.cls; break; }
        }
        if (lab === C.GOOD && s < 0.15 && v >= 0.36 && prof.seed.dark) uncertain++;   // сіре: тонкий наліт чи розсіяний блик — не знаємо
      }
      labels[i] = lab;
    }

    // --- білі плями: пліснява, блик чи фон ---
    var queue = new Int32Array(n);
    var spots = classifyWhiteSpots(labels, w, h, V, inside, zoneN, Math.max(4, prof.moldMinSpot * scale2), sp, scale, queue, opts.debug);

    // --- кольорові плями: прибрати шум ---
    var speck = Math.max(3, prof.minSpeck * scale2);
    filterComponents(labels, w, h, C.UNRIPE, speck, C.UNRIPE, C.GOOD, queue);
    if (hasWeak) {
      growInto(labels, w, h, C.UNRIPE, WEAK, C.GOOD, queue);          // темніші краї тієї самої недостиглої ягоди
      openClass(labels, w, h, C.UNRIPE, C.GOOD);
      filterComponents(labels, w, h, C.UNRIPE, speck, C.UNRIPE, C.GOOD, queue);
    }
    filterComponents(labels, w, h, C.DEBRIS, speck, C.DEBRIS, C.GOOD, queue);

    // --- статистика: частки рахуються від площі ягід (без «фону / іншого») ---
    var cnt = [0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < n; i++) cnt[labels[i]]++;
    var roiPx = n - cnt[0], berryPx = roiPx - cnt[C.OTHER];
    var counts = {}, percents = {};
    BS.CATEGORIES.forEach(function (c) {
      counts[c.key] = cnt[c.id];
      percents[c.key] = berryPx ? 100 * cnt[c.id] / berryPx : 0;
    });
    counts.other = cnt[C.OTHER];

    // різкість: середній модуль лапласіана яскравості в зоні ягід
    var lap = 0, lapN = 0;
    for (y = 1; y < h - 1; y += 2) for (x = 1; x < w - 1; x += 2) {
      i = y * w + x; if (!labels[i] || labels[i] === C.OTHER) continue;
      lap += Math.abs(4 * V[i] - V[i - 1] - V[i + 1] - V[i - w] - V[i + w]); lapN++;
    }

    var res = {
      algo: BS.ALGO_VERSION, method: 'color', profile: prof.key,
      w: w, h: h, cell: cell, labels: labels,
      counts: counts, percents: percents,
      roiPx: roiPx, berryPx: berryPx,
      roiFraction: roiPx / n, berryFraction: berryPx / n, otherFraction: roiPx ? cnt[C.OTHER] / roiPx : 0,
      manualRoi: manual,
      moldSpots: spots.mold,
      moldMaxSpotFraction: berryPx ? spots.maxMold / berryPx : 0,
      glareFraction: berryPx ? spots.glarePx / berryPx : 0,
      uncertainFraction: berryPx ? uncertain / berryPx : 0,
      quality: {
        medianV: medianV, refV: prof.refV, gain: gain, gainClamped: gain !== rawGain,
        clipped: roiPx ? clipped / roiPx : 0,
        sharpness: lapN ? 255 * lap / lapN : 0,
        wb: wb, darkThreshold: darkT,
        analysisLongSide: Math.max(w, h), srcLongSide: Math.max(srcW, srcH)
      }
    };
    if (opts.debug) res.spots = spots.spots;
    return res;
  };

  /*
   * Швидка перевірка якості фото ДО аналізу (екран «Нова партія»): темне, засвічене, розмите.
   * Працює на зменшеній копії, не шукає ягід. Повертає { ok, issues: [{code, text, tip}], metrics }.
   */
  BS.photoQuality = function (rgba, srcW, srcH) {
    var small = BS.resizeRGBA(rgba, srcW, srcH, 512), w = small.w, h = small.h, n = w * h, d = small.data;
    var L = new Float32Array(n), i, x, y, sum = 0, dark = 0, bright = 0;
    for (i = 0; i < n; i++) {
      var l = (0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]) / 255;
      L[i] = l; sum += l;
      if (l < 0.06) dark++; else if (l > 0.97) bright++;
    }
    var lap = 0, lapN = 0;
    for (y = 1; y < h - 1; y++) for (x = 1; x < w - 1; x++) {
      i = y * w + x;
      lap += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]); lapN++;
    }
    var m = { mean: sum / n, darkFraction: dark / n, brightFraction: bright / n, sharpness: lapN ? 255 * lap / lapN : 0, longSide: Math.max(srcW, srcH) };
    var issues = [];
    if (m.mean < 0.10 || m.darkFraction > 0.75) issues.push({ code: 'dark', text: 'Темне фото', tip: 'Додайте світла або підійдіть ближче до лампи. Спалах краще не вмикати.' });
    if (m.brightFraction > 0.12) issues.push({ code: 'bright', text: 'Засвічене фото', tip: 'Приберіть пряме світло й спалах, не знімайте проти вікна.' });
    if (m.sharpness < 2.2) issues.push({ code: 'blur', text: 'Розмите фото', tip: 'Тримайте пристрій нерухомо, торкніться екрана для фокусування, протріть об’єктив.' });
    if (m.longSide < 600) issues.push({ code: 'lowres', text: 'Мале фото', tip: 'Знімайте камерою пристрою, а не надсилайте зменшену копію з месенджера.' });
    return { ok: !issues.length, issues: issues, metrics: m };
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
    pal[C.OTHER] = BS.OTHER.color; alpha[C.OTHER] = hidden.other ? 0 : 150;

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
    var wt = [0, 0, 0.7, 0.8, 1, 0.5, 0];
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
