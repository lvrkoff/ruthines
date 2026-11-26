// Offline support: keeps the app's own files on the device.
// Bump VERSION whenever any app file changes, so devices pick up the update.
// Requests to the Apps Script (data) are never cached here.
const VERSION = 'ruthines-1.6.1';
const FILES = [
  './',
  './index.html',
  './app.js',
  './logic.js',
  './store.js',
  './demo.js',
  './fonts/manrope-latin-wght-normal.woff2',
  './style.css',
  './manifest.webmanifest',
  './icons/sprout-192.png',
  './icons/sprout-512.png',
  './icons/sprout-180.png',
  './icons/sprout-maskable-512.png',
  './icons/sprout.svg',
  './icons/sprout-32.png',
  './ruth/done.webp',
  './ruth/done-still.webp',
  './ruth/streak.webp',
  './ruth/streak-still.webp',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') return caches.match('./index.html').then((r) => r || fetch(req));
      return fetch(req);
    }),
  );
});
