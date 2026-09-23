const V = 'land-v3';
const SHELL = ['./','index.html','style.css','app.js','airports.json','manifest.webmanifest','icon.svg','icon-192.png','icon-512.png'];
self.addEventListener('install', e => { e.waitUntil(caches.open(V).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k!==V).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (u.origin !== location.origin) return; // API calls go straight to network
  // Stale-while-revalidate for the app shell
  e.respondWith(caches.open(V).then(async c => {
    const hit = await c.match(e.request, {ignoreSearch:true});
    const net = fetch(e.request).then(r => { if (r.ok) c.put(e.request, r.clone()); return r; }).catch(() => hit);
    return hit || net;
  }));
});
