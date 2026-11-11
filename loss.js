/*
 * Satellite canopy loss (Hansen / UMD Global Forest Change via Global Forest Watch tiles).
 *
 * Each tile pixel stores the loss year in its blue channel (year − 2000), ~30 m data,
 * updated annually (currently through LossRaster.lastYear). We use it two ways:
 *   1. LossRaster.analyze(stands): measure the share of each stand that lost canopy and the
 *      most common loss year → a real "when was this cut" date (see app.js effectiveAge).
 *   2. LossRaster.layer(): a map overlay colored by how long ago the cut happened.
 */
(function () {
  const Z = 12; // GFW native zoom; tiles come back 512 px (≈14 m/px in Michigan)
  const PX = 512;
  const URL = (x, y) => `https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/${Z}/${x}/${y}.png?tree_cover_density_threshold=30`;
  const NOW = new Date().getFullYear();
  const tiles = new Map(); // "x/y" → Promise<Uint8Array|null> (year offsets, 0 = no loss)

  function loadTile(x, y) {
    const key = x + '/' + y;
    if (tiles.has(key)) return tiles.get(key);
    const p = new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const c = document.createElement('canvas'); c.width = PX; c.height = PX;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, PX, PX);
          const d = ctx.getImageData(0, 0, PX, PX).data;
          const out = new Uint8Array(PX * PX);
          let maxY = 0;
          for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            if (d[i + 3] > 0 && d[i] === 255) { out[j] = d[i + 2]; if (d[i + 2] > maxY) maxY = d[i + 2]; }
          }
          if (maxY > api.lastYear - 2000) api.lastYear = 2000 + maxY;
          resolve(out);
        } catch (e) { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = URL(x, y);
    });
    tiles.set(key, p);
    return p;
  }

  // global pixel coords at Z (PX-sized tiles)
  const N = Math.pow(2, Z) * PX;
  const toPx = (lng, lat) => {
    const r = (lat * Math.PI) / 180;
    return [((lng + 180) / 360) * N, ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * N];
  };
  const toLngLat = (px, py) => [(px / N) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * py) / N))) * 180) / Math.PI];

  function inRing(x, y, ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function polys(g) { return g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : []; }

  async function statsFor(geom) {
    const ps = polys(geom);
    if (!ps.length) return null;
    let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
    for (const p of ps) for (const [x, y] of p[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
    const [x0, y0] = toPx(w, n), [x1, y1] = toPx(e, s);
    const need = new Set();
    for (let tx = Math.floor(x0 / PX); tx <= Math.floor(x1 / PX); tx++)
      for (let ty = Math.floor(y0 / PX); ty <= Math.floor(y1 / PX); ty++) need.add(tx + '/' + ty);
    const data = {};
    for (const k of need) { const [tx, ty] = k.split('/').map(Number); data[k] = await loadTile(tx, ty); }
    let total = 0, lost = 0;
    const hist = {};
    for (let py = Math.floor(y0); py <= Math.ceil(y1); py++) {
      for (let px = Math.floor(x0); px <= Math.ceil(x1); px++) {
        const [lng, lat] = toLngLat(px + 0.5, py + 0.5);
        if (!ps.some((p) => inRing(lng, lat, p[0]) && !p.slice(1).some((h) => inRing(lng, lat, h)))) continue;
        total++;
        const t = data[Math.floor(px / PX) + '/' + Math.floor(py / PX)];
        if (!t) continue;
        const v = t[(py % PX) * PX + (px % PX)];
        if (v > 0) { lost++; hist[v] = (hist[v] || 0) + 1; }
      }
    }
    if (!total) return null;
    // most recent year that covers a meaningful share (≥10% of stand), else the modal year
    let year = null, best = 0;
    for (const [k, c] of Object.entries(hist)) if (c > best) { best = c; year = 2000 + +k; }
    const recent = Object.entries(hist).map(([k, c]) => [2000 + +k, c]).filter(([, c]) => c / total >= 0.1).sort((a, b) => b[0] - a[0])[0];
    if (recent) year = recent[0];
    // share of stand cut in that year or the year either side (cuts often span two seasons)
    let near = 0;
    for (const [k, c] of Object.entries(hist)) if (Math.abs(2000 + +k - year) <= 1) near += c;
    return { frac: year ? near / total : 0, year, pixels: total, anyFrac: lost / total };
  }

  const api = {
    lastYear: 2025,
    /** Measure loss for stand records (needs rec.feature.geometry); sets rec.loss; calls done() once. */
    analyze(recs, done) {
      const queue = recs.filter((r) => r && r.feature && !r.lossDone);
      if (!queue.length) return;
      let i = 0;
      const step = async () => {
        const t0 = performance.now();
        while (i < queue.length && performance.now() - t0 < 30) {
          const r = queue[i++];
          r.lossDone = true;
          try { r.loss = await statsFor(r.feature.geometry); } catch (e) { r.loss = null; }
        }
        if (i < queue.length) setTimeout(step, 0); else done && done();
      };
      step();
    },
    /** Overlay: red = cut in the last 3 years (no cover yet); teal = 4–20 years ago (grouse regrowth). */
    layer(opts) {
      const Layer = L.GridLayer.extend({
        createTile(coords, cb) {
          const c = document.createElement('canvas');
          c.width = PX; c.height = PX; c.style.width = '256px'; c.style.height = '256px';
          if (coords.z !== Z) { cb(null, c); return c; } // only drawn at native zoom (Leaflet scales it)
          loadTile(coords.x, coords.y).then((t) => {
            if (t) {
              const ctx = c.getContext('2d');
              const img = ctx.createImageData(PX, PX);
              const d = img.data;
              for (let j = 0; j < t.length; j++) {
                const v = t[j]; if (!v) continue;
                const age = NOW - (2000 + v);
                let rgb = null;
                if (age <= 3) rgb = [198, 40, 40]; else if (age <= 20) rgb = [0, 151, 167];
                if (!rgb) continue;
                const k = j * 4; d[k] = rgb[0]; d[k + 1] = rgb[1]; d[k + 2] = rgb[2]; d[k + 3] = 200;
              }
              ctx.putImageData(img, 0, 0);
            }
            cb(null, c);
          });
          return c;
        },
      });
      return new Layer(Object.assign({ minNativeZoom: Z, maxNativeZoom: Z, minZoom: 9, maxZoom: 19, tileSize: 256,
        attribution: 'Forest loss: Hansen/UMD/Google/USGS/NASA via Global Forest Watch' }, opts));
    },
  };
  window.LossRaster = api;
})();
