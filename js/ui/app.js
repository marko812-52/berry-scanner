/* Каркас інтерфейсу: стан, навігація, екран «Нова партія». */
(function () {
  'use strict';
  const BS = window.BS;
  const $ = (id) => document.getElementById(id);
  const MAX_PHOTOS = 8;
  const SETTINGS_KEY = 'berry-scanner.settings';

  // Невеликий конструктор елементів: el('div', {class:'x', text:'...'}, дочірні…)
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const k in (props || {})) {
      const v = props[k];
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'style') e.style.cssText = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    kids.flat().forEach((c) => { if (c != null) e.append(c); });
    return e;
  }

  const ui = (BS.ui = { $, el, onShow: {} });

  BS.fmtDate = function (ts) {
    const d = new Date(ts), p = (n) => (n < 10 ? '0' : '') + n;
    return p(d.getDate()) + '.' + p(d.getMonth() + 1) + '.' + d.getFullYear() + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  };
  ui.uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  ui.tick = () => new Promise((r) => setTimeout(r, 40));   // дати браузеру перемалювати екран

  // ---------- налаштування ----------
  function loadSettings() {
    try { return BS.mergeSettings(JSON.parse(localStorage.getItem(SETTINGS_KEY))); } catch (e) { return BS.mergeSettings(null); }
  }
  ui.settings = loadSettings();
  ui.saveSettings = () => { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(ui.settings)); } catch (e) { /* приватний режим */ } };

  // ---------- повідомлення ----------
  let toastTimer = 0;
  ui.toast = (msg, ms) => {
    const t = $('toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3500);
  };
  ui.busy = (text) => { $('busy').hidden = !text; if (text) $('busy-text').textContent = text; };
  ui.download = (blob, name) => {
    const url = URL.createObjectURL(blob), a = el('a', { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };

  // ---------- навігація ----------
  const TAB_OF = { new: 'new', result: 'new', correct: 'new', history: 'history', settings: 'settings' };
  ui.view = 'new';
  ui.show = (name) => {
    ui.view = name;
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + name; });
    document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === TAB_OF[name]));
    window.scrollTo(0, 0);
    if (ui.onShow[name]) ui.onShow[name]();
  };
  document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => ui.show(b.dataset.view)));

  // ---------- аналіз і збереження ----------
  ui.runPhoto = (p, settings) => {
    const px = BS.pixelsOf(p.canvas);
    p.result = BS.analyze(px.data, px.width, px.height, settings, p.roiRect ? { roiRect: p.roiRect } : null);
  };
  function summaryOf(res) { const s = Object.assign({}, res); delete s.labels; return s; }
  ui.toRecord = (b) => ({
    id: b.id, createdAt: b.createdAt, meta: b.meta, settings: b.settings, algo: b.algo, appVersion: b.appVersion,
    evaluation: b.evaluation, correction: b.correction || null, thumb: b.photos[0].thumb,
    photos: b.photos.map((p) => ({ id: p.id, w: p.w, h: p.h, roiRect: p.roiRect || null, summary: summaryOf(p.result) }))
  });
  ui.persist = async (b, withPhotos) => {
    try {
      await BS.db.saveBatch(ui.toRecord(b), withPhotos ? b.photos.map((p) => ({ id: p.id, batchId: b.id, blob: p.blob })) : null);
      return true;
    } catch (e) {
      console.warn(e); ui.toast('Не вдалося зберегти в історію на цьому пристрої');
      return false;
    }
  };

  // ---------- екран «Нова партія» ----------
  const draft = { photos: [] };

  function renderThumbs() {
    const box = $('thumbs'); box.textContent = '';
    box.hidden = !draft.photos.length;
    draft.photos.forEach((p, i) => box.append(el('div', { class: 'thumb' },
      el('img', { src: p.thumb, alt: 'Фото ' + (i + 1) }),
      el('button', { type: 'button', 'aria-label': 'Прибрати фото ' + (i + 1), text: '×', onclick: () => { draft.photos.splice(i, 1); renderThumbs(); } }))));
    const n = draft.photos.length;
    $('btn-analyze').disabled = !n;
    $('btn-analyze').textContent = n > 1 ? 'Оцінити партію (' + n + ' фото)' : 'Оцінити партію';
  }

  async function addCanvas(canvas) {
    const blob = await BS.canvasToBlob(canvas, 0.88);
    draft.photos.push({ id: ui.uid(), canvas, blob, w: canvas.width, h: canvas.height, thumb: BS.thumbOf(canvas, 160), roiRect: null });
  }

  async function addFiles(fileList) {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    ui.busy('Готую фото…'); await ui.tick();
    let failed = 0, skipped = 0;
    for (const f of files) {
      if (draft.photos.length >= MAX_PHOTOS) { skipped++; continue; }
      try { await addCanvas(await BS.decodeToCanvas(f, BS.STORE_SIDE)); } catch (e) { console.warn(e); failed++; }
    }
    ui.busy(false); renderThumbs();
    if (failed) ui.toast('Не вдалося відкрити фото (' + failed + '). Спробуйте JPEG або PNG.');
    else if (skipped) ui.toast('У партії може бути до ' + MAX_PHOTOS + ' фото.');
  }

  $('in-camera').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });
  $('in-gallery').addEventListener('change', (e) => { addFiles(e.target.files); e.target.value = ''; });

  $('btn-demo').addEventListener('click', async () => {
    if (draft.photos.length >= MAX_PHOTOS) return ui.toast('У партії може бути до ' + MAX_PHOTOS + ' фото.');
    ui.busy('Готую фото…');
    try { await addCanvas(await BS.loadDemoCanvas()); renderThumbs(); }
    catch (e) { ui.toast('Демо-фото доступне, коли сторінку відкрито за посиланням. Тут виберіть фото з галереї.', 6000); }
    ui.busy(false);
  });

  $('btn-analyze').addEventListener('click', async () => {
    const photos = draft.photos.slice();
    if (!photos.length) return;
    const settings = BS.cloneSettings(ui.settings);
    try {
      for (let i = 0; i < photos.length; i++) {
        ui.busy(photos.length > 1 ? 'Аналізую фото ' + (i + 1) + ' з ' + photos.length + '…' : 'Аналізую фото…');
        await ui.tick();
        ui.runPhoto(photos[i], settings);
      }
      const val = (id) => $(id).value.trim();
      const batch = {
        id: ui.uid(), createdAt: Date.now(),
        meta: { batchNo: val('m-batch'), supplier: val('m-supplier'), operator: val('m-operator'), note: val('m-note') },
        photos, settings, algo: BS.ALGO_VERSION, appVersion: BS.APP_VERSION, correction: null
      };
      batch.evaluation = BS.evaluateBatch(photos.map((p) => p.result), settings);
      await ui.persist(batch, true);
      draft.photos = []; renderThumbs();
      ['m-batch', 'm-note'].forEach((id) => { $(id).value = ''; });   // постачальник і оператор зазвичай ті самі
      ui.busy(false);
      ui.openBatch(batch);
    } catch (e) {
      console.error(e); ui.busy(false);
      ui.toast('Не вдалося проаналізувати фото. Спробуйте інше фото.');
    }
  });

  // ---------- офлайн-режим (service worker) ----------
  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then((reg) => {
        const offer = (w) => { if (w && navigator.serviceWorker.controller) { ui.waitingWorker = w; $('update-bar').hidden = false; } };
        offer(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          if (w) w.addEventListener('statechange', () => { if (w.state === 'installed') offer(w); });
        });
      }).catch((e) => console.warn('Service worker не зареєстровано', e));
      let reloaded = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (ui.waitingWorker && !reloaded) { reloaded = true; location.reload(); } });
    });
    $('btn-update').addEventListener('click', () => { if (ui.waitingWorker) ui.waitingWorker.postMessage('skip-waiting'); });
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

  renderThumbs();
})();
