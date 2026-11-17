/*
 * Спільні константи: версії, категорії (єдина таксономія), профілі ягід, початкові налаштування.
 * Файл без DOM — працює і в браузері (window.BS), і в Node (require).
 */
(function (root) {
  'use strict';
  var BS = (root.BS = root.BS || {});

  BS.APP_VERSION = '0.4.0';
  // Змінюй при будь-якій зміні логіки сегментації: версія зберігається з кожною партією.
  BS.ALGO_VERSION = 'hsv-v1.0';

  // Єдина таксономія (та сама в кольоровому методі, моделі, оцінці сортувальника й експорті).
  // OUT — поза зоною ягід; OTHER — «фон / інше» всередині зони, у 100 % не входить.
  BS.CLASSES = { OUT: 0, GOOD: 1, UNRIPE: 2, DAMAGED: 3, MOLD: 4, DEBRIS: 5, OTHER: 6 };

  // Порядок = порядок у таблицях і звіті. color — колір шару на фото та в легенді.
  BS.CATEGORIES = [
    { key: 'good', id: 1, label: 'Якісні', color: [52, 168, 83] },
    { key: 'unripe', id: 2, label: 'Недостиглі', color: [255, 225, 0] },
    { key: 'damaged', id: 3, label: 'Пошкоджені / гнилі', color: [255, 140, 0] },
    { key: 'mold', id: 4, label: 'Пліснява', color: [255, 59, 48] },
    { key: 'debris', id: 5, label: 'Домішки / стороннє', color: [186, 104, 255] }
  ];
  BS.OTHER = { key: 'other', id: 6, label: 'Фон / інше', color: [96, 125, 139] };

  BS.VERDICTS = {
    freeze: { label: 'Придатна для заморожування після сортування', short: 'Заморожування після сортування' },
    process: { label: 'Для переробки', short: 'Для переробки' },
    reject: { label: 'Відхилити', short: 'Відхилити' }
  };

  /*
   * Профілі ягід для кольорового методу. Усі числа — HSV: відтінок у градусах, насиченість і яскравість 0..1.
   *   seed      — які пікселі «схожі на ягоду» при пошуку зони: dark (темніші за авто-поріг) і/або відтінок hue
   *   refV      — типова медіана яскравості зони; за нею вирівнюється експозиція (gain у межах gainMin..gainMax)
   *   white     — кандидати на плісняву/блик/фон: нейтральні світлі; skipHue — відтінок, який білим не вважаємо
   *   rules     — правила по порядку, спрацьовує перше; weak — «слабкий» кандидат, що рахується лише поруч із впевненим
   *   crate     — колір лотка, який виключається із зони
   * Ожина перевірена на реальному фото лотка; решта — експериментальні (підібрані за типовими кольорами).
   */
  BS.PROFILES = {
    blackberry: {
      label: 'Ожина', experimental: false,
      goodLabel: 'Якісні (темні)', unripeLabel: 'Недостиглі (червоні, зелені)',
      seed: { dark: true, hue: [320, 12], satMin: 0.2, valMax: 0.7 },
      refV: 0.146, gainMin: 0.75, gainMax: 1.4,
      white: { satMax: 0.20, valMin: 0.42 },
      moldMinSpot: 60, minSpeck: 20,
      rules: [
        { cls: 'UNRIPE', hue: [40, 150], satMin: 0.25, valMin: 0.40 },             // зелені
        { cls: 'DEBRIS', hue: [12, 40], satMin: 0.22, valMin: 0.35 },              // чашолистики, плодоніжки
        { cls: 'UNRIPE', hue: [330, 12], satMin: 0.28, valMin: 0.23 },             // червоні
        { cls: 'UNRIPE', hue: [322, 16], satMin: 0.24, valMin: 0.17, weak: true }
      ],
      crate: { enabled: true, hue: [160, 215], satMin: 0.25, valMin: 0.15 }
    },
    blueberry: {
      label: 'Лохина', experimental: true,
      goodLabel: 'Якісні (сині)', unripeLabel: 'Недостиглі (зелені, рожеві)',
      seed: { dark: true, hue: [195, 285], satMin: 0.08, valMax: 0.8 },
      refV: 0.30, gainMin: 0.8, gainMax: 1.3, wbSatMax: 0.08,   // наліт сизий: за ним баланс білого не міряємо
      // природний білуватий наліт — синювато-сірий: його не чіпаємо (skipHue), пліснява — нейтрально-біла і світліша
      white: { satMax: 0.11, valMin: 0.58, skipHue: [185, 290], skipSatMin: 0.05 },
      moldMinSpot: 110, minSpeck: 20,
      rules: [
        { cls: 'UNRIPE', hue: [55, 165], satMin: 0.22, valMin: 0.35 },             // зелені
        { cls: 'DEBRIS', hue: [15, 55], satMin: 0.25, valMin: 0.28 },              // плодоніжки, сухе листя
        { cls: 'UNRIPE', hue: [295, 15], satMin: 0.22, valMin: 0.32 },             // рожеві, червонуваті
        { cls: 'UNRIPE', hue: [290, 20], satMin: 0.18, valMin: 0.26, weak: true }
      ],
      crate: { enabled: true, hue: [160, 203], satMin: 0.42, valMin: 0.30 }
    },
    raspberry: {
      label: 'Малина', experimental: true,
      goodLabel: 'Якісні (червоні)', unripeLabel: 'Недостиглі (бліді, зелені)',
      seed: { dark: false, hue: [318, 22], satMin: 0.30, valMax: 1 },
      refV: 0.55, gainMin: 0.8, gainMax: 1.25,
      white: { satMax: 0.12, valMin: 0.62 },
      moldMinSpot: 90, minSpeck: 24,
      rules: [
        { cls: 'DEBRIS', hue: [80, 165], satMin: 0.35, valMax: 0.62 },             // темно-зелене листя
        { cls: 'UNRIPE', hue: [45, 165], satMin: 0.18, valMin: 0.45 },             // зелені, жовто-зелені
        { cls: 'DEBRIS', hue: [16, 45], satMin: 0.28, valMax: 0.5, valMin: 0.18 }, // коричневе: плодоніжки, сухе
        { cls: 'UNRIPE', hue: [16, 45], satMin: 0.16, valMin: 0.6 },               // бліді жовто-рожеві
        { cls: 'UNRIPE', hue: [330, 16], satMin: 0.12, satMax: 0.30, valMin: 0.68 } // бліді рожево-білі
      ],
      crate: { enabled: true, hue: [160, 215], satMin: 0.25, valMin: 0.15 }
    },
    strawberry: {
      label: 'Полуниця', experimental: true,
      goodLabel: 'Якісні (червоні)', unripeLabel: 'Недостиглі (блідо-білі, зелені)',
      seed: { dark: false, hue: [335, 22], satMin: 0.35, valMax: 1 },
      refV: 0.60, gainMin: 0.8, gainMax: 1.25,
      white: { satMax: 0.11, valMin: 0.55 },
      moldMinSpot: 110, minSpeck: 28,
      rules: [
        { cls: 'OTHER', hue: [70, 170], satMin: 0.30, valMax: 0.78 },              // чашолистики — нормальна частина ягоди
        { cls: 'UNRIPE', hue: [45, 120], satMin: 0.12, valMin: 0.55 },             // зеленувато-білі
        { cls: 'DEBRIS', hue: [18, 45], satMin: 0.30, valMax: 0.5, valMin: 0.18 }, // коричневе: сухе листя, плодоніжки
        { cls: 'UNRIPE', hue: [18, 45], satMin: 0.12, valMin: 0.62 },              // блідо-жовті, кремові
        { cls: 'UNRIPE', hue: [335, 18], satMin: 0.11, satMax: 0.36, valMin: 0.66 } // блідо-рожеві
      ],
      crate: { enabled: true, hue: [160, 215], satMin: 0.25, valMin: 0.15 }
    }
  };
  BS.PROFILE_KEYS = ['blackberry', 'blueberry', 'raspberry', 'strawberry'];

  // ДЕМО-ЗНАЧЕННЯ. Усі пороги вердикту треба уточнити з технологом.
  BS.DEFAULT_SETTINGS = {
    profile: 'blackberry',
    mode: 'hybrid',         // 'color' | 'model' | 'hybrid' — спосіб аналізу (без моделі — автоматичний відкат на кольоровий)
    verdict: {
      freezeMold: 1.5,    // % плісняви, до якого партія йде на заморожування
      freezeUnripe: 8,    // % недостиглих
      freezeDamaged: 5,   // % пошкоджених (визначає лише модель)
      freezeDebris: 2,    // % домішок
      processMold: 4,     // % плісняви, до якого партія йде на переробку
      processUnripe: 25,
      processDamaged: 15,
      processDebris: 6
    },
    confidence: {
      low: 50,            // нижче — «потрібна перевірка людиною»
      high: 75,
      margin: 0.5         // п.п.: наскільки близько до порога вважаємо «на межі»
    },
    // Ручне підлаштування профілю ожини під камеру й лампу (решта профілів беруть значення з BS.PROFILES).
    color: {
      crateEnabled: true,
      crateHueMin: 160, crateHueMax: 215, crateSatMin: 0.25,   // синій лоток
      moldSatMax: 0.20, moldValMin: 0.42, moldMinSpot: 60,     // пляма в px² при розмірі аналізу 1024
      redHueMin: 330, redHueMax: 12, redSatMin: 0.28, redValMin: 0.23,
      greenHueMin: 40, greenHueMax: 150, greenSatMin: 0.25, greenValMin: 0.40,
      debrisHueMin: 12, debrisSatMin: 0.22, debrisValMin: 0.35,
      minSpeck: 20                                             // дрібніші кольорові цятки — шум
    },
    // Ознаки білої плями: що вважати бліком, що фоном. Спільні для всіх профілів.
    spot: {
      ring: 4,              // ширина кільця навколо плями, px при розмірі аналізу 1024
      surroundMin: 0.5,     // частка ягід у кільці, нижче — це не пляма на ягодах, а фон
      flatMax: 0.024,       // «гладкість» усередині плями: нижче — рівна поверхня (папір, пластик, стіна)
      bigFraction: 0.05,    // пляма, більша за цю частку зони, — не пліснява, а фон
      glareV: 0.86,         // середня яскравість, вище якої пляма схожа на блик
      glareEdge: 0.30,      // різкість краю (0..1), вище — блик
      glareMaxSpots: 8      // блик не буває більшим за стільки найменших плям плісняви
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
    if (!BS.PROFILES[out.profile]) out.profile = 'blackberry';
    if (['color', 'model', 'hybrid'].indexOf(out.mode) < 0) out.mode = BS.DEFAULT_SETTINGS.mode;
    return out;
  };

  // Параметри профілю з урахуванням ручних налаштувань (вони діють лише на ожину).
  BS.profileOf = function (settings) {
    var key = settings && BS.PROFILES[settings.profile] ? settings.profile : 'blackberry';
    var p = JSON.parse(JSON.stringify(BS.PROFILES[key]));
    p.key = key;
    var c = settings && settings.color;
    if (key === 'blackberry' && c) {
      p.white.satMax = c.moldSatMax; p.white.valMin = c.moldValMin;
      p.moldMinSpot = c.moldMinSpot; p.minSpeck = c.minSpeck;
      p.rules = [
        { cls: 'UNRIPE', hue: [c.greenHueMin, c.greenHueMax], satMin: c.greenSatMin, valMin: c.greenValMin },
        { cls: 'DEBRIS', hue: [c.debrisHueMin, c.greenHueMin], satMin: c.debrisSatMin, valMin: c.debrisValMin },
        { cls: 'UNRIPE', hue: [c.redHueMin, c.redHueMax], satMin: c.redSatMin, valMin: c.redValMin },
        { cls: 'UNRIPE', hue: [c.redHueMin - 8, c.redHueMax + 4], satMin: c.redSatMin - 0.04, valMin: c.redValMin - 0.06, weak: true }
      ];
      p.crate = { enabled: c.crateEnabled, hue: [c.crateHueMin, c.crateHueMax], satMin: c.crateSatMin, valMin: 0.15 };
    }
    return p;
  };

  // Назви категорій з уточненням для профілю («Якісні (темні)» для ожини тощо).
  BS.categoryLabel = function (key, profileKey) {
    var p = BS.PROFILES[profileKey];
    if (p && key === 'good') return p.goodLabel;
    if (p && key === 'unripe') return p.unripeLabel;
    if (key === 'other') return BS.OTHER.label;
    for (var i = 0; i < BS.CATEGORIES.length; i++) if (BS.CATEGORIES[i].key === key) return BS.CATEGORIES[i].label;
    return key;
  };

  // Приводить частки зі старих записів (v0: red, green) до єдиної таксономії.
  BS.normalizePercents = function (p) {
    var out = {};
    p = p || {};
    BS.CATEGORIES.forEach(function (c) { out[c.key] = typeof p[c.key] === 'number' && isFinite(p[c.key]) ? p[c.key] : 0; });
    if (typeof p.unripe !== 'number') out.unripe = (p.red || 0) + (p.green || 0);
    return out;
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = BS;
})(typeof self !== 'undefined' ? self : globalThis);
