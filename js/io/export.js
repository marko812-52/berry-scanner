/*
 * Експорт усієї історії в один ZIP: export.json (партії, результати, виправлення, налаштування)
 * і photos/<id>.jpg. Формат розрахований на майбутнє навчання моделі.
 */
(function () {
  'use strict';
  var BS = window.BS;

  BS.exportAll = function (currentSettings) {
    return BS.db.listBatches().then(function (batches) {
      var files = {}, chain = Promise.resolve();
      batches.forEach(function (b) {
        chain = chain.then(function () { return BS.db.getPhotos(b.id); }).then(function (photos) {
          return Promise.all(photos.map(function (p) {
            return p.blob.arrayBuffer().then(function (buf) {
              files['photos/' + p.id + '.jpg'] = [new Uint8Array(buf), { level: 0 }];   // JPEG уже стиснений
            });
          }));
        });
      });
      return chain.then(function () {
        var doc = {
          app: 'berry-scanner', appVersion: BS.APP_VERSION, algoVersion: BS.ALGO_VERSION,
          exportedAt: new Date().toISOString(),
          note: 'percents — частка площі видимої поверхні, %. correction — виправлення оператора (якщо є). Фото: photos/<photo.id>.jpg',
          categories: BS.CATEGORIES.map(function (c) { return { key: c.key, label: c.label }; }),
          settings: currentSettings,
          batches: batches.map(function (b) { var c = Object.assign({}, b); delete c.thumb; return c; })
        };
        files['export.json'] = fflate.strToU8(JSON.stringify(doc, null, 1));
        return { blob: new Blob([fflate.zipSync(files)], { type: 'application/zip' }), batches: batches.length, photos: Object.keys(files).length - 1 };
      });
    });
  };
})();
