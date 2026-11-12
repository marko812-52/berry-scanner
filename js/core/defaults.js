/*
 * Спільні константи: версії, категорії, початкові налаштування.
 * Файл без DOM — працює і в браузері (window.BS), і в Node (require).
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});

  BS.APP_VERSION = '0.1.0';
  // Змінюй при будь-якій зміні логіки сегментації: версія зберігається з кожною партією.
  BS.ALGO_VERSION = 'hsv-v0.1';

  BS.CLASSES = { OUT: 0, GOOD: 1, RED: 2, GREEN: 3, MOLD: 4, DEBRIS: 5 };

  // Порядок = порядок у таблицях і звіті. color — колір шару на фото та в легенді.
  BS.CATEGORIES = [
    { key: 'good', id: 1, label: 'Якісні (темні)', color: [52, 168, 83] },
    { key: 'red', id: 2, label: 'Недостиглі / червоні', color: [255, 225, 0] },
    { key: 'green', id: 3, label: 'Зелені', color: [64, 196, 255] },
    { key: 'mold', id: 4, label: 'Пліснява', color: [255, 59, 48] },
    { key: 'debris', id: 5, label: 'Рослинні домішки', color: [186, 104, 255] }
  ];

  BS.VERDICTS = {
    freeze: { label: 'Придатна для заморожування після сортування', short: 'Заморожування після сортування' },
    process: { label: 'Для переробки', short: 'Для переробки' },
    reject: { label: 'Відхилити', short: 'Відхилити' }
  };

  // ДЕМО-ЗНАЧЕННЯ. Усі пороги вердикту треба уточнити з технологом.
  BS.DEFAULT_SETTINGS = {
    verdict: {
      freezeMold: 1.5,    // % плісняви, до якого партія йде на заморожування
      freezeUnripe: 8,    // % червоних + зелених
      freezeDebris: 2,    // % рослинних домішок
      processMold: 4,     // % плісняви, до якого партія йде на переробку
      processUnripe: 25,
      processDebris: 6
    },
    confidence: {
      low: 50,            // нижче — «потрібна перевірка людиною»
      high: 75,
      margin: 0.5         // п.п.: наскільки близько до порога вважаємо «на межі»
    },
    color: {
      crateEnabled: true,
      crateHueMin: 160, crateHueMax: 215, crateSatMin: 0.25,   // синій лоток
      moldSatMax: 0.20, moldValMin: 0.42, moldMinSpot: 60,     // пляма в px² при розмірі аналізу 1024
      redHueMin: 330, redHueMax: 12, redSatMin: 0.28, redValMin: 0.23,
      greenHueMin: 40, greenHueMax: 150, greenSatMin: 0.25, greenValMin: 0.40,
      debrisHueMin: 12, debrisSatMin: 0.22, debrisValMin: 0.35,
      minSpeck: 20                                             // дрібніші кольорові цятки — шум
    },
    analysisSize: 1024
  };

  BS.cloneSettings = function (s) { return JSON.parse(JSON.stringify(s || BS.DEFAULT_SETTINGS)); };

  // Доповнює збережені налаштування новими полями зі стандартних (після оновлення версії).
  BS.mergeSettings = function (saved) {
    var out = BS.cloneSettings(BS.DEFAULT_SETTINGS);
    if (!saved || typeof saved !== 'object') return out;
    Object.keys(out).forEach(function (group) {
      if (typeof out[group] === 'object') {
        Object.keys(out[group]).forEach(function (k) {
          var v = saved[group] && saved[group][k];
          if (typeof v === typeof out[group][k] && (typeof v !== 'number' || isFinite(v))) out[group][k] = v;
        });
      } else if (typeof saved[group] === typeof out[group]) {
        out[group] = saved[group];
      }
    });
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BS;
})(typeof self !== 'undefined' ? self : globalThis);
