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
    return 'ozhyna-' + (tag ? tag + '-' : '') + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + '.pdf';
  };

  // images: [{ dataUrl, w, h }] — анотовані фото в тому ж порядку, що й batch.photos
  BS.buildPdf = function (batch, images) {
    var doc = new jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    doc.addFileToVFS('NotoSans-Regular.ttf', BS_FONTS.regular); doc.addFont('NotoSans-Regular.ttf', 'NotoSans', 'normal');
    doc.addFileToVFS('NotoSans-Bold.ttf', BS_FONTS.bold); doc.addFont('NotoSans-Bold.ttf', 'NotoSans', 'bold');

    var ev = batch.evaluation, y = 0;
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
    font(17, true, [255, 255, 255]); doc.text('Візуальна оцінка партії ожини', M, 12.5);
    font(9.5, false, [232, 220, 240]); doc.text('Орієнтовно, за видимою поверхнею на фото. Не є лабораторним висновком.', M, 20);
    font(10, true, [255, 255, 255]); doc.text(BS.fmtDate(batch.createdAt), W - M, 12.5, { align: 'right' });
    y = 33;

    // --- дані партії ---
    var meta = batch.meta || {}, pairs = [];
    if (meta.batchNo) pairs.push(['Партія', '№ ' + meta.batchNo]);
    if (meta.supplier) pairs.push(['Постачальник', meta.supplier]);
    if (meta.operator) pairs.push(['Оператор', meta.operator]);
    pairs.push(['Фото в партії', String(batch.photos.length)]);
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
    if (ph > 116) { ph = 116; pw = ph * im.w / im.h; }
    doc.addImage(im.dataUrl, 'JPEG', M, top, pw, ph, undefined, 'FAST');
    font(8, false, [106, 98, 114]);
    doc.text(batch.photos.length > 1 ? 'Фото 1 з ' + batch.photos.length + ' з позначеними категоріями' : 'Фото з позначеними категоріями', M, top + ph + 4);

    var tx = M + 88 + 8, tw = W - M - tx, ty = top;
    font(12, true); doc.text('Склад партії', tx, ty + 4.5); ty += 7;
    font(8.5, false, [106, 98, 114]); doc.text('частка площі на фото, орієнтовно', tx, ty + 3); ty += 7;
    BS.CATEGORIES.forEach(function (c) {
      var v = ev.percents[c.key];
      doc.setFillColor(c.color[0], c.color[1], c.color[2]); doc.setDrawColor(150, 150, 150); doc.setLineWidth(0.15);
      doc.roundedRect(tx, ty, 4.2, 4.2, 0.8, 0.8, 'FD');
      font(10.5, false); doc.text(c.label, tx + 7, ty + 3.6);
      font(11, true); doc.text(BS.fmtPct(v) + ' %', tx + tw, ty + 3.6, { align: 'right' });
      doc.setFillColor(236, 232, 240); doc.roundedRect(tx, ty + 6, tw, 1.6, 0.8, 0.8, 'F');
      doc.setFillColor(c.color[0], c.color[1], c.color[2]);
      doc.roundedRect(tx, ty + 6, Math.max(0.8, tw * Math.min(100, v) / 100), 1.6, 0.8, 0.8, 'F');
      ty += 12;
    });
    ty += 1;
    ty = para('Недостиглі разом (червоні + зелені): ' + BS.fmtPct(ev.unripe) + ' %', tx, ty, tw, 9.5, false);
    ty = para('Знайдено плям плісняви: ' + ev.moldSpots, tx, ty, tw, 9.5, false);
    ty = para('Пліснява — нижня оцінка: тонкий сірий наліт програма не відрізняє від відблиску.', tx, ty + 1.5, tw, 8.5, false, [106, 98, 114]);
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
      var c = batch.correction;
      var txt = 'Вердикт оператора: ' + BS.VERDICTS[c.verdict].label + '\n' +
        'Частки: ' + BS.CATEGORIES.map(function (k) { return k.label.toLowerCase() + ' ' + BS.fmtPct(c.percents[k.key]) + ' %'; }).join('; ') +
        (c.comment ? '\nКоментар: ' + c.comment : '');
      var ch = 5 + 5.5 + measure(txt, inner, 9.5, false) + 3.5;
      ensure(ch + 4);
      box(ch, [244, 236, 248], [107, 45, 134]);
      font(10.5, true, [74, 29, 94]); doc.text('Виправлено оператором, ' + BS.fmtDate(c.at), M + 5, y + 7);
      para(txt, M + 5, y + 10.5, inner, 9.5, false);
      y += ch + 4;
    }

    // --- пороги ---
    var v = batch.settings.verdict;
    var thr = 'Пороги (демо-значення, уточнити з технологом). Заморожування після сортування: пліснява до ' + num(v.freezeMold) +
      ' %, недостиглі до ' + num(v.freezeUnripe) + ' %, домішки до ' + num(v.freezeDebris) + ' %. Переробка: пліснява до ' + num(v.processMold) +
      ' %, недостиглі до ' + num(v.processUnripe) + ' %, домішки до ' + num(v.processDebris) + ' %. Вище — відхилити.';
    ensure(measure(thr, W - 2 * M, 8.5, false) + 2);
    y = para(thr, M, y, W - 2 * M, 8.5, false, [106, 98, 114]) + 2;
    var how = 'Як рахується: програма виділяє на фото зону ягід і за кольором відносить кожну ділянку до категорії. Відсоток — це частка площі видимого верхнього шару, а не маси чи кількості ягід.';
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
        var s = batch.photos[i].result || batch.photos[i].summary, p = s.percents;
        para('Фото ' + (i + 1) + ': пліснява ' + BS.fmtPct(p.mold) + ' %, недостиглі ' + BS.fmtPct(p.red + p.green) + ' %, домішки ' + BS.fmtPct(p.debris) + ' %',
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
      doc.text('Сканер ожини ' + BS.APP_VERSION + ' · алгоритм ' + (batch.algo || BS.ALGO_VERSION) + ' · фото оброблено на пристрої', M, H - 8);
      doc.text('Сторінка ' + n + ' з ' + pages, W - M, H - 8, { align: 'right' });
    }
    return doc;
  };
})();
