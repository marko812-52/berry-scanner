/* Екран результату: вердикт, фото з шаром, таблиця, впевненість, PDF, уточнення зони, виправлення. */
(function () {
  'use strict';
  const BS = window.BS, ui = BS.ui, $ = ui.$, el = ui.el;
  const canvas = $('res-canvas'), viewer = canvas.parentElement;
  let cur = null, idx = 0, mode = 'classes', hidden = {}, backTo = 'new';
  let selecting = false, start = null, rect = null;

  ui.openBatch = (batch, from) => {
    cur = ui.current = batch; idx = 0; mode = 'classes'; hidden = {}; backTo = from || 'new';
    setSelecting(false);
    render(); ui.show('result');
  };

  const rgb = (c) => 'rgb(' + c.join(',') + ')';
  const pct = (v) => BS.fmtPct(v) + ' %';

  function render() {
    const ev = cur.evaluation;
    $('res-date').textContent = BS.fmtDate(cur.createdAt) + (cur.meta.batchNo ? ' · № ' + cur.meta.batchNo : '');

    const v = $('res-verdict'); v.className = 'verdict ' + ev.verdict.code; v.textContent = '';
    v.append(el('div', { class: 'cap', text: 'Вердикт за демо-порогами' }), el('div', { class: 'title', text: ev.verdict.label }));
    if (ev.verdict.reasons.length) v.append(el('ul', null, ev.verdict.reasons.map((r) => el('li', { text: r }))));
    $('res-review').hidden = !ev.needsReview;

    const cb = $('res-corrected'), c = cur.correction; cb.hidden = !c; cb.textContent = '';
    if (c) {
      const changed = BS.CATEGORIES.filter((k) => Math.abs(c.percents[k.key] - BS.round1(ev.percents[k.key])) >= 0.05)
        .map((k) => el('li', { text: k.label + ': ' + pct(ev.percents[k.key]) + ' → ' + pct(c.percents[k.key]) }));
      cb.append(el('h3', { text: 'Виправлено оператором' }),
        el('p', { class: 'muted', text: BS.fmtDate(c.at) }),
        el('p', { style: 'margin-top:8px;font-weight:650', text: 'Вердикт оператора: ' + BS.VERDICTS[c.verdict].label }),
        changed.length ? el('ul', { class: 'issues' }, changed) : el('p', { class: 'muted', text: 'Частки без змін.' }),
        c.comment ? el('p', { style: 'margin-top:8px', text: '«' + c.comment + '»' }) : null);
    }
    $('res-correct').textContent = c ? 'Змінити виправлення' : 'Виправити результат';

    const tb = $('res-table'); tb.textContent = '';
    BS.CATEGORIES.forEach((k) => {
      const val = ev.percents[k.key];
      tb.append(el('button', {
        type: 'button', class: 'cat' + (hidden[k.key] ? ' off' : ''), 'aria-pressed': hidden[k.key] ? 'false' : 'true',
        onclick: () => { hidden[k.key] = !hidden[k.key]; if (mode === 'photo') setMode('classes'); render(); }
      },
        el('span', { class: 'sw', style: 'background:' + rgb(k.color) }),
        el('span', { class: 'name', text: k.label }),
        el('span', { class: 'pct', text: pct(val) }),
        el('span', { class: 'bar' }, el('i', { style: 'width:' + Math.min(100, val) + '%;background:' + rgb(k.color) }))));
    });
    $('res-spots').textContent = 'Недостиглі разом (червоні + зелені): ' + pct(ev.unripe) + '. Знайдено плям плісняви: ' + ev.moldSpots + '.';

    const cf = $('res-conf'); cf.textContent = '';
    cf.append(el('div', { class: 'conf-head' }, el('h3', { text: 'Впевненість' }), el('b', { text: ev.confidence.label + ' · ' + ev.confidence.score + ' зі 100' })),
      el('div', { class: 'meter ' + ev.confidence.level }, el('i', { style: 'width:' + ev.confidence.score + '%' })),
      ev.issues.length ? el('ul', { class: 'issues' }, ev.issues.map((i) => el('li', { text: i.text })))
        : el('p', { class: 'muted', text: 'Зауважень до фото немає.' }),
      el('p', { class: 'note', text: 'Впевненість показує, наскільки умови зйомки придатні для оцінки. Це не точність у відсотках.' }));

    $('res-pager').hidden = cur.photos.length < 2;
    $('res-page').textContent = 'Фото ' + (idx + 1) + ' з ' + cur.photos.length;
    $('res-roi-auto').hidden = !cur.photos[idx].roiRect || selecting;
    const note = $('res-overlay-note'); note.hidden = !cur.overlayNote; note.textContent = cur.overlayNote || '';
    draw();
  }

  function draw() {
    const p = cur.photos[idx];
    BS.drawAnnotated(canvas, p.canvas, p.result, selecting ? 'photo' : mode, hidden, 1280);
    if (selecting && rect) {
      const ctx = canvas.getContext('2d'), x = rect.x0 * canvas.width, y = rect.y0 * canvas.height;
      const w = (rect.x1 - rect.x0) * canvas.width, h = (rect.y1 - rect.y0) * canvas.height;
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.fillRect(0, 0, canvas.width, y); ctx.fillRect(0, y + h, canvas.width, canvas.height - y - h);
      ctx.fillRect(0, y, x, h); ctx.fillRect(x + w, y, canvas.width - x - w, h);
      ctx.lineWidth = Math.max(3, canvas.width / 250); ctx.strokeStyle = '#fff'; ctx.strokeRect(x, y, w, h);
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

  // ---------- ручна зона ----------
  function setSelecting(on) {
    selecting = on; start = rect = null;
    viewer.classList.toggle('selecting', on);
    $('res-roi-hint').hidden = !on;
    $('res-roi').textContent = on ? 'Скасувати' : 'Уточнити зону';
    if (cur) { $('res-roi-auto').hidden = !cur.photos[idx].roiRect || on; draw(); }
  }
  async function applyRoi(r) {
    const p = cur.photos[idx];
    ui.busy('Перераховую…'); await ui.tick();
    try {
      p.roiRect = r;
      ui.runPhoto(p, cur.settings);
      cur.evaluation = BS.evaluateBatch(cur.photos.map((x) => x.result), cur.settings);
      await ui.persist(cur, false);
    } catch (e) { console.error(e); ui.toast('Не вдалося перерахувати'); }
    ui.busy(false); setSelecting(false); render();
  }
  $('res-roi').addEventListener('click', () => setSelecting(!selecting));
  $('res-roi-auto').addEventListener('click', () => applyRoi(null));

  const clamp01 = (v) => Math.max(0, Math.min(1, v));
  const pos = (e) => { const b = canvas.getBoundingClientRect(); return { x: clamp01((e.clientX - b.left) / b.width), y: clamp01((e.clientY - b.top) / b.height) }; };
  canvas.addEventListener('pointerdown', (e) => {
    if (!selecting) return;
    e.preventDefault(); start = pos(e); rect = null;
    try { canvas.setPointerCapture(e.pointerId); } catch (err) { /* не критично: без захоплення теж працює */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!selecting || !start) return;
    const p = pos(e);
    rect = { x0: Math.min(start.x, p.x), y0: Math.min(start.y, p.y), x1: Math.max(start.x, p.x), y1: Math.max(start.y, p.y) };
    draw();
  });
  canvas.addEventListener('pointerup', () => {
    if (!selecting || !start) return;
    start = null;
    if (!rect || (rect.x1 - rect.x0) * (rect.y1 - rect.y0) < 0.03) { rect = null; draw(); ui.toast('Зона замала — обведіть більший прямокутник'); return; }
    applyRoi(rect);
  });
  canvas.addEventListener('pointercancel', () => { start = rect = null; if (selecting) draw(); });

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

  // ---------- виправлення ----------
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
    const src = cur.correction ? cur.correction.percents : cur.evaluation.percents;
    const box = $('cor-fields'); box.textContent = '';
    const good = BS.CATEGORIES[0];
    box.append(el('div', { class: 'stepper auto', id: 'cor-good' },
      el('span', { class: 'name' }, el('span', { class: 'sw', style: 'background:' + rgb(good.color) }), good.label + ' — решта'),
      el('span', { class: 'val' })));
    EDITABLE.forEach((k) => {
      vals[k.key] = BS.round1(src[k.key]);
      const input = el('input', { type: 'number', inputmode: 'decimal', min: '0', max: '100', step: '0.1', value: vals[k.key], 'aria-label': k.label + ', %' });
      const set = (v) => { vals[k.key] = BS.round1(Math.max(0, Math.min(100, isFinite(v) ? v : 0))); input.value = vals[k.key]; updateGood(); };
      input.addEventListener('change', () => set(parseFloat(String(input.value).replace(',', '.'))));
      box.append(el('div', { class: 'stepper' },
        el('span', { class: 'name' }, el('span', { class: 'sw', style: 'background:' + rgb(k.color) }), k.label + ', %'),
        el('button', { type: 'button', 'aria-label': 'Менше: ' + k.label, text: '−', onclick: () => set(vals[k.key] - 0.5) }),
        input,
        el('button', { type: 'button', 'aria-label': 'Більше: ' + k.label, text: '+', onclick: () => set(vals[k.key] + 0.5) })));
    });
    updateGood();

    const chosen = cur.correction ? cur.correction.verdict : cur.evaluation.verdict.code;
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
    saveCorrection({ at: Date.now(), percents, verdict: picked.value, comment: $('cor-comment').value.trim() }, 'Виправлення збережено на пристрої');
  });
  $('cor-remove').addEventListener('click', () => saveCorrection(null, 'Виправлення прибрано'));
  $('cor-cancel').addEventListener('click', () => ui.show('result'));
})();
