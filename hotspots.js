/*
 * Statewide hotspots for zoomed-out views (below zoom 13).
 *
 * Loads data/summary.json (built weekly by tools/build_summary.py): one row per DNR stand
 * and USFS cut with cover group, age, stocking, acres and neighbor flags. Rows are scored
 * in the browser with habitat.js and the current weights, then drawn as a grid of cells:
 * color = best score in the cell, opacity = how many acres of qualifying cover it holds.
 */
(function () {
  const H = window.Habitat;
  const CELL = 10; // px
  let data = null, rows = null, buckets = null, layer = null, map = null, getState = null;

  const RAMP = ['#fff1a8', '#ffc95c', '#f2913d', '#d9482b', '#8c1018'];
  const rampColor = (s) => (s < 35 ? RAMP[0] : s < 50 ? RAMP[1] : s < 65 ? RAMP[2] : s < 80 ? RAMP[3] : RAMP[4]);
  const STOCK = [null, 'well', 'medium', 'poor'];
  const COVER_LABEL = {
    aspen: 'Aspen', lowAspen: 'Lowland aspen', birch: 'Paper birch', mixed: 'Mixed deciduous', hardwood: 'Northern hardwood',
    oak: 'Oak', alder: 'Alder (lowland shrub)', shrub: 'Upland shrub', lowDecid: 'Lowland deciduous', conifer: 'Conifer',
    pine: 'Pine', open: 'Opening', usfsRegen: 'USFS regeneration cut', usfsPartial: 'USFS partial cut',
  };

  function scoreAll() {
    if (!rows) return;
    const season = getState().season;
    for (const r of rows) r.score = H.score(r, r.flags, season).score;
  }

  async function load() {
    try {
      const res = await fetch('data/summary.json', { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      data = await res.json();
    } catch (e) { console.warn('hotspot summary unavailable', e); return false; }
    const n = data.count, groups = data.groups, shift = H.NOW_YEAR - data.year; // ages advance each new year
    rows = new Array(n);
    buckets = new Map();
    for (let i = 0; i < n; i++) {
      const group = groups[data.g[i]];
      const m = data.m[i];
      const r = {
        lat: data.lat[i] / 1e4, lng: data.lng[i] / 1e4, group, cover: COVER_LABEL[group] || group,
        age: data.age[i] < 0 ? null : data.age[i] + shift, stock: STOCK[data.st[i]], acres: data.ac[i],
        flags: data.f[i], lowland: !!(m & 1), transition: !!(m & 2), sale: !!(m & 4), score: 0,
      };
      rows[i] = r;
      const key = Math.floor(r.lng * 4) + ',' + Math.floor(r.lat * 4); // 0.25° buckets
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key).push(r);
    }
    scoreAll();
    return true;
  }

  // Color breaks per zoom = statewide percentiles of cell values (50/75/90/97%), so the
  // darkest squares are always the top ~3% of the state at that zoom.
  let breaksCache = {};
  function cellAcresAt(z, lat) {
    const mPerPx = (40075016 * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, z));
    return Math.pow(CELL * mPerPx, 2) / 4046.86;
  }
  function cellKey(r, z) { const p = map.project([r.lat, r.lng], z); return Math.floor(p.x / CELL) + ',' + Math.floor(p.y / CELL); }
  function breaks(z) {
    const min = Math.max(getState().minScore, 20), key = z + ':' + min;
    if (breaksCache[key]) return breaksCache[key];
    const cells = new Map();
    for (const r of rows) if (r.score >= min) { const k = cellKey(r, z); cells.set(k, (cells.get(k) || 0) + r.acres * Math.pow(r.score / 100, 2)); }
    const ca = cellAcresAt(z, 44.8);
    const v = [...cells.values()].map((a) => a / ca).sort((a, b) => a - b);
    const q = (f) => (v.length ? v[Math.floor(f * (v.length - 1))] : 1);
    return (breaksCache[key] = [q(0.5), q(0.75), q(0.9), q(0.97)]);
  }

  function rowsIn(b) {
    const out = [];
    for (let x = Math.floor(b.getWest() * 4); x <= Math.floor(b.getEast() * 4); x++)
      for (let y = Math.floor(b.getSouth() * 4); y <= Math.floor(b.getNorth() * 4); y++)
        for (const r of buckets.get(x + ',' + y) || []) if (b.contains([r.lat, r.lng])) out.push(r);
    return out;
  }

  function makeLayer() {
    const Grid = L.GridLayer.extend({
      createTile(coords) {
        const tile = document.createElement('canvas');
        const size = this.getTileSize();
        tile.width = size.x; tile.height = size.y;
        if (!rows) return tile;
        const ctx = tile.getContext('2d');
        const nw = map.unproject([coords.x * size.x, coords.y * size.y], coords.z);
        const se = map.unproject([(coords.x + 1) * size.x, (coords.y + 1) * size.y], coords.z);
        const b = L.latLngBounds(se, nw).pad(0.02);
        const min = Math.max(getState().minScore, 20);
        const cells = new Map();
        for (const r of rowsIn(b)) {
          if (r.score < min) continue;
          const p = map.project([r.lat, r.lng], coords.z);
          const cx = Math.floor((p.x - coords.x * size.x) / CELL), cy = Math.floor((p.y - coords.y * size.y) / CELL);
          const k = cx + ',' + cy;
          // acres of good cover, weighted toward the best stands
          cells.set(k, (cells.get(k) || 0) + r.acres * Math.pow(r.score / 100, 2));
        }
        // Color = share of the cell's land that is good cover, so dense clusters stand out
        // from squares that merely contain one good stand.
        const cellAcres = cellAcresAt(coords.z, (nw.lat + se.lat) / 2);
        const br = breaks(coords.z);
        for (const [k, acres] of cells) {
          const [cx, cy] = k.split(',').map(Number);
          const share = acres / cellAcres;
          const cls = share < br[0] ? 0 : share < br[1] ? 1 : share < br[2] ? 2 : share < br[3] ? 3 : 4;
          ctx.globalAlpha = 0.45 + cls * 0.12;
          ctx.fillStyle = RAMP[cls];
          ctx.fillRect(cx * CELL, cy * CELL, CELL - 1, CELL - 1);
        }
        return tile;
      },
    });
    return new Grid({ pane: 'habitat', maxZoom: 12, minZoom: 5, tileSize: 256, updateWhenZooming: false });
  }

  window.Hotspots = {
    async init(m, stateFn) {
      map = m; getState = stateFn;
      const ok = await load();
      if (!ok) return false;
      layer = makeLayer();
      layer.addTo(map);
      map.on('click', (e) => {
        if (map.getZoom() >= 13 || !layer || !map.hasLayer(layer)) return;
        // click a hotspot cell → zoom in to where stands load
        const near = rowsIn(L.latLngBounds([e.latlng.lat - 0.02, e.latlng.lng - 0.03], [e.latlng.lat + 0.02, e.latlng.lng + 0.03]))
          .filter((r) => r.score >= getState().minScore);
        if (near.length) map.setView(e.latlng, 13);
      });
      return true;
    },
    setVisible(on) { if (!layer) return; if (on) layer.addTo(map); else map.removeLayer(layer); },
    redraw() { if (!rows) return; scoreAll(); breaksCache = {}; if (layer) layer.redraw(); },
    top(bounds, limit, min) {
      if (!rows) return [];
      return rowsIn(bounds).filter((r) => r.score >= min).sort((a, b) => b.score - a.score || b.acres - a.acres).slice(0, limit);
    },
    info() { return data ? { generated: data.generated, count: data.count } : null; },
    get loaded() { return !!rows; },
  };
})();
