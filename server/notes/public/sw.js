// Offline shell: the app opens even with no connection (or the server down); notes come from the device's saved copy.
const CACHE = 'root-cellar-notes-v1';
const SHELL = ['/', '/index.html', '/style.css', '/app.js', '/native-config.js', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/icon-512.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
const fromCache = (req) => caches.match(req).then((r) => r || caches.match('/index.html'));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // network first so updates show right away; use the saved copy if the server is unreachable, errors, or takes over 4 s
  e.respondWith(new Promise((resolve) => {
    let done = false;
    const fallback = () => { if (done) return; done = true; fromCache(e.request).then((m) => resolve(m || Response.error())); };
    const timer = setTimeout(fallback, 4000);
    fetch(e.request).then((r) => {
      clearTimeout(timer);
      if (!r.ok) return fallback();
      const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy));
      if (!done) { done = true; resolve(r); }
    }).catch(() => { clearTimeout(timer); fallback(); });
  }));
});
