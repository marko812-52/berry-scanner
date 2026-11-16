/* Екран результату: вердикт, фото з шаром, таблиця, впевненість, PDF, уточнення зони, оцінка сортувальника. */
(function () {
  'use strict';
  const BS = window.BS, ui = BS.ui, $ = ui.$, el = ui.el;
  const canvas = $('res-canvas'), viewer = canvas.parentElement;
  let cur = null, idx = 0, mode = 'classes', hidden = {}, backTo = 'new';
  let selecting = false, path = null;

  ui.openBatch = (batch, from) => {
    cur = ui.current = batch; idx = 0; mode = 'classes'; hidden = {}; backTo = from || 'new';
    cur.evaluation = BS.normalizeEvaluation(cur.evaluation);
    setSelecting(false);
    render(); ui.show('result');
  };

  const rgb = (c) => 'rgb(' + c.join(',') + ')';
  const pct = (v) => BS.fmtPct(v) + ' %';
  const profileKey = () => (cur.settings && cur.settings.profile) || 'blackberry';
  const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + BS.fmtPct(Math.abs(v));

  function render() {
    const ev = cur.evaluation, pk = profileKey(), prof = BS.PROFILES[pk];
    $('res-date').textContent = BS.fmtDate(cur.createdAt) + ' · ' + prof.label + (cur.meta.batchNo ? ' · № ' + cur.meta.batchNo : '');

    const v = $('res-verdict'); v.className = 'verdict ' + ev.verdict.code; v.textContent = '';
    v.append(el('div', { class: 'cap', text: 'Вердикт за демо-порогами' }), el('div', { class: 'title', text: ev.verdict.label }));
    if (ev.verdict.reasons.length) v.append(el('ul', null, ev.verdict.reasons.map((r) => el('li', { text: r }))));
    $('res-review').hidden = !ev.needsReview;

    // пара «програма — сортувальник»
    const cb = $('res-corrected'), c = cur.correction; cb.hidden = !c; cb.textContent = '';
    if (c) {
      const hp = BS.normalizePercents(c.percents);
      ui.fill(cb, el('h3', { text: 'Оцінка сортувальника' }),
        el('p', { class: 'muted', text: BS.fmtDate(c.at) + (c.by ? ' · ' + c.by : '') }),
        el('div', { class: 'cmp' },
          el('span', { class: 'h' }), el('span', { class: 'h', text: 'Програма' }), el('span', { class: 'h', text: 'Людина' }), el('span', { class: 'h', text: 'Різниця' }),
          BS.CATEGORIES.map((k) => {
            const d = BS.round1(ev.percents[k.key]) - hp[k.key];
            const cls = Math.abs(d) < 0.05 ? '' : (k.key === 'mold' && d < 0 ? ' miss' : ' diff');
            return [el('span', { class: 'n', text: BS.categoryLabel(k.key, pk) }), el('span', { text: pct(ev.percents[k.key]) }),
              el('span', { text: pct(hp[k.key]) }), el('span', { class: 'd' + cls, text: signed(d) })];
          })),
        hp.mold - ev.percents.mold >= 0.5 ? el('p', { class: 'miss-note', text: 'Програма недооцінила плісняву на ' + BS.fmtPct(hp.mold - ev.percents.mold) + ' п.п.' }) : null,
        el('p', { style: 'margin-top:8px;font-weight:650', text: 'Вердикт сортувальника: ' + BS.VERDICTS[c.verdict].label + (c.verdict === ev.verdict.code ? ' — збігається' : ' — не збігається з програмою') }),
        c.comment ? el('p', { style: 'margin-top:8px', text: '«' + c.comment + '»' }) : null);
    }
    $('res-correct').textContent = c ? 'Змінити оцінку сортувальника' : 'Оцінка сортувальника';

    const tb = $('res-table'); tb.textContent = '';
    const row = (key, label, color, val, text) => el('button', {
      type: 'button', class: 'cat' + (hidden[key] ? ' off' : '') + (key === 'other' ? ' other' : ''), 'aria-pressed': hidden[key] ? 'false' : 'true',
      onclick: () => { hidden[key] = !hidden[key]; if (mode === 'photo') setMode('classes'); render(); }
    },
      el('span', { class: 'sw', style: 'background:' + rgb(color) }),
      el('span', { class: 'name', text: label }),
      el('span', { class: 'pct', text: text }),
      el('span', { class: 'bar' }, el('i', { style: 'width:' + Math.min(100, val) + '%;background:' + rgb(color) })));
    BS.CATEGORIES.forEach((k) => tb.append(row(k.key, BS.categoryLabel(k.key, pk), k.color, ev.percents[k.key], pct(ev.percents[k.key]))));
    const other = 100 * (ev.otherFraction || 0);
    if (other >= 0.05) tb.append(row('other', BS.OTHER.label + ' — у склад не входить', BS.OTHER.color, other, pct(other) + ' зони'));

    const res = cur.photos[idx].result || {}, method = res.method || 'color';
    $('res-spots').textContent = 'Знайдено плям плісняви: ' + ev.moldSpots + '.' + (method === 'color' ? ' «Пошкоджені» кольоровий метод не визначає — потрібна модель.' : '');
    $('res-method-note').textContent = 'Спосіб: ' + BS.modeLabel(method).toLowerCase() + (res.modelVersion ? ' (' + res.modelVersion + ')' : '') + '.' +
      (res.fallback ? ' ' + res.fallback + '.' : '') +
      ' Відсотки — частка площі ягід на фото, а не маси чи кількості. Пліснява — нижня оцінка: тонкий сірий наліт програма не відрізняє від відблиску.';

    const cf = $('res-conf'); cf.textContent = '';
    cf.append(el('div', { class: 'conf-head' }, el('h3', { text: 'Впевненість' }), el('b', { text: ev.confidence.label + ' · ' + ev.confidence.score + ' зі 100' })),
      el('div', { class: 'meter ' + ev.confidence.level }, el('i', { style: 'width:' + ev.confidence.score + '%' })),
      ev.issues.length ? el('ul', { class: 'issues' }, ev.issues.map((i) => el('li', { text: i.text })))
        : el('p', { class: 'muted', text: 'Зауважень до фото немає.' }),
      el('p', { class: 'note', text: 'Впевненість показує, наскільки умови зйомки придатні для оцінки. Це не точність у відсотках.' }));

    $('res-pager').hidden = cur.photos.length < 2;
    $('res-page').textContent = 'Фото ' + (idx + 1) + ' з ' + cur.photos.length;
    const p = cur.photos[idx];
    $('res-roi-auto').hidden = !(p.roiPoly || p.roiRect) || selecting;
    const note = $('res-overlay-note'); note.hidden = !cur.overlayNote; note.textContent = cur.overlayNote || '';
    draw();
  }

  function draw() {
    const p = cur.photos[idx];
    BS.drawAnnotated(canvas, p.canvas, p.result, selecting ? 'photo' : mode, hidden, 1280);
    if (selecting && path && path.length > 1) {
      const ctx = canvas.getContext('2d'), W = canvas.width, H = canvas.height;
      const trace = () => { ctx.moveTo(path[0].x * W, path[0].y * H); for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x * W, path[i].y * H); ctx.closePath(); };
      ctx.beginPath(); ctx.rect(0, 0, W, H); trace();
      ctx.fillStyle = 'rgba(0,0,0,.5)'; ctx.fill('evenodd');
      ctx.beginPath(); trace();
      ctx.lineWidth = Math.max(3, W / 250); ctx.lineJoin = 'round'; ctx.strokeStyle = '#fff'; ctx.stroke();
    }
  }

  function setMode(m) {
    mode = m;
    document.querySelectorAll('#res-mode button').forEach((b) => b.classList.toggle('on', b.dataset.mode === m));
  }
  document.querySelectorAll('#res-mode button').forEach((b) => b.addEventListener('click', () => { setSelecting(false); setMode(b.dataset.mode); draw(); }));
  $('res-prev').addEventListener('click', () => { idx = (idx + cur.photos.length - 1) % cur.photos.length; setSelecting(false); render(); });
  $('res-next').addEventListener('click', () => { idx = (idx + 1) % cur.photos.length; setSelecting(false); render(); });
  $('res-back').addEventListener('click', () => ui.show(backTo));
  $('res-new').addEventListener('click', () => ui.show('new'));

  // ---------- ручна зона: обведення пальцем ----------
  function setSelecting(on) {
    selecting = on; path = null;
    viewer.classList.toggle('selecting', on);
    $('res-roi-hint').hidden = !on;
    $('res-roi').textContent = on ? 'Скасувати' : 'Уточнити зону';
    if (cur) { const p = cur.photos[idx]; $('res-roi-auto').hidden = !(p.roiPoly || p.roiRect) || on; draw(); }
  }
  // poly: [{x,y},…] у частках кадру або null (повернути автоматичну зону)
  async function applyRoi(poly) {
    const p = cur.photos[idx];
    ui.busy('Перераховую…'); await ui.tick();
    try {
      p.roiPoly = poly; p.roiRect = null;
      await ui.runPhoto(p, cur.settings);
      cur.evaluation = BS.evaluateBatch(cur.photos.map((x) => x.result), cur.settings);
      cur.overlayNote = '';
      await ui.persist(cur, false);
    } catch (e) { console.error(e); ui.toast('Не вдалося перерахувати'); }
    ui.busy(false); setSelecting(false); render();
  }
  $('res-roi').addEventListener('click', () => setSelecting(!selecting));
  $('res-roi-auto').addEventListener('click', () => applyRoi(null));

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: clamp01((e.clientX - b.left) / b.width), y: clamp01((e.clientY - b.top) / b.height) }; };
  const polyArea = (pts) => { let a = 0; for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y); return Math.abs(a) / 2; };
  // Не більше ~150 точок: цього досить для будь-якого контуру, а запис в історії лишається малим.
  const thin = (pts) => { const k = Math.ceil(pts.length / 150); return pts.filter((_, i) => i % k === 0).map((q) => ({ x: Math.round(q.x * 1000) / 1000, y: Math.round(q.y * 1000) / 1000 })); };

  canvas.addEventListener('pointerdown', (e) => {
    if (!selecting) return;
    e.preventDefault(); path = [pos(e)];
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* не критично: без захоплення теж працює */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!selecting || !path) return;
    const q = pos(e), last = path[path.length - 1];
    if (Math.hypot(q.x - last.x, q.y - last.y) < 0.006) return;
    path.push(q); draw();
  });
  canvas.addEventListener('pointerup', () => {
    if (!selecting || !path) return;
    const pts = path; path = null;
    if (pts.length < 6 || polyArea(pts) < 0.03) { draw(); ui.toast('Зона замала — обведіть більшу ділянку'); return; }
    applyRoi(thin(pts));
  });
  canvas.addEventListener('pointercancel', () => { path = null; if (selecting) draw(); });

  // ---------- PDF ----------
  ui.makePdfBlob = async () => {
    const images = cur.photos.map((p) => {
      const c = document.createElement('canvas');
      BS.drawAnnotated(c, p.canvas, p.result, 'classes', {}, 1100);
      return { dataUrl: c.toDataURL('image/jpeg', 0.82), w: c.width, h: c.height };
    });
    return BS.buildPdf(cur, images).output('blob');
  };
  $('res-pdf').addEventListener('click', async () => {
    ui.busy('Готую PDF-звіт…'); await ui.tick();
    try { ui.download(await ui.makePdfBlob(), BS.pdfFileName(cur)); ui.toast('Звіт збережено в завантаженнях'); }
    catch (e) { console.error(e); ui.toast('Не вдалося створити PDF'); }
    ui.busy(false);
  });

  // ---------- оцінка сортувальника (режим перевірки) ----------
  const EDITABLE = BS.CATEGORIES.filter((k) => k.key !== 'good');
  let vals = {};

  function updateGood() {
    const good = BS.round1(100 - EDITABLE.reduce((s, k) => s + vals[k.key], 0));
    const row = $('cor-good'); row.querySelector('.val').textContent = pct(good);
    row.classList.toggle('bad', good < 0);
    $('cor-save').disabled = good < 0;
    return good;
  }

  $('res-correct').addEventListener('click', () => {
    const pk = profileKey(), ev = cur.evaluation;
    const src = cur.correction ? BS.normalizePercents(cur.correction.percents) : ev.percents;
    const box = $('cor-fields'); box.textContent = '';
    const good = BS.CATEGORIES[0];
    box.append(el('div', { class: 'stepper auto', id: 'cor-good' },
      el('span', { class: 'name' }, el('span', { class: 'sw', style: 'background:' + rgb(good.color) }), BS.categoryLabel('good', pk) + ' — решта'),
      el('span', { class: 'val' })));
    EDITABLE.forEach((k) => {
      vals[k.key] = BS.round1(src[k.key]);
      const input = el('input', { type: 'number', inputmode: 'decimal', min: '0', max: '100', step: '0.1', value: vals[k.key], 'aria-label': k.label + ', %' });
      const set = (v) => { vals[k.key] = BS.round1(Math.max(0, Math.min(100, isFinite(v) ? v : 0))); input.value = vals[k.key]; updateGood(); };
      input.addEventListener('change', () => set(parseFloat(String(input.value).replace(',', '.'))));
      box.append(el('div', { class: 'stepper' },
        el('span', { class: 'name' }, el('span', { class: 'sw', style: 'background:' + rgb(k.color) }), BS.categoryLabel(k.key, pk) + ', %',
          el('span', { class: 'prog', text: 'програма: ' + pct(ev.percents[k.key]) })),
        el('button', { type: 'button', 'aria-label': 'Менше: ' + k.label, text: '−', onclick: () => set(vals[k.key] - 0.5) }),
        input,
        el('button', { type: 'button', 'aria-label': 'Більше: ' + k.label, text: '+', onclick: () => set(vals[k.key] + 0.5) })));
    });
    updateGood();

    const chosen = cur.correction ? cur.correction.verdict : ev.verdict.code;
    const vb = $('cor-verdict'); vb.textContent = '';
    ['freeze', 'process', 'reject'].forEach((code) => vb.append(el('label', null,
      el('input', { type: 'radio', name: 'cor-verdict', value: code, checked: code === chosen }), BS.VERDICTS[code].label)));
    $('cor-comment').value = cur.correction ? cur.correction.comment : '';
    $('cor-remove').hidden = !cur.correction;
    ui.show('correct');
  });

  async function saveCorrection(correction, msg) {
    cur.correction = correction;
    const ok = await ui.persist(cur, false);
    render(); ui.show('result');
    if (ok) ui.toast(msg);
  }
  $('cor-save').addEventListener('click', () => {
    const picked = document.querySelector('input[name="cor-verdict"]:checked');
    if (!picked) return ui.toast('Оберіть вердикт');
    const percents = { good: updateGood() };
    EDITABLE.forEach((k) => { percents[k.key] = vals[k.key]; });
    saveCorrection({ at: Date.now(), by: (cur.meta && cur.meta.operator) || '', percents, verdict: picked.value, comment: $('cor-comment').value.trim() }, 'Оцінку сортувальника збережено на пристрої');
  });
  $('cor-remove').addEventListener('click', () => saveCorrection(null, 'Оцінку сортувальника прибрано'));
  $('cor-cancel').addEventListener('click', () => ui.show('result'));
})();
