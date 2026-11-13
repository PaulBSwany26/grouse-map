/*
 * Service worker: makes the app installable and usable with no signal.
 *  - App shell (HTML/JS/CSS/libraries): served from the copy saved for this VERSION, so a page never
 *    mixes files from two releases. A new release downloads in full, then shows on the next open.
 *  - Other same-origin files (the weekly data file): network-first, saved copy after 3 s.
 *  - Map tiles: cache-first. Tiles you've viewed, or saved with "Save this area", work offline.
 *  - Feature data (stands, sales, land…) is stored by the app itself in IndexedDB, not here.
 * Bump VERSION whenever app files change so phones pick up the update.
 */
const VERSION = 'v11-d20261113';
const SHELL = `grouse-shell-${VERSION}`;
const TILES = 'grouse-tiles';

const SHELL_FILES = [
  './', './index.html', './app.js', './habitat.js', './offline.js', './loss.js', './hotspots.js', './manifest.webmanifest',
  './icon-192.png', './icon-512.png', './apple-touch-icon.png',
  './vendor/leaflet.js', './vendor/leaflet.css', './vendor/togeojson.js', './vendor/maplibre-gl.js', './vendor/maplibre-gl.css',
];
const PRECACHED = new Set(SHELL_FILES.map((u) => new URL(u, self.location).href));
const DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname); // always fresh files while developing

const TILE_HOSTS = ['basemap.nationalmap.gov', 'server.arcgisonline.com', 'tile.opentopomap.org', 'tiles.globalforestwatch.org', 'tiles.openfreemap.org'];
// The vector-map host also serves its style and an address file that points at a dated tile
// folder which changes weekly. Those must stay fresh; only real tiles are kept forever.
const isMapMeta = (url) => url.hostname === 'tiles.openfreemap.org' && !/\.(pbf|png)$/.test(url.pathname);
const isTile = (url) => !isMapMeta(url) && TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES.map((u) => new Request(u, { cache: 'reload' })))));
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('grouse-shell-') && k !== SHELL) await caches.delete(k);
    // Older versions kept the vector map's style and address files forever: drop those copies.
    const tiles = await caches.open(TILES);
    for (const r of await tiles.keys()) if (isMapMeta(new URL(r.url))) await tiles.delete(r);
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
  if (url.origin === self.location.origin || isMapMeta(url)) e.respondWith(shell(req, url));
});

const shellKey = (req, url) => (url.origin === self.location.origin && url.pathname.endsWith('/') ? new URL('./', self.location).href : req.url);
async function shell(req, url) {
  const key = shellKey(req, url);
  if (!DEV && PRECACHED.has(key.split('?')[0])) {
    const hit = await (await caches.open(SHELL)).match(key, { ignoreSearch: true });
    if (hit) return hit;
  }
  return shellFirst(req, url);
}

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
  const key = shellKey(req, url);
  const net = fetch(req, { cache: 'no-cache' }).then((res) => { if (res.ok) cache.put(key, res.clone()); return res; }).catch(() => null);
  const timeout = new Promise((r) => setTimeout(() => r(null), 3000));
  const first = await Promise.race([net, timeout]);
  if (first) return first;
  const hit = await cache.match(key, { ignoreSearch: true });
  return hit || (await net) || new Response('Offline', { status: 503 });
}
