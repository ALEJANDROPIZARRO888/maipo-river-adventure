// Service worker de la app del equipo.
//  1. Deja abrir la app sin señal (solo la cáscara: HTML, estilos, código, íconos). Nunca guarda respuestas de /api:
//     los datos van siempre a la red, y la app conserva por su cuenta lo último que se vio.
//  2. Recibe los avisos push con la app cerrada y, al tocarlos, lleva a la pantalla que corresponde.
const CACHE = 'mra-app-v2';
const CASCARA = ['/app/', '/app/app.css', '/app/app.js', '/app/manifest.webmanifest', '/app/icon-192.png', '/app/apple-touch-icon.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(CASCARA)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.pathname.startsWith('/api/') || !u.pathname.startsWith('/app')) return;
  // Red primero (para recibir las actualizaciones al instante) y caché si no hay señal.
  e.respondWith(fetch(e.request).then(r => { if (r.ok) { const copia = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copia)); } return r; })
    .catch(() => caches.match(e.request).then(r => r || caches.match('/app/'))));
});

// ---- Avisos. Chrome exige mostrar una notificación por cada push, así que siempre se muestra;
// la app cierra las que sobran cuando se abre (así no se duplican con el aviso que ya ve en pantalla).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { t: 'Maipo River', b: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.t || 'Maipo River', {
    body: d.b || '', icon: '/app/icon-192.png', badge: '/app/icon-192.png',
    tag: d.g || undefined, renotify: !!d.g, vibrate: [120, 60, 120], data: { ruta: d.r || '' }
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const ruta = (e.notification.data && e.notification.data.ruta) || '';
  e.waitUntil((async () => {
    const abiertas = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const app = abiertas.find(c => c.url.includes('/app'));
    if (app) { await app.focus(); app.postMessage({ ruta }); return; }
    await self.clients.openWindow('/app/' + (ruta ? '#' + ruta : ''));
  })());
});
