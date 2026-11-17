/*
 * PDF-звіт (jsPDF, шрифт Noto Sans вбудований — стандартні шрифти PDF не мають кирилиці).
 * У підмножині шрифту немає знаків ≈ ≤ ≥ — у текстах звіту їх не вживаємо.
 */
(function () {
  'use strict';
  var BS = window.BS;
  var W = 210, H = 297, M = 14;
  var TONE = {
    freeze: { bg: [230, 244, 234], fg: [13, 92, 38] },
    process: { bg: [255, 244, 214], fg: [107, 63, 0] },
    reject: { bg: [252, 232, 230], fg: [140, 21, 18] },
    unknown: { bg: [236, 238, 240], fg: [60, 64, 67] }
  };
  function num(v) { return String(v).replace('.', ','); }

  BS.pdfFileName = function (batch) {
    var d = new Date(batch.createdAt), p = function (n) { return (n < 10 ? '0' : '') + n; };
    var tag = (batch.meta && batch.meta.batchNo || '').replace(/[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ_-]+/g, '_').slice(0, 30);
    return 'yahody-' + (tag ? tag + '-' : '') + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.pdf';
  };

  // images: [{ dataUrl, w, h }] — анотовані фото в тому ж порядку, що й batch.photos
  BS.buildPdf = function (batch, images) {
    var doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    doc.addFileToVFS('NotoSans-Regular.ttf', BS_FONTS.regular); doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
    doc.addFileToVFS('NotoSans-Bold.ttf', BS_FONTS.bold); doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');

    var ev = BS.normalizeEvaluation(batch.evaluation), y = 0;
    var pk = (batch.settings && batch.settings.profile) || 'blackberry', prof = BS.PROFILES[pk] || BS.PROFILES.blackberry;
    var first = batch.photos[0] && (batch.photos[0].result || batch.photos[0].summary) || {}, method = first.method || 'color';
    function font(size, bold, color) {
      doc.setFont('NotoSans', bold ? 'bold' : 'normal'); doc.setFontSize(size);
      var c = color || [29, 23, 34]; doc.setTextColor(c[0], c[1], c[2]);
    }
    function lines(text, width) { return doc.splitTextToSize(text, width); }
    function lh(size) { return size * 0.3528 * 1.32; }               // пункти → мм з міжряддям
    // Абзац із переносами; повертає y після нього.
    function para(text, x, yy, width, size, bold, color) {
      font(size, bold, color);
      var ls = lines(text, width);
      doc.text(ls, x, yy + size * 0.3528, { lineHeightFactor: 1.32 });
      return yy + ls.length * lh(size);
    }
    function measure(text, width, size, bold) { font(size, bold); return lines(text, width).length * lh(size); }
    function ensure(h) { if (y + h > H - 18) { doc.addPage(); y = 16; } }
    function box(h, bg, border) {
      doc.setFillColor(bg[0], bg[1], bg[2]);
      if (border) { doc.setDrawColor(border[0], border[1], border[2]); doc.setLineWidth(0.3); }
      doc.roundedRect(M, y, W - 2 * M, h, 3, 3, border ? 'FD' : 'F');
    }

    // --- шапка ---
    doc.setFillColor(74, 29, 94); doc.rect(0, 0, W, 27, 'F');
    font(17, true, [255, 255, 255]); doc.text('Візуальна оцінка партії: ' + prof.label.toLowerCase(), M, 12.5);
    font(9.5, false, [232, 220, 240]); doc.text('Орієнтовно, за видимою поверхнею на фото. Не є лабораторним висновком.', M, 20);
    font(10, true, [255, 255, 255]); doc.text(BS.fmtDate(batch.createdAt), W - M, 12.5, { align: 'right' });
    y = 33;

    // --- дані партії ---
    var meta = batch.meta || {}, pairs = [];
    if (meta.batchNo) pairs.push(['Партія', '№ ' + meta.batchNo]);
    if (meta.supplier) pairs.push(['Постачальник', meta.supplier]);
    if (meta.operator) pairs.push(['Оператор', meta.operator]);
    pairs.push(['Фото в партії', String(batch.photos.length)]);
    pairs.push(['Спосіб', BS.modeLabel(method).toLowerCase() + (first.modelVersion ? ' (' + first.modelVersion + ')' : '')]);
    var colW = (W - 2 * M) / 2;
    pairs.forEach(function (p, i) {
      var x = M + (i % 2) * colW, yy = y + Math.floor(i / 2) * 6;
      font(9.5, false, [106, 98, 114]); doc.text(p[0] + ':', x, yy + 3.5);
      font(9.5, true); doc.text(lines(p[1], colW - 32)[0], x + 28, yy + 3.5);
    });
    y += Math.ceil(pairs.length / 2) * 6 + 1;
    if (meta.note) y = para('Примітка: ' + meta.note, M, y, W - 2 * M, 9.5, false, [64, 56, 74]) + 1;
    y += 3;

    // --- фото + таблиця ---
    var im = images[0], top = y;
    var pw = 88, ph = pw * im.h / im.w;
    if (ph > 112) { ph = 112; pw = ph * im.w / im.h; }
    doc.addImage(im.dataUrl, 'JPEG', M, top, pw, ph, undefined, 'FAST');
    font(8, false, [106, 98, 114]);
    doc.text(batch.photos.length > 1 ? 'Фото 1 з ' + batch.photos.length + ' з позначеними категоріями' : 'Фото з позначеними категоріями', M, top + ph + 4);

    var tx = M + 88 + 8, tw = W - M - tx, ty = top;
    font(12, true); doc.text('Склад партії', tx, ty + 4.5); ty += 7;
    font(8.5, false, [106, 98, 114]); doc.text('частка площі ягід на фото, орієнтовно', tx, ty + 3); ty += 7;
    BS.CATEGORIES.forEach(function (c) {
      var v = ev.percents[c.key];
      doc.setFillColor(c.color[0], c.color[1], c.color[2]); doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.15);
      doc.roundedRect(tx, ty, 4.2, 4.2, 0.8, 0.8, 'FD');
      font(10.5, false); doc.text(BS.categoryLabel(c.key, pk), tx + 7, ty + 3.6);
      font(11, true); doc.text(BS.fmtPct(v) + ' %', tx + tw, ty + 3.6, { align: 'right' });
      doc.setFillColor(236, 232, 240); doc.roundedRect(tx, ty + 6, tw, 1.6, 0.8, 0.8, 'F');
      doc.setFillColor(c.color[0], c.color[1], c.color[2]);
      doc.roundedRect(tx, ty + 6, Math.max(0.8, tw * Math.min(100, v) / 100), 1.6, 0.8, 0.8, 'F');
      ty += 11;
    });
    ty += 1;
    ty = para('Знайдено плям плісняви: ' + ev.moldSpots, tx, ty, tw, 9.5, false);
    if (ev.otherFraction >= 0.0005) ty = para('Фон / інше в зоні: ' + BS.fmtPct(100 * ev.otherFraction) + ' % (у склад не входить)', tx, ty, tw, 9.5, false);
    if (method === 'color') ty = para('«Пошкоджені» кольоровий метод не визначає.', tx, ty, tw, 8.5, false, [106, 98, 114]);
    y = Math.max(top + ph + 6, ty) + 5;

    // --- вердикт ---
    var tone = TONE[ev.verdict.code] || TONE.unknown, inner = W - 2 * M - 10;
    var reasons = ev.verdict.reasons.map(function (r) { return '• ' + r; }).join('\n');
    var vh = 5 + 4.5 + measure(ev.verdict.label, inner, 15, true) + (reasons ? measure(reasons, inner, 9.5, false) + 1 : 0) + 4;
    ensure(vh + 4);
    box(vh, tone.bg);
    var yy = y + 4;
    font(8.5, true, tone.fg); doc.text('ВЕРДИКТ ЗА ДЕМО-ПОРОГАМИ', M + 5, yy + 3); yy += 4.5;
    yy = para(ev.verdict.label, M + 5, yy, inner, 15, true, tone.fg);
    if (reasons) para(reasons, M + 5, yy + 1, inner, 9.5, false, tone.fg);
    y += vh + 4;

    // --- позначка перевірки ---
    if (ev.needsReview) {
      ensure(13);
      box(9.5, [58, 42, 0]);
      font(11.5, true, [255, 216, 102]); doc.text('ПОТРІБНА ПЕРЕВІРКА ЛЮДИНОЮ', M + 5, y + 6.4);
      y += 13;
    }

    // --- впевненість ---
    var issues = ev.issues.length ? ev.issues.map(function (i) { return '• ' + i.text; }).join('\n') : 'Зауважень до фото немає.';
    ensure(8 + measure(issues, W - 2 * M, 9.5, false));
    font(11.5, true); doc.text('Впевненість: ' + ev.confidence.label + ' (' + ev.confidence.score + ' зі 100)', M, y + 4.2);
    var mx = M + 78, mw = W - M - mx, mc = { high: [30, 142, 62], medium: [224, 161, 0], low: [197, 34, 31] }[ev.confidence.level];
    doc.setFillColor(236, 232, 240); doc.roundedRect(mx, y + 1.6, mw, 3, 1.5, 1.5, 'F');
    doc.setFillColor(mc[0], mc[1], mc[2]); doc.roundedRect(mx, y + 1.6, Math.max(3, mw * ev.confidence.score / 100), 3, 1.5, 1.5, 'F');
    y = para(issues, M, y + 7.5, W - 2 * M, 9.5, false, [64, 56, 74]) + 4;

    // --- виправлення оператора ---
    if (batch.correction) {
      var c = batch.correction, hp = BS.normalizePercents(c.percents);
      var txt = 'Вердикт сортувальника: ' + BS.VERDICTS[c.verdict].label + '\n' +
        'Частки (людина / програма): ' + BS.CATEGORIES.map(function (k) { return k.label.toLowerCase() + ' ' + BS.fmtPct(hp[k.key]) + ' / ' + BS.fmtPct(ev.percents[k.key]) + ' %'; }).join('; ') +
        (c.comment ? '\nКоментар: ' + c.comment : '');
      var ch = 5 + 5.5 + measure(txt, inner, 9.5, false) + 3.5;
      ensure(ch + 4);
      box(ch, [244, 236, 248], [107, 45, 134]);
      font(10.5, true, [74, 29, 94]); doc.text('Оцінка сортувальника, ' + BS.fmtDate(c.at), M + 5, y + 7);
      para(txt, M + 5, y + 10.5, inner, 9.5, false);
      y += ch + 4;
    }

    // --- пороги ---
    var v = batch.settings.verdict;
    var thr = 'Пороги (демо-значення, уточнити з технологом). Заморожування після сортування: пліснява до ' + num(v.freezeMold) +
      ' %, недостиглі до ' + num(v.freezeUnripe) + ' %' + (v.freezeDamaged != null ? ', пошкоджені до ' + num(v.freezeDamaged) + ' %' : '') + ', домішки до ' + num(v.freezeDebris) + ' %. Переробка: пліснява до ' + num(v.processMold) +
      ' %, недостиглі до ' + num(v.processUnripe) + ' %' + (v.processDamaged != null ? ', пошкоджені до ' + num(v.processDamaged) + ' %' : '') + ', домішки до ' + num(v.processDebris) + ' %. Вище — відхилити.';
    ensure(measure(thr, W - 2 * M, 8.5, false) + 2);
    y = para(thr, M, y, W - 2 * M, 8.5, false, [106, 98, 114]) + 2;
    var how = 'Як рахується: програма виділяє на фото зону ягід і відносить кожну ділянку до категорії (' + (method === 'color' ? 'за кольором' : method === 'model' ? 'навченою моделлю' : 'за кольором, з перевіркою навченою моделлю') +
      '). Відсоток — це частка площі видимого верхнього шару ягід, а не маси чи кількості. Пліснява — нижня оцінка: тонкий сірий наліт програма не відрізняє від відблиску.' +
      (prof.experimental ? ' Профіль «' + prof.label + '» експериментальний.' : '');
    ensure(measure(how, W - 2 * M, 8.5, false));
    y = para(how, M, y, W - 2 * M, 8.5, false, [106, 98, 114]);

    // --- усі фото партії ---
    if (images.length > 1) {
      doc.addPage(); y = 16;
      font(13, true); doc.text('Усі фото партії', M, y + 4); y += 10;
      var cw = (W - 2 * M - 8) / 2, chMax = 112, col = 0, rowH = 0;
      images.forEach(function (g, i) {
        var w = cw, h = w * g.h / g.w;
        if (h > chMax) { h = chMax; w = h * g.w / g.h; }
        if (col === 0 && y + h + 14 > H - 18) { doc.addPage(); y = 16; }
        var x = M + col * (cw + 8);
        doc.addImage(g.dataUrl, 'JPEG', x, y, w, h, undefined, 'FAST');
        var s = batch.photos[i].result || batch.photos[i].summary, p = BS.normalizePercents(s.percents);
        para('Фото ' + (i + 1) + ': пліснява ' + BS.fmtPct(p.mold) + ' %, недостиглі ' + BS.fmtPct(p.unripe) + ' %, домішки ' + BS.fmtPct(p.debris) + ' %',
          x, y + h + 1.5, cw, 8.5, false, [64, 56, 74]);
        rowH = Math.max(rowH, h + 12);
        if (++col === 2 || i === images.length - 1) { col = 0; y += rowH + 4; rowH = 0; }
      });
    }

    // --- нижній колонтитул ---
    var pages = doc.getNumberOfPages();
    for (var n = 1; n <= pages; n++) {
      doc.setPage(n);
      font(8, false, [140, 132, 148]);
      doc.text('Сканер ягід ' + BS.APP_VERSION + ' · алгоритм ' + (batch.algo || BS.ALGO_VERSION) + ' · фото оброблено на пристрої', M, H - 8);
      doc.text('Сторінка ' + n + ' з ' + pages, W - M, H - 8, { align: 'right' });
    }
    return doc;
  };

  // PDF аналітики: фільтри, підсумки, графік, «програма vs людина», таблиця партій.
  // data: { rows, cmp, filters, chart: { dataUrl, w, h } } — див. js/ui/stats.js
  BS.buildStatsPdf = function (data) {
    var doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    doc.addFileToVFS('NotoSans-Regular.ttf', BS_FONTS.regular); doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
    doc.addFileToVFS('NotoSans-Bold.ttf', BS_FONTS.bold); doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');
    function font(size, bold, color) { doc.setFont('NotoSans', bold ? 'bold' : 'normal'); doc.setFontSize(size); var c = color || [29, 23, 34]; doc.setTextColor(c[0], c[1], c[2]); }
    function p1(v) { return v == null || !isFinite(v) ? '—' : BS.fmtPct(v); }
    var rows = data.rows, y;
    doc.setFillColor(74, 29, 94); doc.rect(0, 0, W, 22, 'F');
    font(16, true, [255, 255, 255]); doc.text('Аналітика партій', M, 11);
    font(9, false, [232, 220, 240]); doc.text('Фільтр: ' + data.filters + ' · партій: ' + rows.length, M, 17.5);
    font(9, true, [255, 255, 255]); doc.text(BS.fmtDate(Date.now()), W - M, 11, { align: 'right' });
    y = 30;
    var mean = function (a) { return a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; };
    var rej = rows.filter(function (r) { return r.verdict === 'reject'; }).length;
    var tiles = [['Партій', String(rows.length)], ['Пліснява, середня', p1(mean(rows.map(function (r) { return r.p.mold; }))) + ' %'],
      ['Недостиглі, середня', p1(mean(rows.map(function (r) { return r.p.unripe; }))) + ' %'], ['Відхилено', p1(rows.length ? 100 * rej / rows.length : 0) + ' %']];
    var tw = (W - 2 * M - 9) / 4;
    tiles.forEach(function (t, i) {
      var x = M + i * (tw + 3);
      doc.setFillColor(245, 242, 247); doc.roundedRect(x, y, tw, 16, 2, 2, 'F');
      font(8, false, [106, 98, 114]); doc.text(t[0], x + 3, y + 5);
      font(13, true); doc.text(t[1], x + 3, y + 12.5);
    });
    y += 21;
    font(11, true); doc.text('Тренд по партіях', M, y + 4); y += 6;
    var cw = W - 2 * M, ch = cw * data.chart.h / data.chart.w;
    doc.addImage(data.chart.dataUrl, 'PNG', M, y, cw, ch, undefined, 'FAST'); y += ch + 2;
    font(8, false, [106, 98, 114]); doc.text('Червона — пліснява, жовта — недостиглі, помаранчева — пошкоджені; пунктир — поріг плісняви для заморожування.', M, y + 3); y += 8;

    var c = data.cmp;
    font(11, true); doc.text('Програма проти сортувальника', M, y + 4); y += 7;
    if (!c.n) { font(9.5, false, [64, 56, 74]); doc.text('Партій з оцінкою людини немає.', M, y + 3.5); y += 8; }
    else {
      font(9.5, false, [64, 56, 74]);
      var lines = ['Партій з оцінкою людини: ' + c.n + '. Вердикт збігся: ' + p1(100 * c.verdictAgree) + ' %.',
        'Пропущена пліснява (людина бачить щонайменше на 0,5 п.п. більше): ' + p1(100 * c.moldMissedShare) + ' % партій, у середньому ' + p1(c.moldMissedMean) + ' п.п., найбільше ' + p1(c.moldMissedMax) + ' п.п.',
        'Середня похибка |програма − людина|, п.п.: ' + BS.CATEGORIES.map(function (k) { return k.label.toLowerCase() + ' ' + p1(c.mae[k.key]); }).join('; ') + '.'];
      lines.forEach(function (t) { var ls = doc.splitTextToSize(t, W - 2 * M); doc.text(ls, M, y + 3.5); y += ls.length * 4.6 + 1; });
      y += 2;
    }

    font(11, true); doc.text('Партії', M, y + 4); y += 7;
    var cols = [['Дата', 30], ['Постачальник', 38], ['№', 18], ['Вердикт', 34], ['Пліснява', 16], ['Недост.', 15], ['Пошк.', 13], ['Дом.', 12], ['Людина: плісн.', 16]];
    function header() {
      doc.setFillColor(236, 232, 240); doc.rect(M, y, W - 2 * M, 6, 'F');
      font(7.5, true); var x = M + 1;
      cols.forEach(function (cdef) { doc.text(cdef[0], x, y + 4.2); x += cdef[1]; });
      y += 7;
    }
    header();
    rows.slice().reverse().forEach(function (r) {
      if (y > H - 20) { doc.addPage(); y = 16; header(); }
      font(7.5, false);
      var vals = [r.date, r.supplier || '—', r.batchNo || '—', BS.VERDICTS[r.verdict].short, p1(r.p.mold), p1(r.p.unripe), p1(r.p.damaged), p1(r.p.debris), r.human ? p1(r.human.mold) : '—'];
      var x = M + 1;
      vals.forEach(function (v, i) { doc.text(doc.splitTextToSize(String(v), cols[i][1] - 1.5)[0], x, y + 3.2); x += cols[i][1]; });
      doc.setDrawColor(236, 232, 240); doc.setLineWidth(0.2); doc.line(M, y + 4.8, W - M, y + 4.8);
      y += 5.4;
    });
    var pages = doc.getNumberOfPages();
    for (var n = 1; n <= pages; n++) {
      doc.setPage(n); font(8, false, [140, 132, 148]);
      doc.text('Сканер ягід ' + BS.APP_VERSION + ' · частки — площа ягід на фото, орієнтовно; пороги — демо-значення', M, H - 8);
      doc.text('Сторінка ' + n + ' з ' + pages, W - M, H - 8, { align: 'right' });
    }
    return doc;
  };
})();
