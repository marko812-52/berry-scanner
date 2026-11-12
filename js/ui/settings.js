/* Екран «Налаштування»: пороги вердикту, впевненість, розпізнавання кольорів, дані на пристрої. */
(function () {
  'use strict';
  const BS = window.BS, ui = BS.ui, $ = ui.$, el = ui.el;
  const DEMO = 'демо-значення, уточнити з технологом';

  // [ключ, підпис, мін, макс, крок]
  const GROUPS = [
    {
      group: 'verdict', title: 'Пороги вердикту', demo: true,
      hint: 'Партія йде на заморожування, якщо всі три показники не перевищують перший рядок порогів; на переробку — якщо не перевищують другий; інакше — відхилити. «Недостиглі» — це червоні й зелені разом.',
      fields: [
        ['freezeMold', 'Заморожування: пліснява до, %', 0, 100, 0.1],
        ['freezeUnripe', 'Заморожування: недостиглі до, %', 0, 100, 0.1],
        ['freezeDebris', 'Заморожування: домішки до, %', 0, 100, 0.1],
        ['processMold', 'Переробка: пліснява до, %', 0, 100, 0.1],
        ['processUnripe', 'Переробка: недостиглі до, %', 0, 100, 0.1],
        ['processDebris', 'Переробка: домішки до, %', 0, 100, 0.1]
      ]
    },
    {
      group: 'confidence', title: 'Впевненість', demo: true,
      hint: 'Якщо впевненість нижча за поріг або результат близько до порога вердикту, з’являється позначка «Потрібна перевірка людиною».',
      fields: [
        ['low', 'Перевірка людиною, якщо нижче (0–100)', 0, 100, 1],
        ['high', '«Висока», якщо від (0–100)', 0, 100, 1],
        ['margin', 'Запас біля порога вердикту, п.п.', 0, 10, 0.1]
      ]
    },
    {
      group: 'color', title: 'Розпізнавання кольорів', advanced: true,
      hint: 'Для налагодження під конкретне освітлення й камеру. Насиченість і яскравість — від 0 до 1, відтінок — у градусах колірного кола.',
      fields: [
        ['moldValMin', 'Пліснява: яскравість від', 0, 1, 0.01],
        ['moldSatMax', 'Пліснява: насиченість до', 0, 1, 0.01],
        ['moldMinSpot', 'Пліснява: найменша пляма, px²', 1, 2000, 1],
        ['redSatMin', 'Червоні: насиченість від', 0, 1, 0.01],
        ['redValMin', 'Червоні: яскравість від', 0, 1, 0.01],
        ['greenHueMin', 'Межа «коричневе / зелене», °', 20, 80, 1],
        ['crateHueMin', 'Колір лотка: відтінок від, °', 0, 360, 1],
        ['crateHueMax', 'Колір лотка: відтінок до, °', 0, 360, 1]
      ],
      checks: [['crateEnabled', 'Виключати лоток за кольором (синій)']]
    }
  ];

  let savedTimer = 0;
  function saved() { ui.saveSettings(); clearTimeout(savedTimer); savedTimer = setTimeout(() => ui.toast('Налаштування збережено', 1800), 250); }

  function render() {
    const body = $('set-body'); body.textContent = '';
    GROUPS.forEach((g) => {
      const s = ui.settings[g.group];
      const grid = el('div', { class: 'set-grid' }, g.fields.map(([key, label, min, max, step]) => {
        const input = el('input', { type: 'number', inputmode: 'decimal', min, max, step, value: s[key] });
        input.addEventListener('change', () => {
          let v = parseFloat(String(input.value).replace(',', '.'));
          if (!isFinite(v)) v = BS.DEFAULT_SETTINGS[g.group][key];
          v = Math.max(min, Math.min(max, v));
          s[key] = v; input.value = v; saved();
        });
        return el('label', { class: 'field' }, label, input);
      }));
      const checks = (g.checks || []).map(([key, label]) => {
        const input = el('input', { type: 'checkbox', checked: s[key] });
        input.addEventListener('change', () => { s[key] = input.checked; saved(); });
        return el('label', { class: 'check' }, input, label);
      });
      const head = [g.title, g.demo ? el('span', { class: 'chip chip-warn', text: DEMO }) : null];
      body.append(g.advanced
        ? el('details', { class: 'card details' }, el('summary', null, g.title + ' ', el('span', { class: 'muted', text: '(розширені)' })), el('p', { class: 'muted', text: g.hint }), grid, checks)
        : el('div', { class: 'card set-group' }, el('h3', null, head), el('p', { class: 'muted', text: g.hint }), grid, checks));
    });
    body.append(el('p', { class: 'note', text: 'Зміни діють для нових оцінок. Збережені партії пам’ятають пороги, з якими їх оцінено.' }));

    const offline = !/^https?:$/.test(location.protocol) ? 'недоступний, бо сторінку відкрито як файл'
      : (navigator.serviceWorker && navigator.serviceWorker.controller ? 'готовий' : 'вмикається після першого відкриття');
    $('set-about').textContent = 'Версія ' + BS.APP_VERSION + ' · алгоритм ' + BS.ALGO_VERSION + ' · офлайн-режим: ' + offline + '.';

    const st = $('set-storage'); st.textContent = '';
    BS.db.listBatches().then((list) => {
      let text = 'Партій в історії: ' + list.length + '.';
      if (navigator.storage && navigator.storage.estimate) {
        return navigator.storage.estimate().then((e) => { st.textContent = text + ' Зайнято приблизно ' + (e.usage / 1048576).toFixed(1).replace('.', ',') + ' МБ.'; });
      }
      st.textContent = text;
    }).catch(() => { st.textContent = 'Сховище недоступне в цьому браузері.'; });
  }
  ui.onShow.settings = render;

  $('set-reset').addEventListener('click', () => {
    if (!confirm('Повернути всі налаштування до демо-значень?')) return;
    ui.settings = BS.cloneSettings(BS.DEFAULT_SETTINGS); ui.saveSettings(); render(); ui.toast('Повернуто демо-значення');
  });
  $('set-clear').addEventListener('click', async () => {
    if (!confirm('Видалити всю історію партій разом із фото та виправленнями? Відновити не вдасться. Якщо дані потрібні — спершу зробіть експорт.')) return;
    try { await BS.db.clearAll(); ui.toast('Історію видалено'); } catch (e) { ui.toast('Не вдалося видалити'); }
    render();
  });
})();
