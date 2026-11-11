/*
 * Offline storage for feature data (IndexedDB) and tile prefetching.
 *
 * Every feature the app loads while online is stored, so any area you've
 * browsed works without signal. "Save this area" bulk-loads a whole view —
 * all layers plus USGS topo and canopy-loss tiles — before you head out.
 */
(function () {
  const DB_NAME = 'grouse-offline';
  let dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        const d = req.result;
        const fs = d.createObjectStore('features', { keyPath: 'key' });
        fs.createIndex('layer', 'layer');
        d.createObjectStore('areas', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbp;
  }
  const done = (tx) => new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  const reqP = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

  function geomBBox(g) {
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    (function walk(c) {
      if (typeof c[0] === 'number') { w = Math.min(w, c[0]); e = Math.max(e, c[0]); s = Math.min(s, c[1]); n = Math.max(n, c[1]); return; }
      c.forEach(walk);
    })(g && g.coordinates ? g.coordinates : []);
    return [w, s, e, n];
  }

  const OfflineStore = {
    available: typeof indexedDB !== 'undefined',

    /** Store features for a layer. Copies are made synchronously (Leaflet adds circular refs later). */
    async put(layer, feats) {
      if (!this.available || !feats.length) return;
      const rows = feats.map((f) => ({
        key: layer + '|' + f._id, layer, bbox: geomBBox(f.geometry),
        f: { type: 'Feature', id: f.id, _id: f._id, properties: f.properties, geometry: f.geometry },
      }));
      try {
        const tx = (await db()).transaction('features', 'readwrite');
        const st = tx.objectStore('features');
        rows.forEach((r) => st.put(r));
        await done(tx);
      } catch (err) { console.warn('offline store failed', err); }
    },

    /** Features for a layer intersecting bounds (L.LatLngBounds), or all if bounds is null. */
    async query(layer, bounds) {
      if (!this.available) return [];
      try {
        const st = (await db()).transaction('features').objectStore('features');
        const rows = await reqP(st.index('layer').getAll(layer));
        const hit = bounds
          ? rows.filter((r) => !(r.bbox[0] > bounds.getEast() || r.bbox[2] < bounds.getWest() || r.bbox[1] > bounds.getNorth() || r.bbox[3] < bounds.getSouth()))
          : rows;
        return hit.map((r) => r.f);
      } catch (err) { console.warn('offline query failed', err); return []; }
    },

    async count() {
      if (!this.available) return 0;
      try { return await reqP((await db()).transaction('features').objectStore('features').count()); } catch { return 0; }
    },

    async saveAreaRecord(area) {
      const tx = (await db()).transaction('areas', 'readwrite');
      tx.objectStore('areas').put(area);
      await done(tx);
    },
    async areas() {
      if (!this.available) return [];
      try { return await reqP((await db()).transaction('areas').objectStore('areas').getAll()); } catch { return []; }
    },
    async deleteArea(id) {
      const tx = (await db()).transaction('areas', 'readwrite');
      tx.objectStore('areas').delete(id);
      await done(tx);
    },

    async clearAll() {
      try {
        const tx = (await db()).transaction(['features', 'areas'], 'readwrite');
        tx.objectStore('features').clear(); tx.objectStore('areas').clear();
        await done(tx);
      } catch (err) { console.warn(err); }
      if (window.caches) await caches.delete('grouse-tiles');
    },
  };

  // --- Tiles -----------------------------------------------------------------
  const lon2x = (lng, z) => Math.floor(((lng + 180) / 360) * 2 ** z);
  const lat2y = (lat, z) => {
    const r = (lat * Math.PI) / 180;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
  };

  /** List tile URLs for bounds over a zoom range. template uses {z} {x} {y}. */
  function tileUrls(template, bounds, zMin, zMax) {
    const out = [];
    for (let z = zMin; z <= zMax; z++) {
      const x0 = lon2x(bounds.getWest(), z), x1 = lon2x(bounds.getEast(), z);
      const y0 = lat2y(bounds.getNorth(), z), y1 = lat2y(bounds.getSouth(), z);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++)
        out.push(template.replace('{z}', z).replace('{x}', x).replace('{y}', y));
    }
    return out;
  }

  /** Fetch URLs through the service worker (which caches them). Skips ones already cached. */
  async function prefetch(urls, onProgress, concurrency = 8) {
    const cache = window.caches ? await caches.open('grouse-tiles') : null;
    let i = 0, ok = 0, fail = 0, skipped = 0;
    async function worker() {
      while (i < urls.length) {
        const u = urls[i++];
        try {
          if (cache && (await cache.match(u))) { skipped++; }
          else {
            const r = await fetch(u, { mode: 'cors', credentials: 'omit' });
            if (r.ok) { ok++; if (cache && !(await cache.match(u))) await cache.put(u, r); } else fail++;
          }
        } catch { fail++; }
        onProgress && onProgress(ok + skipped + fail, urls.length);
      }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { ok, fail, skipped };
  }

  async function storageInfo() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    const { usage, quota } = await navigator.storage.estimate();
    return { usageMB: usage / 1048576, quotaMB: quota / 1048576 };
  }
  async function requestPersistence() {
    try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; } catch { return false; }
  }

  window.OfflineStore = OfflineStore;
  window.OfflineTiles = { tileUrls, prefetch, storageInfo, requestPersistence };
})();
