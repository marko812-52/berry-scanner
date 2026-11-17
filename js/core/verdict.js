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

  // Показники, за якими виноситься вердикт (усі — у відсотках площі ягід).
  var KEYS = [['mold', 'Mold', 'Пліснява'], ['unripe', 'Unripe', 'Недостиглі'], ['damaged', 'Damaged', 'Пошкоджені'], ['debris', 'Debris', 'Домішки']];
  BS.VERDICT_KEYS = KEYS.map(function (k) { return k[0]; });

  // p: { mold, unripe, damaged, debris } у відсотках. Пороги, яких немає в налаштуваннях (старі записи), не перевіряються.
  BS.decide = function (p, vs) {
    function lim(stage, k) { var v = vs[stage + k[1]]; return typeof v === 'number' ? v : Infinity; }
    function within(stage) { return KEYS.every(function (k) { return (p[k[0]] || 0) <= lim(stage, k); }); }
    function over(stage, name) {
      return KEYS.filter(function (k) { return (p[k[0]] || 0) > lim(stage, k); })
        .map(function (k) { return k[2] + ' ' + f(p[k[0]]) + ' — понад поріг ' + name + ' ' + f(lim(stage, k)); });
    }
    if (within('freeze')) return { code: 'freeze', reasons: ['Пліснява, недостиглі, пошкоджені та домішки — у межах порогів для заморожування'] };
    if (within('process')) return { code: 'process', reasons: over('freeze', 'заморожування') };
    return { code: 'reject', reasons: over('process', 'переробки') };
  };

  // Штрафи за умови зйомки одного фото.
  BS.photoConfidence = function (res) {
    var issues = [], q = res.quality;
    function add(code, penalty, text) { issues.push({ code: code, penalty: Math.round(penalty), text: text }); }
    var berry = res.berryFraction != null ? res.berryFraction : res.roiFraction;
    var prof = BS.PROFILES[res.profile || 'blackberry'] || BS.PROFILES.blackberry;
    if (berry < 0.05) {
      add('no-berries', 95, 'Не вдалося знайти ягоди на фото');
      return { score: 5, issues: issues };
    }
    if (!res.manualRoi && berry < 0.35) add('roi-small', Math.min(30, (0.35 - berry) * 120 + 6), 'Ягоди займають малу частину кадру (' + Math.round(berry * 100) + ' %) — знімайте ближче');
    var expo = q.medianV / (q.refV || 0.17);                          // 1 — типова яскравість ягід цього профілю
    if (expo < 0.42) add('dark', 20, 'Фото затемне');
    else if (expo > 2.6) add('bright', 20, 'Фото пересвічене або ягоди світлі');
    else if (q.gainClamped) add('exposure', 8, 'Незвична яскравість фото');
    if (res.otherFraction > 0.25) add('other', Math.min(15, 4 + (res.otherFraction - 0.25) * 40), 'У зоні багато фону (' + Math.round(res.otherFraction * 100) + ' %) — уточніть зону обведенням');
    if (res.fallback) add('fallback', 5, res.fallback);
    if (res.method === 'model' || res.method === 'hybrid') {
      if (res.modelConfidence < 0.6) add('model-unsure', Math.min(20, 6 + (0.6 - res.modelConfidence) * 60), 'Модель не впевнена в класах (середня ймовірність ' + Math.round(res.modelConfidence * 100) + ' %)');
      var dm = Math.abs((res.colorMold || 0) - (res.modelMold || 0));
      if (dm > Math.max(1.5, 0.5 * Math.max(res.colorMold || 0, res.modelMold || 0))) {
        add('disagree', 15, 'Кольоровий метод і модель розходяться щодо плісняви: ' + f(res.colorMold) + ' проти ' + f(res.modelMold));
      }
      if (res.speciesHint && BS.PROFILES[res.speciesHint]) add('species', 10, 'Схоже, на фото ' + BS.PROFILES[res.speciesHint].label.toLowerCase() + ', а вибрано профіль «' + prof.label + '» — перевірте вибір ягоди');
    }
    if (prof.experimental && res.method !== 'model') add('profile', 12, 'Профіль «' + prof.label + '» експериментальний: кольори підібрано без перевірки на реальних лотках');
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
    var total = 0, percents = {}, spots = 0, scoreSum = 0, otherSum = 0, issues = [], seen = {}, perPhoto = [];
    BS.CATEGORIES.forEach(function (c) { percents[c.key] = 0; });
    results.forEach(function (r) {
      var pc = BS.photoConfidence(r);
      perPhoto.push(pc);
      var wgt = Math.max(1, r.berryPx != null ? r.berryPx : r.roiPx), rp = BS.normalizePercents(r.percents);
      total += wgt; scoreSum += pc.score * wgt; spots += r.moldSpots || 0; otherSum += (r.otherFraction || 0) * wgt;
      BS.CATEGORIES.forEach(function (c) { percents[c.key] += rp[c.key] * wgt; });
      pc.issues.forEach(function (i) { if (!seen[i.code]) { seen[i.code] = 1; issues.push(i); } });
    });
    BS.CATEGORIES.forEach(function (c) { percents[c.key] = total ? percents[c.key] / total : 0; });
    var score = total ? scoreSum / total : 5;

    var found = results.some(function (r) { return (r.berryFraction != null ? r.berryFraction : r.roiFraction) >= 0.05; });
    var p = { mold: percents.mold, unripe: percents.unripe, damaged: percents.damaged, debris: percents.debris };
    var verdict = found ? BS.decide(p, vs) : { code: 'unknown', reasons: [] };

    // на межі: невеликий зсув будь-якого показника змінює вердикт
    var near = false;
    if (found) {
      BS.VERDICT_KEYS.forEach(function (k) {
        var m = Math.max(cf.margin, 0.15 * p[k]);
        [-m, m].forEach(function (d) {
          var q = { mold: p.mold, unripe: p.unripe, damaged: p.damaged, debris: p.debris };
          q[k] = Math.max(0, q[k] + d);
          if (BS.decide(q, vs).code !== verdict.code) near = true;
        });
      });
    }
    if (near) { issues.push({ code: 'near', penalty: 10, text: 'Результат близько до порога — вердикт може змінитись' }); score -= 10; }

    if (results.length > 1) {
      var molds = results.map(function (r) { return r.percents.mold; });
      var unr = results.map(function (r) { return BS.normalizePercents(r.percents).unripe; });
      var spread = function (a) { return Math.max.apply(null, a) - Math.min.apply(null, a); };
      if (spread(molds) > 2 || spread(unr) > 5) { issues.push({ code: 'spread', penalty: 10, text: 'Фото партії помітно відрізняються між собою' }); score -= 10; }
    }

    score = Math.round(Math.max(5, Math.min(MAX_SCORE, score)));
    var level = score >= cf.high ? 'high' : score >= cf.low ? 'medium' : 'low';
    var minPhoto = perPhoto.length ? Math.min.apply(null, perPhoto.map(function (x) { return x.score; })) : 0;
    // розбіжність кольору й моделі щодо плісняви або невпевнена модель — завжди до людини
    var flagged = issues.some(function (i) { return i.code === 'disagree' || i.code === 'model-unsure'; });
    var needsReview = !found || score < cf.low || near || minPhoto < cf.low || flagged;

    return {
      percents: percents,
      unripe: p.unripe,
      otherFraction: total ? otherSum / total : 0,
      photos: results.length,
      moldSpots: spots,
      verdict: { code: verdict.code, label: BS.VERDICTS[verdict.code].label, reasons: verdict.reasons },
      confidence: { score: score, level: level, label: { high: 'висока', medium: 'середня', low: 'низька' }[level] },
      needsReview: needsReview,
      nearThreshold: near,
      issues: issues,
      perPhoto: perPhoto
    };
  };

  // Зведення зі старого запису (v0: червоні й зелені окремо) → єдина таксономія. Нові записи не змінює.
  BS.normalizeEvaluation = function (ev) {
    if (!ev) return ev;
    var out = Object.assign({}, ev);
    out.percents = BS.normalizePercents(ev.percents);
    out.unripe = out.percents.unripe;
    if (out.otherFraction == null) out.otherFraction = 0;
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BS;
})(typeof self !== 'undefined' ? self : globalThis);
