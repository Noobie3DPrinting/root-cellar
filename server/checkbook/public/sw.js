// Service worker for the web app: keeps the screens on the device so Checkbook still opens when the server is down.
// The data itself lives in this device's offline copy (sync.js); /api requests always go to the network.
const CACHE = 'root-cellar-checkbook-v1';
const V = '?v=1.0.0';
const SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png', '/icons/icon-512.png',
  '/styles.css' + V, '/theme.js' + V, '/native-config.js' + V, '/sync.js' + V, '/app.js' + V, '/bills.js' + V];
self.addEventListener('install', e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
const fromCache = req => caches.match(req).then(m => m || (req.mode === 'navigate' ? caches.match('/index.html') : undefined));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first (so updates show up), but give up after 4 s or on a server error and use the saved copy.
  e.respondWith(new Promise(resolve => {
    let done = false;
    const fallback = () => { if (done) return; done = true; fromCache(e.request).then(m => resolve(m || Response.error())); };
    const timer = setTimeout(fallback, 4000);
    fetch(e.request, /\.(js|css|html)(\?|$)|\/$/.test(url.pathname + url.search) ? { cache: 'no-cache' } : undefined).then(r => {
      clearTimeout(timer);
      if (!r.ok) return fallback();
      const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy));
      if (!done) { done = true; resolve(r); }
    }).catch(() => { clearTimeout(timer); fallback(); });
  }));
});
