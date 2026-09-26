const CACHE_NAME = 'fastipo-shell-v3';
const LEGACY_CACHE_PREFIX = 'meroshare-shell-';
const SHELL_FILES = [
  './index.html',
  './style.css',
  './app.js?v=connection-status-1',
  './pwa.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './fastipo.png',
  './icon-192.png',
  './icon-180.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(SHELL_FILES))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((cacheNames) => Promise.all(
        cacheNames
          .filter((cacheName) => (
            cacheName.startsWith('fastipo-shell-') || cacheName.startsWith(LEGACY_CACHE_PREFIX)
          ) && cacheName !== CACHE_NAME)
          .map((cacheName) => caches.delete(cacheName))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .catch(async () => (await caches.match(event.request)) || caches.match('./index.html'))
    );
    return;
  }

  event.respondWith(
    fetch(event.request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          return caches.open(CACHE_NAME)
            .then((cache) => cache.put(event.request, copy))
            .then(() => response);
        }
        return response;
      }).catch(() => caches.match(event.request))
  );
});