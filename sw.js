/*
 * Service worker: після першого відкриття сторінка працює без інтернету.
 * УВАГА: при кожному оновленні програми змінюй VERSION (має збігатися з BS.APP_VERSION у js/core/defaults.js),
 * інакше пристрої й далі показуватимуть стару версію з кешу. Нові файли додавай в ASSETS.
 */
const VERSION = '0.1.0';
const CACHE = 'berry-scanner-' + VERSION;
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
  'js/io/image.js',
  'js/io/db.js',
  'js/io/pdf.js',
  'js/io/export.js',
  'js/ui/app.js',
  'js/ui/result.js',
  'js/ui/history.js',
  'js/ui/settings.js',
  'data/samples/photo_2026-11-12_18-39-37.jpg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('berry-scanner-') && k !== CACHE).map((k) => caches.delete(k))))
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
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./').then((page) => page || fetch(req));
      return fetch(req);
    })
  );
});
