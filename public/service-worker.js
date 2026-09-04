// Despacho — service worker
//
// Registered from a real, stable URL (/service-worker.js), not a Blob.
// Blob-registered service workers are rejected by Chrome and Firefox per
// spec, so the previous inline version never actually installed — this
// replaces it with one that works, and gives Android a real PWA to
// install (icon + full-screen + offline shell).
//
// Caching strategy: network-first, falling back to cache when offline.
// /api/ requests are NEVER cached — they're dynamic (order status, live
// location, etc.) and serving a stale cached response would be actively
// wrong, not just outdated. Only the app shell (HTML/CSS/JS/fonts/icons)
// benefits from a cache fallback.

const CACHE = 'despacho-cache-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) =>
      Promise.all(names.filter((n) => n !== CACHE).map((n) => caches.delete(n)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.pathname.startsWith('/api/')) return; // never cache API calls

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req))
  );
});

// ---------- Push notifications (wired up in the next step) ----------
// Left here as a stub so the service worker doesn't need to be
// re-registered again once push is added — the browser only needs to
// see a new file version, not a new registration.
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload = {};
  try { payload = event.data.json(); } catch (e) { payload = { title: 'Despacho', body: event.data.text() }; }
  event.waitUntil(
    self.registration.showNotification(payload.title || 'Despacho', {
      body: payload.body || '',
      icon: '/icon.svg',
      badge: '/icon.svg',
      data: payload.data || {}
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then((clients) => {
      for (const c of clients) {
        if (c.url.includes('/entregas.html') && 'focus' in c) return c.focus();
      }
      if (self.clients.openWindow) return self.clients.openWindow('/entregas.html');
    })
  );
});
