/* Каркас інтерфейсу: стан, навігація, екран «Нова партія». */
(function () {
  'use strict';
  const BS = window.BS;
  const $ = (id) => document.getElementById(id);
  const MAX_PHOTOS = 5;
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
    kids.flat(Infinity).forEach((c) => { if (c != null) e.append(c); });
    return e;
  }

  const ui = (BS.ui = { $, el, onShow: {} });
  // Додає дочірні елементи, пропускаючи порожні (звичайний append перетворив би null на текст «null»).
  ui.fill = (parent, ...kids) => { kids.flat(Infinity).forEach((c) => { if (c != null && c !== false) parent.append(c); }); return parent; };

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
  ui.stamp = () => {
    const d = new Date(), p = (n) => (n < 10 ? '0' : '') + n;
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
  };

  // ---------- навігація ----------
  const TAB_OF = { new: 'new', result: 'new', correct: 'new', history: 'history', stats: 'stats', settings: 'settings' };
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
  // Аналіз одного фото в режимі з налаштувань (кольоровий / модель / гібрид). Завжди асинхронний.
  ui.runPhoto = async (p, settings) => {
    const px = BS.pixelsOf(p.canvas);
    const opts = p.roiPoly ? { roiPoly: p.roiPoly } : p.roiRect ? { roiRect: p.roiRect } : null;
    p.result = await BS.analyzer.run(px.data, px.width, px.height, settings, opts);
  };
  function summaryOf(res) { const s = Object.assign({}, res); delete s.labels; delete s.spots; return s; }
  ui.toRecord = (b) => ({
    id: b.id, createdAt: b.createdAt, meta: b.meta, settings: b.settings, algo: b.algo, appVersion: b.appVersion,
    evaluation: b.evaluation, correction: b.correction || null, thumb: b.photos[0].thumb,
    photos: b.photos.map((p) => ({ id: p.id, w: p.w, h: p.h, roiRect: p.roiRect || null, roiPoly: p.roiPoly || null, summary: summaryOf(p.result) }))
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
  // Версія алгоритму для запису: кольоровий метод і (якщо брала участь) модель.
  ui.algoOf = (photos) => {
    const m = photos.map((p) => p.result && p.result.modelVersion).find(Boolean);
    return BS.ALGO_VERSION + (m ? ' + ' + m : '');
  };

  // ---------- екран «Нова партія» ----------
  const draft = { photos: [] };

  // перемикач виду ягоди
  function renderProfiles() {
    const box = $('profile-seg'); box.textContent = '';
    BS.PROFILE_KEYS.forEach((key) => {
      const p = BS.PROFILES[key], on = ui.settings.profile === key;
      box.append(el('button', {
        type: 'button', role: 'radio', 'aria-checked': on ? 'true' : 'false', class: on ? 'on' : '', text: p.label,
        onclick: () => { ui.settings.profile = key; ui.saveSettings(); renderProfiles(); }
      }));
    });
    const cur = BS.PROFILES[ui.settings.profile], note = $('profile-note');
    note.hidden = !cur.experimental;
    note.textContent = cur.experimental ? 'Профіль «' + cur.label + '» експериментальний: кольори підібрано без перевірки на реальних лотках. Результат обов’язково перевіряйте.' : '';
  }
  ui.renderProfiles = renderProfiles;

  function renderThumbs() {
    const box = $('thumbs'); box.textContent = '';
    box.hidden = !draft.photos.length;
    draft.photos.forEach((p, i) => box.append(el('div', { class: 'thumb' + (p.quality && !p.quality.ok ? ' bad' : '') },
      el('img', { src: p.thumb, alt: 'Фото ' + (i + 1) }),
      p.quality && !p.quality.ok ? el('span', { class: 'flag', text: p.quality.issues[0].text }) : null,
      el('button', { type: 'button', 'aria-label': 'Прибрати фото ' + (i + 1), text: '×', onclick: () => { draft.photos.splice(i, 1); renderThumbs(); } }))));
    const n = draft.photos.length;
    $('btn-analyze').disabled = !n;
    $('btn-analyze').textContent = n > 1 ? 'Оцінити партію (' + n + ' фото)' : 'Оцінити партію';

    // зауваження до якості фото ще до аналізу
    const warn = $('photo-issues'); warn.textContent = '';
    const bad = draft.photos.map((p, i) => ({ p, i })).filter((x) => x.p.quality && !x.p.quality.ok);
    warn.hidden = !bad.length;
    if (bad.length) {
      warn.append(el('h3', { text: 'Якість фото' }),
        el('ul', { class: 'issues' }, bad.map((x) => el('li', null,
          el('b', { text: 'Фото ' + (x.i + 1) + ': ' + x.p.quality.issues.map((q) => q.text.toLowerCase()).join(', ') + '. ' }),
          x.p.quality.issues[0].tip))),
        el('p', { class: 'note', text: 'Краще перезняти. Оцінити можна й так, але впевненість буде нижчою.' }));
    }
  }

  async function addCanvas(canvas) {
    const blob = await BS.canvasToBlob(canvas, 0.88);
    let quality = null;
    try { const px = BS.pixelsOf(canvas); quality = BS.photoQuality(px.data, px.width, px.height); } catch (e) { console.warn(e); }
    draft.photos.push({ id: ui.uid(), canvas, blob, w: canvas.width, h: canvas.height, thumb: BS.thumbOf(canvas, 160), roiRect: null, roiPoly: null, quality });
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
    try {
      await addCanvas(await BS.loadDemoCanvas());
      if (ui.settings.profile !== 'blackberry') { ui.settings.profile = 'blackberry'; ui.saveSettings(); renderProfiles(); }   // на демо-фото — ожина
      renderThumbs();
    } catch (e) { ui.toast('Демо-фото доступне, коли сторінку відкрито за посиланням. Тут виберіть фото з галереї.', 6000); }
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
        await ui.runPhoto(photos[i], settings);
      }
      const val = (id) => $(id).value.trim();
      const batch = {
        id: ui.uid(), createdAt: Date.now(),
        meta: { batchNo: val('m-batch'), supplier: val('m-supplier'), operator: val('m-operator'), note: val('m-note') },
        photos, settings, algo: ui.algoOf(photos), appVersion: BS.APP_VERSION, correction: null
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

  ui.onShow.new = renderProfiles;
  renderProfiles();
  renderThumbs();
})();
