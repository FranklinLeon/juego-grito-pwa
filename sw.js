/* Service worker: deja la app funcionando SIN internet una vez instalada.
   Si cambias archivos, sube el numero de VERSION para forzar la actualizacion. */

const VERSION = 'grito-v21';
const ARCHIVOS = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './marca/mirasol.png',
  './marca/proauto.png',
  './marca/emaulme.png',
  './marca/gritalo.png',
  './marca/boca.png',
  './marca/lineas-izq.png',
  './marca/lineas-der.png',
  './marca/eslogan.png',
  './marca/premio-verde.png',
  './marca/premio-sorpresa.png',
  './marca/premio-gran.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(ARCHIVOS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/* RED PRIMERO: siempre intenta traer lo ultimo de internet y guarda una
   copia fresca en cache. Solo si NO hay conexion sirve lo ultimo cacheado.
   Antes era "cache primero", y por eso las tablets se quedaban pegadas en
   la version vieja aunque hubiera una nueva publicada. */
self.addEventListener('fetch', (e) => {
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== self.location.origin) return;   // no tocar recursos externos
  e.respondWith(
    fetch(e.request)
      .then(res => {
        if(res && res.ok){
          const copia = res.clone();
          caches.open(VERSION).then(c => c.put(e.request, copia));
        }
        return res;
      })
      .catch(() => caches.match(e.request).then(hit => hit || caches.match('./index.html')))
  );
});
