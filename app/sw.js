// Service worker de la app del equipo: deja abrir la app sin señal (solo la cáscara: HTML, íconos, manifiesto).
// Nunca guarda respuestas de /api: los datos van siempre a la red, y la app conserva por su cuenta lo último que se vio.
const CACHE = 'mra-app-v1';
const CASCARA = ['/app/', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCARA)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/')) return;
  if (!u.pathname.startsWith('/app')) return;
  // Red primero (para recibir las actualizaciones al instante) y caché si no hay señal.
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/app/'))));
});
