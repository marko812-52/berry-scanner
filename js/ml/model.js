/*
 * Навчена модель у браузері: ONNX Runtime Web (WASM), ліниве завантаження, кеш для офлайну (через sw.js).
 *   BS.model.supported()  — чи можна запускати модель тут (потрібен http(s) і WebAssembly);
 *   BS.model.load()       — завантажити рушій і модель (один раз; повторні виклики чекають на те саме);
 *   BS.model.predict(...) — ймовірності класів на сітці кроку 4 для фото, зменшеного так само, як у кольоровому методі;
 *   BS.model.combine(...) — результат у форматі BS.analyze для режимів «Модель» і «Гібрид».
 * Якщо щось не вдалося, BS.analyzer відкочується на кольоровий метод (js/core/analyzer.js).
 * WebGPU не використовується: його збірка ONNX Runtime важить 29,5 МБ — більше за ліміт Cloudflare 25 МіБ на файл,
 * а для цієї маленької моделі WASM достатньо швидкий.
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});
  var C = BS.CLASSES;
  var ORT_DIR = 'vendor/onnxruntime-1.31.1/';
  var MODEL_DIR = 'models/';
  var NC = 6;                                  // класів у моделі: фон + 5 категорій (як BS.CLASSES 0..5)

  var state = { status: 'idle', error: '', info: null, session: null, promise: null, loadMs: 0, lastMs: 0 };

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('Не вдалося завантажити ' + src)); };
      document.head.appendChild(s);
    });
  }

  /*
   * Кладе рушій і модель у кеш для офлайну (той самий кеш, що й у sw.js). Потрібно, бо при першому відкритті
   * сторінки service worker ще може не контролювати її — тоді запити йдуть повз нього і не кешуються.
   * Модель кладеться з уже завантажених байтів; файли рушія беруться з HTTP-кешу браузера (без повторного качання).
   */
  var MODEL_CACHE = 'berry-scanner-models';
  function keepOffline(buf) {
    if (!root.caches || !state.info) return;
    var abs = function (u) { return new URL(u, location.href).href; };
    var modelUrl = abs(MODEL_DIR + state.info.file + '?v=' + encodeURIComponent(state.info.version));
    var files = ['ort.wasm.min.js', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.wasm'].map(function (f) { return abs(ORT_DIR + f); });
    root.caches.open(MODEL_CACHE).then(function (cache) {
      return cache.keys().then(function (keys) {
        // старі версії моделі — геть
        keys.forEach(function (k) { if (k.url.split('?')[0] === modelUrl.split('?')[0] && k.url !== modelUrl) cache.delete(k); });
        var jobs = [cache.put(modelUrl, new Response(buf, { headers: { 'Content-Type': 'application/octet-stream' } }))];
        jobs.push(cache.put(abs(MODEL_DIR + 'berry-seg.json'), new Response(JSON.stringify(state.info), { headers: { 'Content-Type': 'application/json' } })));
        files.forEach(function (u) { jobs.push(cache.match(u).then(function (hit) { return hit || cache.add(u); })); });
        return Promise.all(jobs);
      });
    }).then(function () { state.offline = true; }, function (e) { if (root.console) root.console.warn('Модель не збережено для офлайну', e); });
  }

  BS.model = {
    state: state,

    supported: function () {
      return typeof root.WebAssembly === 'object' && typeof document !== 'undefined' &&
        typeof location !== 'undefined' && /^https?:$/.test(location.protocol);
    },

    // Promise<info>. Помилка не «залипає»: наступний виклик спробує ще раз.
    load: function () {
      if (state.promise) return state.promise;
      if (!BS.model.supported()) return Promise.reject(new Error('Модель працює лише на сторінці, відкритій за посиланням (не як файл)'));
      var t0 = Date.now();
      state.status = 'loading'; state.error = '';
      state.promise = fetch(MODEL_DIR + 'berry-seg.json', { cache: 'no-cache' })
        .then(function (r) { if (!r.ok) throw new Error('Модель ще не опублікована'); return r.json(); })
        .then(function (info) {
          state.info = info;
          return (root.ort ? Promise.resolve() : loadScript(ORT_DIR + 'ort.wasm.min.js')).then(function () {
            var ort = root.ort;
            ort.env.wasm.wasmPaths = new URL(ORT_DIR, location.href).href;
            // багатопотоковість потребує ізоляції сторінки (COOP/COEP); без неї — один потік
            ort.env.wasm.numThreads = root.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 2) : 1;
            // версія в адресі: оновлена модель не береться зі старого кешу
            return fetch(MODEL_DIR + info.file + '?v=' + encodeURIComponent(info.version));
          });
        })
        .then(function (r) { if (!r.ok) throw new Error('Не вдалося завантажити файл моделі'); return r.arrayBuffer(); })
        .then(function (buf) {
          keepOffline(buf);
          return root.ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
        })
        .then(function (session) {
          state.session = session; state.status = 'ready'; state.loadMs = Date.now() - t0;
          return state.info;
        })
        .catch(function (e) {
          state.status = 'error'; state.error = e && e.message || String(e); state.promise = null;
          throw e;
        });
      return state.promise;
    },

    /*
     * rgba — пікселі фото; повертає { prob: Float32Array (NC×gh×gw, softmax), gw, gh, w, h, species: [4], version }.
     * w×h — розмір аналізу, такий самий, як у кольорового методу (довша сторона settings.analysisSize).
     */
    predict: function (rgba, srcW, srcH, settings) {
      return BS.model.load().then(function (info) {
        var t0 = Date.now();
        var small = BS.resizeRGBA(rgba, srcW, srcH, (settings && settings.analysisSize) || 1024);
        var w = small.w, h = small.h, m = info.input.multiple || 32;
        var W = Math.ceil(w / m) * m, H = Math.ceil(h / m) * m, plane = W * H;
        var x = new Float32Array(3 * plane), d = small.data, i, y, xx, p, q;
        for (y = 0; y < h; y++) for (xx = 0; xx < w; xx++) {
          p = (y * w + xx) * 4; q = y * W + xx;
          x[q] = d[p] / 255; x[plane + q] = d[p + 1] / 255; x[2 * plane + q] = d[p + 2] / 255;
        }
        var feeds = {}; feeds[info.input.name || 'image'] = new root.ort.Tensor('float32', x, [1, 3, H, W]);
        return state.session.run(feeds).then(function (out) {
          var lg = out.logits, gh = lg.dims[2], gw = lg.dims[3], n = gh * gw, raw = lg.data, prob = new Float32Array(NC * n);
          for (i = 0; i < n; i++) {                                 // softmax по класах у кожній клітинці
            var mx = -Infinity, s = 0, k;
            for (k = 0; k < NC; k++) if (raw[k * n + i] > mx) mx = raw[k * n + i];
            for (k = 0; k < NC; k++) { var e = Math.exp(raw[k * n + i] - mx); prob[k * n + i] = e; s += e; }
            for (k = 0; k < NC; k++) prob[k * n + i] /= s;
          }
          var sl = out.species ? Array.prototype.slice.call(out.species.data) : null, sp = null;
          if (sl) { var smx = Math.max.apply(null, sl), ss = 0; sp = sl.map(function (v) { var e = Math.exp(v - smx); ss += e; return e; }).map(function (v) { return v / ss; }); }
          state.lastMs = Date.now() - t0;
          return { prob: prob, gw: gw, gh: gh, w: w, h: h, stride: info.stride || 4, species: sp, speciesHint: info.species_hint === true,
            speciesKeys: info.species, damagedProfiles: info.damaged_profiles || ['strawberry'], version: info.version, ms: state.lastMs };
        });
      });
    },

    /*
     * Поєднання з кольоровим методом. color — результат BS.analyze для того самого фото (той самий розмір w×h).
     *   model  — клас кожного пікселя від моделі; ручна зона, якщо є, обмежує аналіз;
     *   hybrid — основа — кольоровий метод; модель (1) знімає «плісняву», де впевнено бачить фон (стіна, папір),
     *            (2) додає плісняву, яку колір пропустив (сірий наліт), (3) додає «пошкоджені», яких колір не бачить.
     */
    combine: function (color, pred, mode, settings) {
      var w = color.w, h = color.h, n = w * h, cl = color.labels, gw = pred.gw, gh = pred.gh, st = pred.stride, gn = gw * gh;
      if (pred.w !== w || pred.h !== h) throw new Error('Розмір аналізу моделі й кольорового методу різний');
      var labels = new Uint8Array(n), pm = new Float32Array(NC), i, x, y, k, maxSum = 0, maxN = 0, modelMold = 0, modelBerry = 0;
      // «пошкоджені» модель бачила лише для деяких ягід (див. models/berry-seg.json); для решти цей клас їй не довіряємо
      var damagedOK = (pred.damagedProfiles || ['strawberry']).indexOf(color.profile) >= 0;
      for (y = 0; y < h; y++) {
        // білінійна інтерполяція ймовірностей між центрами клітинок
        var fy = (y + 0.5) / st - 0.5, y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(gh - 1, y0 + 1), ty = Math.min(1, Math.max(0, fy - y0));
        for (x = 0; x < w; x++) {
          var fx = (x + 0.5) / st - 0.5, x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(gw - 1, x0 + 1), tx = Math.min(1, Math.max(0, fx - x0));
          var a00 = y0 * gw + x0, a01 = y0 * gw + x1, a10 = y1 * gw + x0, a11 = y1 * gw + x1, best = 0;
          for (k = 0; k < NC; k++) {
            var o = k * gn, pr = pred.prob;
            pm[k] = (pr[o + a00] * (1 - tx) + pr[o + a01] * tx) * (1 - ty) + (pr[o + a10] * (1 - tx) + pr[o + a11] * tx) * ty;
            if (pm[k] > pm[best]) best = k;
          }
          if (!damagedOK && best === C.DAMAGED) {                      // друге за ймовірністю
            pm[C.DAMAGED] = 0; best = 0;
            for (k = 1; k < NC; k++) if (pm[k] > pm[best]) best = k;
          }
          i = y * w + x;
          var c = cl[i], inZone = c !== C.OUT, lab;
          if (mode === 'model') {
            lab = best;                                              // 0 = фон → поза зоною
            if (color.manualRoi && !inZone) lab = C.OUT;
          } else {
            lab = c;
            if (inZone) {
              // пропуск плісняви — найгірша помилка: модель знімає плісняву лише там, де впевнено бачить фон
              // (стіна, папір, дно лотка), і ніколи не перетворює її на «якісну»
              if (c === C.MOLD && pm[0] > 0.6 && pm[C.MOLD] < 0.15) lab = C.OTHER;
              else if (c !== C.MOLD && c !== C.OTHER && pm[C.MOLD] > 0.6) lab = C.MOLD;
              else if (damagedOK && c === C.GOOD && pm[C.DAMAGED] > 0.55) lab = C.DAMAGED;
            }
          }
          labels[i] = lab;
          if (lab !== C.OUT && lab !== C.OTHER) { maxSum += pm[best]; maxN++; }
          if (inZone && best > 0) { modelBerry++; if (best === C.MOLD) modelMold++; }
        }
      }
      var res = BS.statsOfLabels(labels, w, h, color);
      res.method = mode;
      res.modelVersion = pred.version;
      res.modelMs = pred.ms;
      res.modelConfidence = maxN ? maxSum / maxN : 0;
      res.colorMold = color.percents.mold;
      res.modelMold = modelBerry ? 100 * modelMold / modelBerry : 0;
      res.speciesProb = pred.species;
      // підказка виду: лише якщо її ввімкнено в описі моделі (точність перевірено на реальних фото) і модель упевнена
      if (pred.speciesHint && pred.species && pred.speciesKeys) {
        var bi = pred.species.indexOf(Math.max.apply(null, pred.species));
        if (pred.species[bi] >= 0.85 && pred.speciesKeys[bi] !== color.profile) res.speciesHint = pred.speciesKeys[bi];
      }
      return res;
    }
  };

  // Статистика для карти класів (той самий формат, що й у BS.analyze). base — результат кольорового методу.
  BS.statsOfLabels = function (labels, w, h, base) {
    var n = w * h, cnt = [0, 0, 0, 0, 0, 0, 0], i;
    for (i = 0; i < n; i++) cnt[labels[i]]++;
    var roiPx = n - cnt[0], berryPx = roiPx - cnt[C.OTHER], counts = {}, percents = {};
    BS.CATEGORIES.forEach(function (c) { counts[c.key] = cnt[c.id]; percents[c.key] = berryPx ? 100 * cnt[c.id] / berryPx : 0; });
    counts.other = cnt[C.OTHER];
    // плями плісняви: зв'язні області площею від ~30 px² (при масштабі 1024)
    var minArea = Math.max(4, 30 * Math.pow(Math.max(w, h) / 1024, 2)), seen = new Uint8Array(n), queue = new Int32Array(n), spots = 0, maxSpot = 0;
    for (i = 0; i < n; i++) {
      if (labels[i] !== C.MOLD || seen[i]) continue;
      var head = 0, tail = 0; queue[tail++] = i; seen[i] = 1;
      while (head < tail) {
        var p = queue[head++], x = p % w, y = (p - x) / w;
        if (x > 0 && !seen[p - 1] && labels[p - 1] === C.MOLD) { seen[p - 1] = 1; queue[tail++] = p - 1; }
        if (x < w - 1 && !seen[p + 1] && labels[p + 1] === C.MOLD) { seen[p + 1] = 1; queue[tail++] = p + 1; }
        if (y > 0 && !seen[p - w] && labels[p - w] === C.MOLD) { seen[p - w] = 1; queue[tail++] = p - w; }
        if (y < h - 1 && !seen[p + w] && labels[p + w] === C.MOLD) { seen[p + w] = 1; queue[tail++] = p + w; }
      }
      if (tail >= minArea) { spots++; if (tail > maxSpot) maxSpot = tail; }
    }
    return {
      algo: base.algo, profile: base.profile, w: w, h: h, cell: base.cell, labels: labels,
      counts: counts, percents: percents, roiPx: roiPx, berryPx: berryPx,
      roiFraction: roiPx / n, berryFraction: berryPx / n, otherFraction: roiPx ? cnt[C.OTHER] / roiPx : 0,
      manualRoi: base.manualRoi, moldSpots: spots, moldMaxSpotFraction: berryPx ? maxSpot / berryPx : 0,
      glareFraction: base.glareFraction, uncertainFraction: base.uncertainFraction, quality: base.quality
    };
  };
})(typeof self !== 'undefined' ? self : globalThis);
