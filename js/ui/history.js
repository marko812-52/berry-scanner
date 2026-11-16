/* Екран «Історія»: список партій, відкриття, видалення, експорт. */
(function () {
  'use strict';
  const BS = window.BS, ui = BS.ui, $ = ui.$, el = ui.el;
  const TRASH = 'M9 3h6l1 2h4v2H4V5h4l1-2Zm-3 6h12l-1 12H7L6 9Zm4 2v8h1.5v-8H10Zm2.5 0v8H14v-8h-1.5Z';

  function svg(path) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', path); s.append(p);
    return s;
  }

  async function refresh() {
    const box = $('hist-list'), info = $('hist-info');
    let list;
    try { list = await BS.db.listBatches(); }
    catch (e) { box.textContent = ''; info.textContent = 'Історія недоступна в цьому браузері (можливо, приватний режим).'; $('hist-export').disabled = true; return; }
    box.textContent = '';
    info.textContent = list.length ? 'Збережено партій: ' + list.length : '';
    $('hist-export').disabled = !list.length;
    if (!list.length) { box.append(el('div', { class: 'card empty', text: 'Тут з’являться оцінені партії.' })); return; }
    list.forEach((rec) => {
      const ev = BS.normalizeEvaluation(rec.evaluation), open = () => openRecord(rec);
      const prof = BS.PROFILES[(rec.settings && rec.settings.profile) || 'blackberry'] || BS.PROFILES.blackberry;
      box.append(el('div', { class: 'hist-item' },
        el('button', { type: 'button', class: 'hist-thumb', onclick: open, 'aria-label': 'Відкрити партію' }, el('img', { src: rec.thumb, alt: '' })),
        el('button', { type: 'button', class: 'hist-main', onclick: open },
          el('div', { class: 't', text: BS.fmtDate(rec.createdAt) + ' · ' + prof.label + (rec.meta && rec.meta.batchNo ? ' · № ' + rec.meta.batchNo : '') }),
          rec.meta && rec.meta.supplier ? el('div', { class: 'muted', text: rec.meta.supplier }) : null,
          el('div', { class: 'chips' },
            el('span', { class: 'chip chip-' + ev.verdict.code, text: BS.VERDICTS[ev.verdict.code].short }),
            el('span', { class: 'chip chip-unknown', text: 'пліснява ' + BS.fmtPct(ev.percents.mold) + ' %' }),
            ev.needsReview ? el('span', { class: 'chip chip-warn', text: 'перевірити' }) : null,
            rec.correction ? el('span', { class: 'chip chip-demo', style: 'background:#f4ecf8;color:#4a1d5e', text: 'є оцінка людини' }) : null)),
        el('button', {
          type: 'button', class: 'del', 'aria-label': 'Видалити партію',
          onclick: async () => {
            if (!confirm('Видалити цю партію з історії разом із фото? Відновити не вдасться.')) return;
            try { await BS.db.deleteBatch(rec.id); } catch (e) { ui.toast('Не вдалося видалити'); }
            refresh();
          }
        }, svg(TRASH))));
    });
  }
  ui.onShow.history = refresh;

  // Відкриває збережену партію: фото беруться зі сховища, шар на фото перераховується
  // з тими налаштуваннями, що були на момент оцінки; цифри показуються збережені.
  async function openRecord(rec) {
    ui.busy('Відкриваю партію…'); await ui.tick();
    try {
      const stored = await BS.db.getPhotos(rec.id), byId = {};
      stored.forEach((s) => { byId[s.id] = s; });
      const settings = BS.mergeSettings(rec.settings), photos = [];
      for (const ph of rec.photos) {
        if (!byId[ph.id]) continue;
        const canvas = await BS.decodeToCanvas(byId[ph.id].blob, BS.STORE_SIDE);
        const p = { id: ph.id, canvas, blob: byId[ph.id].blob, w: ph.w, h: ph.h, thumb: photos.length ? '' : rec.thumb, roiRect: ph.roiRect || null, roiPoly: ph.roiPoly || null };
        await ui.runPhoto(p, settings);
        photos.push(p);
        await ui.tick();
      }
      if (!photos.length) throw new Error('Фото не знайдено');
      ui.busy(false);
      ui.openBatch({
        id: rec.id, createdAt: rec.createdAt, meta: rec.meta || {}, photos, settings,
        algo: rec.algo, appVersion: rec.appVersion, correction: rec.correction || null, evaluation: rec.evaluation,
        overlayNote: rec.algo !== ui.algoOf(photos) ? 'Позначки на фото перераховано поточною версією алгоритму; цифри показано такими, як їх збережено.' : ''
      }, 'history');
    } catch (e) {
      console.error(e); ui.busy(false); ui.toast('Не вдалося відкрити партію');
    }
  }

  $('hist-export').addEventListener('click', async () => {
    ui.busy('Готую файл експорту…'); await ui.tick();
    try {
      const out = await BS.exportAll(ui.settings);
      ui.download(out.blob, 'berry-scanner-export-' + ui.stamp() + '.zip');
      ui.toast('Експортовано партій: ' + out.batches + ', фото: ' + out.photos);
    } catch (e) { console.error(e); ui.toast('Не вдалося створити файл експорту'); }
    ui.busy(false);
  });
  ui.exportBlob = () => BS.exportAll(ui.settings);   // для перевірки без завантаження файлу
})();
