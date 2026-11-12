/*
 * Історія партій в IndexedDB (лише на цьому пристрої).
 *   batches: запис партії (результати, налаштування, виправлення, мініатюра)
 *   photos:  { id, batchId, blob } — фото у JPEG
 */
(function () {
  'use strict';
  var BS = window.BS;
  var NAME = 'berry-scanner', VERSION = 1, opening = null;

  function open() {
    if (opening) return opening;
    opening = new Promise(function (resolve, reject) {
      if (!window.indexedDB) return reject(new Error('IndexedDB недоступна'));
      var rq = indexedDB.open(NAME, VERSION);
      rq.onupgradeneeded = function () {
        var db = rq.result;
        if (!db.objectStoreNames.contains('batches')) db.createObjectStore('batches', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('batchId', 'batchId');
      };
      rq.onsuccess = function () { resolve(rq.result); };
      rq.onerror = function () { reject(rq.error); };
    });
    opening.catch(function () { opening = null; });
    return opening;
  }

  // Виконує fn(tx) у транзакції; обіцянка завершується, коли транзакцію записано.
  function run(stores, mode, fn) {
    return open().then(function (db) {
      return new Promise(function (resolve, reject) {
        var tx = db.transaction(stores, mode), out;
        tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
        tx.onerror = tx.onabort = function () { reject(tx.error || new Error('Помилка сховища')); };
        out = fn(tx);
      });
    });
  }

  BS.db = {
    saveBatch: function (record, photos) {
      return run(['batches', 'photos'], 'readwrite', function (tx) {
        tx.objectStore('batches').put(record);
        (photos || []).forEach(function (p) { tx.objectStore('photos').put(p); });
      });
    },
    listBatches: function () {
      return run(['batches'], 'readonly', function (tx) { return tx.objectStore('batches').getAll(); })
        .then(function (list) { return (list || []).sort(function (a, b) { return b.createdAt - a.createdAt; }); });
    },
    getBatch: function (id) {
      return run(['batches'], 'readonly', function (tx) { return tx.objectStore('batches').get(id); });
    },
    getPhotos: function (batchId) {
      return run(['photos'], 'readonly', function (tx) { return tx.objectStore('photos').index('batchId').getAll(batchId); })
        .then(function (list) { return list || []; });
    },
    deleteBatch: function (id) {
      return BS.db.getPhotos(id).then(function (photos) {
        return run(['batches', 'photos'], 'readwrite', function (tx) {
          tx.objectStore('batches').delete(id);
          photos.forEach(function (p) { tx.objectStore('photos').delete(p.id); });
        });
      });
    },
    clearAll: function () {
      return run(['batches', 'photos'], 'readwrite', function (tx) {
        tx.objectStore('batches').clear(); tx.objectStore('photos').clear();
      });
    }
  };
})();
