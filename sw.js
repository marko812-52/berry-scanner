/*
 * Service worker: після першого відкриття сторінка працює без інтернету.
 * УВАГА: при кожному оновленні програми змінюй VERSION (має збігатися з BS.APP_VERSION у js/core/defaults.js),
 * інакше пристрої й далі показуватимуть стару версію з кешу. Нові файли додавай в ASSETS.
 */
const VERSION = '0.4.0';
const CACHE = 'berry-scanner-' + VERSION;
// Модель і рушій ONNX Runtime (~16 МБ) кешуються окремо й лише після першого використання — не при встановленні.
// Цей кеш переживає оновлення програми; стара версія моделі видаляється, коли з'являється нова.
const MODEL_CACHE = 'berry-scanner-models';
const ASSETS = [
  './',
  'manifest.webmanifest',
  'css/app.css',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'vendor/jspdf.umd.min.js',
  'vendor/fflate.umd.js',
  'vendor/fonts/NotoSans-Regular.js',
  'vendor/fonts/NotoSans-Bold.js',
  'js/core/defaults.js',
  'js/core/segment.js',
  'js/core/verdict.js',
  'js/core/analyzer.js',
  'js/ml/model.js',
  'js/io/image.js',
  'js/io/db.js',
  'js/io/pdf.js',
  'js/io/export.js',
  'js/ui/app.js',
  'js/ui/result.js',
  'js/ui/history.js',
  'js/ui/settings.js',
  'js/ui/stats.js',
  'data/samples/photo_2026-11-12_18-39-37.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('berry-scanner-') && k !== CACHE && k !== MODEL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Сторінка просить активувати нову версію (кнопка «Оновити»).
self.addEventListener('message', (event) => {
  if (event.data === 'skip-waiting') self.skipWaiting();
});

// Спершу кеш, потім мережа. Фото користувача сюди не потрапляють: вони не надсилаються взагалі.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  const path = new URL(req.url).pathname;
  if (path.includes('/models/') && path.endsWith('.json')) { event.respondWith(networkFirst(req)); return; }
  if (path.includes('/models/') || path.includes('/vendor/onnxruntime-')) { event.respondWith(cacheOnUse(req)); return; }
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./').then((page) => page || fetch(req));
      return fetch(req);
    })
  );
});

// Опис моделі: спершу мережа (щоб побачити нову версію), без мережі — з кешу.
function networkFirst(req) {
  return caches.open(MODEL_CACHE).then((cache) => fetch(req).then((res) => {
    if (res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => cache.match(req, { ignoreSearch: true }).then((hit) => hit || Response.error())));
}

// Модель і рушій: з кешу, а якщо немає — з мережі з записом у кеш. Старі версії того самого файлу прибираються.
function cacheOnUse(req) {
  return caches.open(MODEL_CACHE).then((cache) => cache.match(req).then((hit) => hit || fetch(req).then((res) => {
    if (res.ok && res.status === 200) {
      const base = req.url.split('?')[0];
      cache.keys().then((keys) => keys.forEach((k) => { if (k.url.split('?')[0] === base && k.url !== req.url) cache.delete(k); }));
      cache.put(req, res.clone());
    }
    return res;
  })));
}
