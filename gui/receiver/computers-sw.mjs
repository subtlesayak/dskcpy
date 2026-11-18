const cacheName = 'dskcpy-paired-computers-v1';
const assets = new Set(['/computers/', '/computers/computers.mjs', '/computers/computers-common.mjs', '/receiver.css']);

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([...assets])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', event => {
  const { origin, pathname, search } = new URL(event.request.url);
  if (event.request.method !== 'GET' || origin !== self.location.origin || search || !assets.has(pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(event.request);
      if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
      return response;
    } catch { return await cache.match(event.request) || Response.error(); }
  })());
});
