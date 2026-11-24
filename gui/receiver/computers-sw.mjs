const cacheName = 'dskcpy-paired-computers-v2';
const assets = new Set(['/computers/', '/computers/computers.mjs', '/computers/computers-common.mjs',
  '/computers/manifest.webmanifest', '/computers/icon-192.png', '/computers/icon-512.png', '/receiver.css']);
const assetRequest = path => new Request(new URL(path, self.location.origin),
  { credentials: 'omit', redirect: 'error', cache: 'reload' });

self.addEventListener('install', event => {
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([...assets].map(assetRequest))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.delete('dskcpy-paired-computers-v1').then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const { origin, pathname, search } = new URL(event.request.url);
  if (event.request.method !== 'GET' || origin !== self.location.origin || search || !assets.has(pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(cacheName);
    try {
      const response = await fetch(assetRequest(pathname));
      if (response.ok) await cache.put(event.request, response.clone()).catch(() => {});
      return response;
    } catch { return await cache.match(event.request) || Response.error(); }
  })());
});
