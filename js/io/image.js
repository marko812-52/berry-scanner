/* Робота із зображеннями в браузері: декодування, зменшення, мініатюри, шар поверх фото. */
(function () {
  'use strict';
  var BS = window.BS;

  BS.STORE_SIDE = 1600;   // довша сторона копії, що зберігається в історії та йде у звіт

  function drawScaled(src, sw, sh, maxSide) {
    var k = Math.min(1, maxSide / Math.max(sw, sh));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(sw * k));
    c.height = Math.max(1, Math.round(sh * k));
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }

  function viaImage(url, revoke, maxSide) {
    return new Promise(function (resolve, reject) {
      var im = new Image();
      im.onload = function () {
        try { resolve(drawScaled(im, im.naturalWidth, im.naturalHeight, maxSide)); } catch (e) { reject(e); }
        if (revoke) URL.revokeObjectURL(url);
      };
      im.onerror = function () { if (revoke) URL.revokeObjectURL(url); reject(new Error('Не вдалося прочитати зображення')); };
      im.src = url;
    });
  }

  // Файл або Blob → canvas не більший за maxSide, з урахуванням орієнтації EXIF.
  BS.decodeToCanvas = function (blob, maxSide) {
    maxSide = maxSide || BS.STORE_SIDE;
    var fallback = function () { return viaImage(URL.createObjectURL(blob), true, maxSide); };
    if (!window.createImageBitmap) return fallback();
    return createImageBitmap(blob, { imageOrientation: 'from-image' }).then(function (bm) {
      var c = drawScaled(bm, bm.width, bm.height, maxSide);
      if (bm.close) bm.close();
      return c;
    }).catch(fallback);
  };

  // Демо-фото з папки проєкту. З локального файлу (file://) браузер не дає читати пікселі — тоді помилка.
  BS.loadDemoCanvas = function () {
    return viaImage('data/samples/photo_2026-11-12_18-39-37.jpg', false, BS.STORE_SIDE).then(function (c) {
      c.getContext('2d').getImageData(0, 0, 1, 1);   // кине SecurityError, якщо canvas «забруднений»
      return c;
    });
  };

  BS.canvasToBlob = function (canvas, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('Не вдалося зберегти фото')); }, 'image/jpeg', quality || 0.88);
    });
  };

  BS.thumbOf = function (canvas, size) {
    var c = document.createElement('canvas'); c.width = c.height = size;
    var s = Math.min(canvas.width, canvas.height);
    c.getContext('2d').drawImage(canvas, (canvas.width - s) / 2, (canvas.height - s) / 2, s, s, 0, 0, size, size);
    return c.toDataURL('image/jpeg', 0.72);
  };

  BS.pixelsOf = function (canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
  };

  // Малює фото і (за потреби) шар категорій або теплову карту. mode: 'photo' | 'classes' | 'heat'.
  BS.drawAnnotated = function (target, photoCanvas, res, mode, hidden, maxSide) {
    var k = Math.min(1, (maxSide || 1280) / Math.max(photoCanvas.width, photoCanvas.height));
    var tw = Math.round(photoCanvas.width * k), th = Math.round(photoCanvas.height * k);
    if (target.width !== tw) target.width = tw;
    if (target.height !== th) target.height = th;
    var ctx = target.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(photoCanvas, 0, 0, tw, th);
    if (!res || mode === 'photo') return;
    var oc = document.createElement('canvas'); oc.width = res.w; oc.height = res.h;
    oc.getContext('2d').putImageData(new ImageData(BS.renderOverlay(res, mode, hidden), res.w, res.h), 0, 0);
    ctx.drawImage(oc, 0, 0, tw, th);
  };
})();
