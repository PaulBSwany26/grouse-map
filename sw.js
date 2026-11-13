/*
 * Service worker: makes the app installable and usable with no signal.
 *  - App shell (HTML/JS/CSS/libraries): network-first, cached copy if no signal within 3 s.
 *  - Map tiles: cache-first. Tiles you've viewed, or saved with "Save this area", work offline.
 *  - Feature data (stands, sales, land…) is stored by the app itself in IndexedDB, not here.
 * Bump VERSION whenever app files change so phones pick up the update.
 */
const VERSION = 'v10';
const SHELL = `grouse-shell-${VERSION}`;
const TILES = 'grouse-tiles';

const SHELL_FILES = [
  './', './index.html', './app.js', './habitat.js', './offline.js', './loss.js', './hotspots.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.js',
  'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.css',
  'https://unpkg.com/@mapbox/togeojson@0.16.2/togeojson.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.js',
  'https://unpkg.com/maplibre-gl@4.7.1/dist/maplibre-gl.css',
];

const TILE_HOSTS = ['basemap.nationalmap.gov', 'server.arcgisonline.com', 'tile.opentopomap.org', 'tiles.globalforestwatch.org', 'tiles.openfreemap.org'];
const isTile = (url) => TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { mode: 'cors', credentials: 'omit' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('grouse-shell-') && k !== SHELL) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (isTile(url)) {
    e.respondWith(tileFirst(req));
    return;
  }
  const isShell = url.origin === self.location.origin || SHELL_FILES.includes(req.url);
  if (isShell) e.respondWith(shellFirst(req, url));
});

async function tileFirst(req) {
  const cache = await caches.open(TILES);
  const hit = await cache.match(req.url);
  if (hit) return hit;
  try {
    // Re-request with CORS so the cached copy isn't an opaque (size-padded) response.
    const res = await fetch(req.url, { mode: 'cors', credentials: 'omit' });
    if (res.ok) cache.put(req.url, res.clone());
    return res;
  } catch (err) {
    return new Response('', { status: 504, statusText: 'offline' });
  }
}

// Network-first (so updates arrive whenever there's signal), falling back to the
// cached copy after 3 s or on failure — weak field signal shouldn't hang the app.
async function shellFirst(req, url) {
  const cache = await caches.open(SHELL);
  const key = url.origin === self.location.origin && url.pathname.endsWith('/') ? new URL('./', self.location).href : req.url;
  const net = fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
  const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
  const first = await Promise.race([net, timeout]);
  if (first) return first;
  const hit = await cache.match(key, { ignoreSearch: true });
  return hit || (await net) || new Response('Offline', { status: 503 });
}
