/*
 * Єдина точка входу для аналізу фото: режими «Кольоровий / Модель / Гібрид».
 *   color  — кольоровий метод (js/core/segment.js), працює завжди й усюди;
 *   model  — навчена мережа (js/ml/model.js, ONNX Runtime Web), вантажиться ліниво;
 *   hybrid — зона й класи від кольорового методу, модель уточнює (js/ml/model.js: BS.model.combine).
 * Якщо модель недоступна (немає файлу, старий браузер, сторінку відкрито як файл) —
 * автоматичний відкат на кольоровий метод; у результаті лишається позначка fallback.
 * Результат у всіх режимах має однакову форму (див. BS.analyze).
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});

  BS.MODES = [
    { key: 'color', label: 'Кольоровий', hint: 'За кольором. Працює завжди, без завантажень.' },
    { key: 'hybrid', label: 'Гібрид', hint: 'Кольоровий метод + модель як перевірка фону й бліків.' },
    { key: 'model', label: 'Модель', hint: 'Лише навчена модель.' }
  ];
  BS.modeLabel = function (key) {
    for (var i = 0; i < BS.MODES.length; i++) if (BS.MODES[i].key === key) return BS.MODES[i].label;
    return BS.MODES[0].label;
  };

  BS.analyzer = {
    // Чи можна взагалі запускати модель у цьому оточенні.
    modelSupported: function () {
      return !!(BS.model && BS.model.supported && BS.model.supported());
    },

    // Promise<result>. rgba — пікселі фото, settings.mode — режим, opts — як у BS.analyze (roiPoly, roiRect).
    run: function (rgba, w, h, settings, opts) {
      var mode = (settings && settings.mode) || 'color';
      var color;
      try { color = BS.analyze(rgba, w, h, settings, opts); } catch (e) { return Promise.reject(e); }
      color.requestedMode = mode;
      if (mode === 'color') return Promise.resolve(color);
      if (!BS.analyzer.modelSupported()) {
        color.fallback = 'Модель у цьому браузері недоступна — застосовано кольоровий метод';
        return Promise.resolve(color);
      }
      return BS.model.predict(rgba, w, h, settings).then(function (pred) {
        var res = BS.model.combine(color, pred, mode, settings);
        res.requestedMode = mode;
        return res;
      }).catch(function (err) {
        if (root.console) root.console.warn('Модель не спрацювала, відкат на кольоровий метод:', err);
        color.fallback = 'Модель не завантажилась — застосовано кольоровий метод';
        return color;
      });
    }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BS;
})(typeof self !== 'undefined' ? self : globalThis);
