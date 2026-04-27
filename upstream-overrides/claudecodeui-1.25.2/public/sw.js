// Service Worker for Claude Code UI PWA
const CACHE_NAME = 'claude-ui-v2';
const PRECACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/favicon.svg',
  '/favicon.png',
];

const isHtmlRequest = (request) => {
  if (request.mode === 'navigate') {
    return true;
  }

  const acceptHeader = request.headers.get('accept') || '';
  return acceptHeader.includes('text/html');
};

const isCacheableAsset = (url) =>
  url.origin === self.location.origin &&
  /\.(?:css|js|mjs|png|svg|ico|woff2?|ttf|json)$/i.test(url.pathname);

const updateHtmlCache = async (request, response) => {
  if (!response || !response.ok) {
    return response;
  }

  const cache = await caches.open(CACHE_NAME);
  await cache.put('/index.html', response.clone());

  if (new URL(request.url).pathname === '/') {
    await cache.put('/', response.clone());
  }

  return response;
};

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_URLS)),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames.map((cacheName) => {
            if (cacheName !== CACHE_NAME) {
              return caches.delete(cacheName);
            }

            return Promise.resolve(false);
          }),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') {
    return;
  }

  if (isHtmlRequest(event.request)) {
    event.respondWith(
      fetch(event.request)
        .then((response) => updateHtmlCache(event.request, response))
        .catch(() => caches.match(event.request).then((cached) => cached || caches.match('/index.html'))),
    );
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }

      return fetch(event.request).then((networkResponse) => {
        if (!networkResponse || !networkResponse.ok) {
          return networkResponse;
        }

        const requestUrl = new URL(event.request.url);
        if (isCacheableAsset(requestUrl)) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }

        return networkResponse;
      });
    }),
  );
});
