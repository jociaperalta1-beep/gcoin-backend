const CACHE_NAME = 'gcoin-pwa-v2';
const APP_SHELL = [
  '/',
  '/index.html',
  '/offline.html',
  '/style.css',
  '/script.js',
  '/manifest.webmanifest',
  '/guarani-coin.svg',
  '/guarani_coin.jpeg',
  '/guarani-fondo.jpg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => cacheName.startsWith('gcoin-pwa-') && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName)),
      ))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const requestUrl = new URL(request.url);
  if (request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok && requestUrl.pathname === '/') {
            const responseCopy = response.clone();
            event.waitUntil(
              caches.open(CACHE_NAME)
                .then((cache) => cache.put('/', responseCopy))
                .catch((error) => console.error('No se pudo guardar Gcoin para uso sin conexión.', error)),
            );
          }
          return response;
        })
        .catch(async () => (await caches.match(request)) || (await caches.match('/offline.html'))),
    );
    return;
  }

  if (!/\.(?:css|js|svg|jpe?g|png|webp|ico|webmanifest)$/i.test(requestUrl.pathname)) return;
  event.respondWith(
    caches.match(request)
      .then((cachedResponse) => cachedResponse || fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const responseCopy = response.clone();
          event.waitUntil(
            caches.open(CACHE_NAME)
              .then((cache) => cache.put(request, responseCopy))
              .catch((error) => console.error('No se pudo guardar un recurso de Gcoin.', error)),
          );
        }
        return response;
      })),
  );
});
