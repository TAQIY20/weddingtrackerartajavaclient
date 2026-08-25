// Service worker sederhana untuk ArtaJava
// Menyimpan file inti ke cache supaya app tetap bisa dibuka saat offline / sinyal jelek.
// Data project/leads/vendor tetap tersimpan di localStorage/browser seperti biasa —
// service worker ini hanya meng-cache "tampilan" app (HTML/JS/CSS), bukan data.

const CACHE_NAME = 'artajava-cache-v1';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// Saat pertama install, simpan file inti ke cache
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS))
  );
  self.skipWaiting();
});

// Bersihkan cache versi lama saat ada update
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Strategi: coba ambil dari jaringan dulu (biar selalu versi terbaru),
// kalau gagal (offline) baru pakai cache.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request).then((cached) => cached || caches.match('./index.html')))
  );
});
