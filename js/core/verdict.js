/*
 * Вердикт і рівень впевненості. Без DOM.
 * Впевненість — це не статистична ймовірність, а сума штрафів за умови зйомки
 * та за близькість результату до порогів. Її завдання — вчасно покликати людину.
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});
  if (typeof module !== 'undefined' && module.exports && !BS.CLASSES) require('./defaults.js');

  var SHARP_MIN = 6.0;      // різкість нижче цього — «нечітке» (зразок дає близько 17)
  var MAX_SCORE = 90;       // кольорова евристика не може бути впевнена на 100 %

  BS.VERDICTS.unknown = { label: 'Не визначено — ягід на фото не знайдено', short: 'Не визначено' };

  function r1(v) { return Math.round(v * 10) / 10; }
  BS.round1 = r1;
  BS.fmtPct = function (v) { return r1(v).toFixed(1).replace('.', ','); };
  function f(v) { return BS.fmtPct(v) + ' %'; }

  // p: { mold, unripe, debris } у відсотках
  BS.decide = function (p, vs) {
    var over = [];
    function check(val, lim, name, stage) { if (val > lim) over.push(name + ' ' + f(val) + ' — понад поріг ' + stage + ' ' + f(lim)); }
    if (p.mold <= vs.freezeMold && p.unripe <= vs.freezeUnripe && p.debris <= vs.freezeDebris) {
      return { code: 'freeze', reasons: ['Пліснява, недостиглі та домішки — у межах порогів для заморожування'] };
    }
    if (p.mold <= vs.processMold && p.unripe <= vs.processUnripe && p.debris <= vs.processDebris) {
      check(p.mold, vs.freezeMold, 'Пліснява', 'заморожування');
      check(p.unripe, vs.freezeUnripe, 'Недостиглі (червоні + зелені)', 'заморожування');
      check(p.debris, vs.freezeDebris, 'Домішки', 'заморожування');
      return { code: 'process', reasons: over };
    }
    check(p.mold, vs.processMold, 'Пліснява', 'переробки');
    check(p.unripe, vs.processUnripe, 'Недостиглі (червоні + зелені)', 'переробки');
    check(p.debris, vs.processDebris, 'Домішки', 'переробки');
    return { code: 'reject', reasons: over };
  };

  // Штрафи за умови зйомки одного фото.
  BS.photoConfidence = function (res) {
    var issues = [], q = res.quality;
    function add(code, penalty, text) { issues.push({ code: code, penalty: Math.round(penalty), text: text }); }
    if (res.roiFraction < 0.05) {
      add('no-berries', 95, 'Не вдалося знайти ягоди на фото');
      return { score: 5, issues: issues };
    }
    if (!res.manualRoi && res.roiFraction < 0.35) add('roi-small', Math.min(30, (0.35 - res.roiFraction) * 120 + 6), 'Ягоди займають малу частину кадру (' + Math.round(res.roiFraction * 100) + ' %) — знімайте ближче');
    if (q.medianV < 0.07) add('dark', 20, 'Фото затемне');
    else if (q.medianV > 0.45) add('bright', 20, 'Фото пересвічене або ягоди світлі');
    else if (q.gainClamped) add('exposure', 8, 'Незвична яскравість фото');
    if (q.clipped > 0.03) add('clipped', 10, 'Багато пересвічених ділянок');
    if (q.sharpness < SHARP_MIN) add('blur', Math.min(25, 8 + (SHARP_MIN - q.sharpness) * 5), 'Фото нечітке');
    if (res.glareFraction > 0.04) add('glare', Math.min(20, 4 + (res.glareFraction - 0.04) * 300), 'Багато бліків (' + f(res.glareFraction * 100) + ')');
    if (res.uncertainFraction > 0.08) add('grey', Math.min(20, 4 + (res.uncertainFraction - 0.08) * 200), 'Багато сірих ділянок: тонкий наліт не відрізнити від відблиску (' + f(res.uncertainFraction * 100) + ')');
    if (q.wb.clamped) add('cast', 15, 'Сильний кольоровий відтінок освітлення');
    else if (!q.wb.applied) add('no-white', 5, 'Немає світлого орієнтира для балансу білого');
    if (q.srcLongSide < 600) add('lowres', 15, 'Низька роздільність фото');
    if (res.moldMaxSpotFraction > 0.06) add('big-white', 15, 'Велика біла ділянка — можливо, це не пліснява, а тло чи сторонній предмет');
    var score = 100;
    issues.forEach(function (i) { score -= i.penalty; });
    return { score: Math.max(5, Math.min(MAX_SCORE, score)), issues: issues };
  };

  // Зведення по партії: results — масив результатів BS.analyze (або збережених підсумків фото).
  BS.evaluateBatch = function (results, settings) {
    settings = settings || BS.DEFAULT_SETTINGS;
    var vs = settings.verdict, cf = settings.confidence;
    var total = 0, percents = {}, spots = 0, scoreSum = 0, issues = [], seen = {}, perPhoto = [];
    BS.CATEGORIES.forEach(function (c) { percents[c.key] = 0; });
    results.forEach(function (r) {
      var pc = BS.photoConfidence(r);
      perPhoto.push(pc);
      var wgt = Math.max(1, r.roiPx);
      total += wgt; scoreSum += pc.score * wgt; spots += r.moldSpots || 0;
      BS.CATEGORIES.forEach(function (c) { percents[c.key] += r.percents[c.key] * wgt; });
      pc.issues.forEach(function (i) { if (!seen[i.code]) { seen[i.code] = 1; issues.push(i); } });
    });
    BS.CATEGORIES.forEach(function (c) { percents[c.key] = total ? percents[c.key] / total : 0; });
    var score = total ? scoreSum / total : 5;

    var found = results.some(function (r) { return r.roiFraction >= 0.05; });
    var p = { mold: percents.mold, unripe: percents.red + percents.green, debris: percents.debris };
    var verdict = found ? BS.decide(p, vs) : { code: 'unknown', reasons: [] };

    // на межі: невеликий зсув будь-якого показника змінює вердикт
    var near = false;
    if (found) {
      ['mold', 'unripe', 'debris'].forEach(function (k) {
        var m = Math.max(cf.margin, 0.15 * p[k]);
        [-m, m].forEach(function (d) {
          var q = { mold: p.mold, unripe: p.unripe, debris: p.debris };
          q[k] = Math.max(0, q[k] + d);
          if (BS.decide(q, vs).code !== verdict.code) near = true;
        });
      });
    }
    if (near) { issues.push({ code: 'near', penalty: 10, text: 'Результат близько до порога — вердикт може змінитись' }); score -= 10; }

    if (results.length > 1) {
      var molds = results.map(function (r) { return r.percents.mold; });
      var unr = results.map(function (r) { return r.percents.red + r.percents.green; });
      var spread = function (a) { return Math.max.apply(null, a) - Math.min.apply(null, a); };
      if (spread(molds) > 2 || spread(unr) > 5) { issues.push({ code: 'spread', penalty: 10, text: 'Фото партії помітно відрізняються між собою' }); score -= 10; }
    }

    score = Math.round(Math.max(5, Math.min(MAX_SCORE, score)));
    var level = score >= cf.high ? 'high' : score >= cf.low ? 'medium' : 'low';
    var minPhoto = perPhoto.length ? Math.min.apply(null, perPhoto.map(function (x) { return x.score; })) : 0;
    var needsReview = !found || score < cf.low || near || minPhoto < cf.low;

    return {
      percents: percents,
      unripe: p.unripe,
      moldSpots: spots,
      verdict: { code: verdict.code, label: BS.VERDICTS[verdict.code].label, reasons: verdict.reasons },
      confidence: { score: score, level: level, label: { high: 'висока', medium: 'середня', low: 'низька' }[level] },
      needsReview: needsReview,
      nearThreshold: near,
      issues: issues,
      perPhoto: perPhoto
    };
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BS;
})(typeof self !== 'undefined' ? self : globalThis);
