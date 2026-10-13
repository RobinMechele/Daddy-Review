/* Daddy Review service worker: offline app shell + notification clicks. */
const VERSION = 'daddy-v1';
const SHELL = [
  '/',
  '/styles.css',
  '/js/app.js',
  '/js/api.js',
  '/js/util.js',
  '/js/views.js',
  '/js/effects.js',
  '/js/pip.js',
  '/manifest.webmanifest',
  '/icons/icon.svg',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/badge-72.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (the server is local, so it's instant); the cache only kicks in
// when the Daddy Review service isn't running, so the app can say so nicely.
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.searchParams.has('code') || url.searchParams.has('error')) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok && SHELL.includes(url.pathname)) {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(url.pathname, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(url.pathname)) || (await caches.match('/')) || Response.error()),
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  if (e.action === 'snooze' && data.key) {
    e.waitUntil(
      fetch('/api/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Daddy-Review': '1' },
        body: JSON.stringify({ key: data.key, hours: 1 }),
      })
        .then(() => self.clients.matchAll({ type: 'window' }))
        .then((all) => all.forEach((c) => c.postMessage({ type: 'refresh' })))
        .catch(() => {}),
    );
    return;
  }
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) c.postMessage({ type: 'opened', key: data.key });
    const url = data.url || '/';
    if (/^https?:/i.test(url) && !url.startsWith(self.location.origin)) return self.clients.openWindow(url);
    const app = all.find((c) => c.url.startsWith(self.location.origin));
    if (app) return app.focus();
    return self.clients.openWindow('/');
  })());
});
