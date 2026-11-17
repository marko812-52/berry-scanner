/* Екран «Аналітика»: фільтри, підсумки, тренди, «програма vs людина», експорт CSV / Excel / PDF. */
(function () {
  'use strict';
  const BS = window.BS, ui = BS.ui, $ = ui.$, el = ui.el;
  const KEYS = BS.CATEGORIES.map((c) => c.key);
  let all = [], rows = [];
  const filt = { supplier: '', profile: '', from: '', to: '' };

  const pct = (v) => (v == null || !isFinite(v) ? '—' : BS.fmtPct(v) + ' %');
  const pp = (v) => (v == null || !isFinite(v) ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + BS.fmtPct(Math.abs(v)) + ' п.п.');
  const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
  const dayStart = (s) => (s ? new Date(s + 'T00:00:00').getTime() : null);
  const dayEnd = (s) => (s ? new Date(s + 'T23:59:59.999').getTime() : null);

  // Рядок аналітики з запису історії.
  function rowOf(rec) {
    const ev = BS.normalizeEvaluation(rec.evaluation);
    const human = rec.correction ? BS.normalizePercents(rec.correction.percents) : null;
    return {
      id: rec.id, at: rec.createdAt, date: BS.fmtDate(rec.createdAt),
      supplier: (rec.meta && rec.meta.supplier) || '', batchNo: (rec.meta && rec.meta.batchNo) || '', operator: (rec.meta && rec.meta.operator) || '',
      profile: (rec.settings && rec.settings.profile) || 'blackberry', mode: (rec.photos && rec.photos[0] && rec.photos[0].summary && rec.photos[0].summary.method) || 'color',
      photos: (rec.photos || []).length, verdict: ev.verdict.code, confidence: ev.confidence.score, review: !!ev.needsReview,
      p: ev.percents, human, humanVerdict: rec.correction ? rec.correction.verdict : null
    };
  }

  // Похибка програми відносно людини (лише партії з оцінкою сортувальника).
  BS.compareStats = function (list) {
    const pairs = list.filter((r) => r.human);
    const out = { n: pairs.length, mae: {}, bias: {}, verdictAgree: null, moldMissedShare: null, moldMissedMean: null, moldMissedMax: null };
    if (!pairs.length) return out;
    KEYS.forEach((k) => {
      const d = pairs.map((r) => r.p[k] - r.human[k]);
      out.mae[k] = mean(d.map(Math.abs));
      out.bias[k] = mean(d);
    });
    const miss = pairs.map((r) => r.human.mold - r.p.mold);                  // > 0 — програма недорахувала плісняву
    const missed = miss.filter((v) => v >= 0.5);
    out.moldMissedShare = missed.length / pairs.length;
    out.moldMissedMean = missed.length ? mean(missed) : 0;
    out.moldMissedMax = Math.max(0, ...miss);
    out.verdictAgree = pairs.filter((r) => r.verdict === r.humanVerdict).length / pairs.length;
    out.moldUnderVerdict = pairs.filter((r) => ({ freeze: 0, process: 1, reject: 2 })[r.verdict] < ({ freeze: 0, process: 1, reject: 2 })[r.humanVerdict]).length / pairs.length;
    return out;
  };

  function applyFilters() {
    const f = dayStart(filt.from), t = dayEnd(filt.to);
    rows = all.filter((r) => (!filt.supplier || r.supplier === filt.supplier) && (!filt.profile || r.profile === filt.profile) &&
      (f == null || r.at >= f) && (t == null || r.at <= t)).sort((a, b) => a.at - b.at);
  }

  async function refresh() {
    try { all = (await BS.db.listBatches()).map(rowOf); }
    catch (e) { $('stats-body').textContent = 'Історія недоступна в цьому браузері.'; return; }
    renderFilters(); applyFilters(); render();
  }
  ui.onShow.stats = refresh;

  function renderFilters() {
    const box = $('stats-filters'); box.textContent = '';
    const suppliers = [...new Set(all.map((r) => r.supplier).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
    if (filt.supplier && !suppliers.includes(filt.supplier)) filt.supplier = '';
    const select = (label, key, options) => {
      const s = el('select', { 'aria-label': label }, options.map(([v, t]) => el('option', { value: v, text: t, selected: filt[key] === v })));
      s.addEventListener('change', () => { filt[key] = s.value; applyFilters(); render(); });
      return el('label', { class: 'field' }, label, s);
    };
    const date = (label, key) => {
      const i = el('input', { type: 'date', value: filt[key] });
      i.addEventListener('change', () => { filt[key] = i.value; applyFilters(); render(); });
      return el('label', { class: 'field' }, label, i);
    };
    box.append(el('div', { class: 'set-grid' },
      select('Постачальник', 'supplier', [['', 'Усі постачальники']].concat(suppliers.map((s) => [s, s]))),
      select('Ягода', 'profile', [['', 'Усі ягоди']].concat(BS.PROFILE_KEYS.map((k) => [k, BS.PROFILES[k].label]))),
      date('Від дати', 'from'), date('До дати', 'to')),
    el('button', { type: 'button', class: 'btn-text', text: 'Скинути фільтри', onclick: () => { Object.keys(filt).forEach((k) => { filt[k] = ''; }); renderFilters(); applyFilters(); render(); } }));
  }

  function tile(label, value, note) {
    return el('div', { class: 'tile' }, el('div', { class: 'tl', text: label }), el('div', { class: 'tv', text: value }), note ? el('div', { class: 'tn', text: note }) : null);
  }

  function render() {
    const body = $('stats-body'); body.textContent = '';
    ['stats-csv', 'stats-xlsx', 'stats-pdf'].forEach((id) => { $(id).disabled = !rows.length; });
    if (!rows.length) { body.append(el('div', { class: 'card empty', text: all.length ? 'За цими фільтрами партій немає.' : 'Тут з’явиться аналітика, коли будуть оцінені партії.' })); return; }
    const verdicts = { freeze: 0, process: 0, reject: 0, unknown: 0 };
    rows.forEach((r) => { verdicts[r.verdict] = (verdicts[r.verdict] || 0) + 1; });
    const cmp = BS.compareStats(rows);

    body.append(el('div', { class: 'tiles' },
      tile('Партій', String(rows.length), rows.length > 1 ? rows[0].date.slice(0, 10) + ' – ' + rows[rows.length - 1].date.slice(0, 10) : rows[0].date.slice(0, 10)),
      tile('Пліснява, середня', pct(mean(rows.map((r) => r.p.mold))), 'макс. ' + pct(Math.max(...rows.map((r) => r.p.mold)))),
      tile('Недостиглі, середня', pct(mean(rows.map((r) => r.p.unripe)))),
      tile('Відхилено', pct(100 * verdicts.reject / rows.length), verdicts.reject + ' з ' + rows.length),
      tile('Потрібна перевірка', pct(100 * rows.filter((r) => r.review).length / rows.length))));

    // тренд
    const cv = el('canvas', { class: 'chart', 'aria-label': 'Графік плісняви й недостиглих за партіями' });
    body.append(el('div', { class: 'card' }, el('h3', { text: 'Тренд по партіях' }),
      el('p', { class: 'muted', text: 'Кожна точка — партія, у порядку дат. Пунктир — поріг плісняви для заморожування з поточних налаштувань.' }),
      cv, el('div', { class: 'legend' }, el('span', { class: 'lg mold', text: 'Пліснява' }), el('span', { class: 'lg unripe', text: 'Недостиглі' }), rows.some((r) => r.p.damaged > 0) ? el('span', { class: 'lg damaged', text: 'Пошкоджені' }) : null)));
    requestAnimationFrame(() => drawTrend(cv, rows, cv.clientWidth || 600, 220));

    // вердикти
    body.append(el('div', { class: 'card' }, el('h3', { text: 'Вердикти' }),
      el('div', { class: 'vbar' }, ['freeze', 'process', 'reject', 'unknown'].filter((k) => verdicts[k]).map((k) =>
        el('span', { class: 'v-' + k, style: 'flex:' + verdicts[k], title: BS.VERDICTS[k].short, text: verdicts[k] }))),
      el('div', { class: 'legend' }, ['freeze', 'process', 'reject'].map((k) => el('span', { class: 'lg v-' + k, text: BS.VERDICTS[k].short + ': ' + verdicts[k] })))));

    // програма vs людина
    const cmpCard = el('div', { class: 'card' }, el('h3', { text: 'Програма проти сортувальника' }));
    if (!cmp.n) cmpCard.append(el('p', { class: 'muted', text: 'Пар ще немає. Відкрийте партію і натисніть «Оцінка сортувальника», щоб ввести оцінку людини для тих самих фото.' }));
    else {
      cmpCard.append(el('p', { class: 'muted', text: 'Партій з оцінкою людини: ' + cmp.n + '. Середня похибка — середнє |програма − людина|; зсув > 0 — програма завищує, < 0 — занижує.' }),
        el('div', { class: 'cmp' }, el('span', { class: 'h' }), el('span', { class: 'h', text: 'Похибка' }), el('span', { class: 'h', text: 'Зсув' }), el('span', { class: 'h' }),
          KEYS.map((k) => [el('span', { class: 'n', text: BS.categoryLabel(k) }), el('span', { text: BS.fmtPct(cmp.mae[k]) + ' п.п.' }), el('span', { class: 'd' + (k === 'mold' && cmp.bias[k] < -0.25 ? ' miss' : ''), text: pp(cmp.bias[k]) }), el('span')])),
        el('ul', { class: 'issues' },
          el('li', { text: 'Пропущена пліснява (людина бачить щонайменше на 0,5 п.п. більше): ' + pct(100 * cmp.moldMissedShare) + ' партій, у середньому ' + BS.fmtPct(cmp.moldMissedMean) + ' п.п., найбільше ' + BS.fmtPct(cmp.moldMissedMax) + ' п.п.' }),
          el('li', { text: 'Вердикт збігся: ' + pct(100 * cmp.verdictAgree) + '; програма м’якша за людину: ' + pct(100 * cmp.moldUnderVerdict) + ' партій.' })));
    }
    body.append(cmpCard);

    // таблиця
    const head = ['Дата', 'Постачальник', '№', 'Вердикт', 'Пліснява', 'Недостиглі', 'Пошкоджені', 'Домішки', 'Людина: пліснява'];
    body.append(el('div', { class: 'card' }, el('h3', { text: 'Партії' }), el('div', { class: 'tbl-wrap' }, el('table', { class: 'tbl' },
      el('thead', null, el('tr', null, head.map((h) => el('th', { text: h })))),
      el('tbody', null, rows.slice().reverse().map((r) => el('tr', null,
        el('td', { text: r.date }), el('td', { text: r.supplier || '—' }), el('td', { text: r.batchNo || '—' }),
        el('td', null, el('span', { class: 'chip chip-' + r.verdict, text: BS.VERDICTS[r.verdict].short })),
        el('td', { text: pct(r.p.mold) }), el('td', { text: pct(r.p.unripe) }), el('td', { text: pct(r.p.damaged) }), el('td', { text: pct(r.p.debris) }),
        el('td', { text: r.human ? pct(r.human.mold) : '—' }))))))));
  }

  // Графік на canvas (той самий малюнок іде в PDF).
  function drawTrend(cv, list, cssW, cssH) {
    const dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(cssW * dpr); cv.height = Math.round(cssH * dpr); cv.style.height = cssH + 'px';
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#fff'; g.fillRect(0, 0, cssW, cssH);
    const L = 40, R = 10, T = 10, B = 26, W = cssW - L - R, H = cssH - T - B;
    const series = [['mold', '#d93025'], ['unripe', '#c79200'], ['damaged', '#e67300']];
    const thr = ui.settings.verdict.freezeMold;
    let ymax = Math.max(thr * 1.5, ...list.map((r) => Math.max(r.p.mold, r.p.unripe, r.p.damaged)));
    ymax = Math.max(2, Math.ceil(ymax / 2) * 2);
    g.font = '11px system-ui, sans-serif'; g.fillStyle = '#6a6272'; g.strokeStyle = '#e4dfe9'; g.lineWidth = 1;
    for (let k = 0; k <= 4; k++) {
      const v = ymax * k / 4, y = T + H - H * v / ymax;
      g.beginPath(); g.moveTo(L, y); g.lineTo(L + W, y); g.stroke();
      g.textAlign = 'right'; g.fillText(BS.fmtPct(v).replace(',0', '') + ' %', L - 4, y + 4);
    }
    const xOf = (i) => L + (list.length === 1 ? W / 2 : W * i / (list.length - 1));
    [0, Math.floor((list.length - 1) / 2), list.length - 1].filter((v, i, a) => a.indexOf(v) === i).forEach((i) => {
      g.textAlign = list.length === 1 ? 'center' : i === 0 ? 'left' : i === list.length - 1 ? 'right' : 'center';
      g.fillText(list[i].date.slice(0, 5), xOf(i) + (g.textAlign === 'left' ? -4 : g.textAlign === 'right' ? 4 : 0), cssH - 8);
    });
    g.setLineDash([5, 4]); g.strokeStyle = '#d93025'; g.globalAlpha = 0.5;
    const ty = T + H - H * thr / ymax; g.beginPath(); g.moveTo(L, ty); g.lineTo(L + W, ty); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    series.forEach(([k, col]) => {
      if (k === 'damaged' && !list.some((r) => r.p.damaged > 0)) return;
      g.strokeStyle = col; g.fillStyle = col; g.lineWidth = 2; g.beginPath();
      list.forEach((r, i) => { const x = xOf(i), y = T + H - H * r.p[k] / ymax; if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      g.stroke();
      list.forEach((r, i) => { g.beginPath(); g.arc(xOf(i), T + H - H * r.p[k] / ymax, 3, 0, 7); g.fill(); });
    });
  }

  // ---------- експорт ----------
  const COLS = [
    ['Дата', (r) => r.date], ['Постачальник', (r) => r.supplier], ['Номер партії', (r) => r.batchNo], ['Оператор', (r) => r.operator],
    ['Ягода', (r) => BS.PROFILES[r.profile].label], ['Спосіб', (r) => BS.modeLabel(r.mode)], ['Фото', (r) => r.photos],
    ['Вердикт', (r) => BS.VERDICTS[r.verdict].short], ['Впевненість', (r) => r.confidence], ['Потрібна перевірка', (r) => (r.review ? 'так' : 'ні')]
  ].concat(KEYS.map((k) => [BS.categoryLabel(k) + ', %', (r) => BS.round1(r.p[k])]))
    .concat(KEYS.map((k) => ['Людина: ' + BS.categoryLabel(k).toLowerCase() + ', %', (r) => (r.human ? BS.round1(r.human[k]) : '')]))
    .concat([['Людина: вердикт', (r) => (r.humanVerdict ? BS.VERDICTS[r.humanVerdict].short : '')]]);

  // CSV для Excel з українськими налаштуваннями: роздільник «;», десяткова кома, UTF-8 з BOM.
  BS.statsCsv = function (list) {
    const cell = (v) => { const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v == null ? '' : v); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    return '﻿' + [COLS.map((c) => cell(c[0])).join(';')].concat(list.map((r) => COLS.map((c) => cell(c[1](r))).join(';'))).join('\r\n');
  };

  // Мінімальний файл Excel (.xlsx): один аркуш, числа — числами, текст — рядками.
  BS.statsXlsx = function (list) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const colName = (i) => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
    const cell = (v, ref) => (typeof v === 'number' && isFinite(v) ? '<c r="' + ref + '"><v>' + v + '</v></c>'
      : v === '' || v == null ? '' : '<c r="' + ref + '" t="inlineStr"><is><t>' + esc(v) + '</t></is></c>');
    const all = [COLS.map((c) => c[0])].concat(list.map((r) => COLS.map((c) => c[1](r))));
    const sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
      '<cols><col min="1" max="1" width="17" customWidth="1"/><col min="2" max="' + COLS.length + '" width="14" customWidth="1"/></cols><sheetData>' +
      all.map((row, ri) => '<row r="' + (ri + 1) + '">' + row.map((v, ci) => cell(v, colName(ci) + (ri + 1))).join('') + '</row>').join('') +
      '</sheetData></worksheet>';
    const u = fflate.strToU8;
    return fflate.zipSync({
      '[Content_Types].xml': u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>'),
      '_rels/.rels': u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
      'xl/workbook.xml': u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Партії" sheetId="1" r:id="rId1"/></sheets></workbook>'),
      'xl/_rels/workbook.xml.rels': u('<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>'),
      'xl/worksheets/sheet1.xml': u(sheet)
    });
  };

  function filterText() {
    const p = [];
    if (filt.supplier) p.push('постачальник: ' + filt.supplier);
    if (filt.profile) p.push('ягода: ' + BS.PROFILES[filt.profile].label.toLowerCase());
    if (filt.from || filt.to) p.push('дати: ' + (filt.from || '…') + ' – ' + (filt.to || '…'));
    return p.length ? p.join('; ') : 'усі партії';
  }

  ui.statsPdfBlob = () => {
    const cv = document.createElement('canvas');
    drawTrend(cv, rows, 900, 300);
    return BS.buildStatsPdf({ rows, cmp: BS.compareStats(rows), filters: filterText(), chart: { dataUrl: cv.toDataURL('image/png'), w: 900, h: 300 } }).output('blob');
  };

  $('stats-csv').addEventListener('click', () => { ui.download(new Blob([BS.statsCsv(rows)], { type: 'text/csv;charset=utf-8' }), 'analityka-' + ui.stamp() + '.csv'); });
  $('stats-xlsx').addEventListener('click', () => { ui.download(new Blob([BS.statsXlsx(rows)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'analityka-' + ui.stamp() + '.xlsx'); });
  $('stats-pdf').addEventListener('click', async () => {
    ui.busy('Готую PDF…'); await ui.tick();
    try { ui.download(ui.statsPdfBlob(), 'analityka-' + ui.stamp() + '.pdf'); } catch (e) { console.error(e); ui.toast('Не вдалося створити PDF'); }
    ui.busy(false);
  });
  window.addEventListener('resize', () => { const cv = document.querySelector('#stats-body canvas.chart'); if (cv && rows.length && ui.view === 'stats') drawTrend(cv, rows, cv.clientWidth, 220); });
})();
