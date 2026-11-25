// directoryShell is provided by the host from this worker and the static assets.
const cachePrefix = 'dskcpy-paired-computers-';
const cacheName = cachePrefix + directoryShell.version;
const assets = new Map(directoryShell.entries);
const assetRequest = path => new Request(new URL(path, self.location.origin), {
  credentials: 'omit', redirect: 'error', cache: 'reload', integrity: assets.get(path),
});

self.addEventListener('install', event => {
  // Wait for existing directory tabs to close before activating a new shell.
  // Integrity checks keep a partially deployed or restarted host from mixing versions.
  event.waitUntil(caches.open(cacheName).then(cache => cache.addAll([...assets.keys()].map(assetRequest))).catch(async error => {
    await caches.delete(cacheName).catch(() => {});
    throw error;
  }));
});
self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name.startsWith(cachePrefix) && name !== cacheName).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});
self.addEventListener('fetch', event => {
  const { origin, pathname, search } = new URL(event.request.url);
  if (event.request.method !== 'GET' || origin !== self.location.origin || search || !assets.has(pathname)) return;
  event.respondWith((async () => {
    const request = assetRequest(pathname);
    const cached = await caches.match(request, { cacheName });
    return cached || fetch(request);
  })());
});
