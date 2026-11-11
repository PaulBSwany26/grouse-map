/*
 * Statewide hotspots for zoomed-out views (below zoom 13).
 *
 * Loads data/summary.json (built weekly by tools/build_summary.py): one row per DNR stand
 * and USFS cut with cover group, age, stocking, acres and neighbor flags. Rows are scored
 * in the browser with habitat.js and the current weights, then drawn one of two ways:
 *   3d   — a tilted map with a column per grid cell. Height = how much of the cell is good
 *          cover (acres weighted toward the best stands); color = acre-weighted average score.
 *   flat — a grid of squares colored by statewide percentile of the same measure.
 */
(function () {
  const H = window.Habitat;
  const CELL = 10; // px, flat grid
  const CELL3 = 24, GAP3 = 7, HMAX = 110; // px at the matching Leaflet zoom: column grid / gap / tallest column
  let data = null, rows = null, buckets = null, layer = null, map = null, getState = null;
  let flat = null, mode = '3d', visible = true;

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
  function cellAcresAt(z, lat, cell = CELL) {
    const mPerPx = (40075016 * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, z));
    return Math.pow(cell * mPerPx, 2) / 4046.86;
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

  // ---- Columns ---------------------------------------------------------------------------
  // One statewide aggregation per zoom (cells are fixed to the map, so panning never
  // reshuffles them). Height follows the share of the cell that is good cover; full height is
  // the 99th percentile cell at that zoom. The 1.4 power keeps ordinary cells low so the
  // real concentrations stand clear of them.
  let aggCache = {};
  function aggregate(z) {
    const min = Math.max(getState().minScore, 20), key = z + ':' + min;
    if (aggCache[key]) return aggCache[key];
    const cells = new Map();
    for (const r of rows) {
      if (r.score < min || !(r.acres > 0)) continue;
      const p = map.project([r.lat, r.lng], z);
      const cx = Math.floor(p.x / CELL3), cy = Math.floor(p.y / CELL3), k = cx + ',' + cy;
      let c = cells.get(k);
      if (!c) cells.set(k, (c = { cx, cy, w: 0, acres: 0, sw: 0, slat: 0, slng: 0, best: 0, n: 0 }));
      const w = r.acres * Math.pow(r.score / 100, 2);
      c.w += w; c.acres += r.acres; c.sw += r.score * r.acres; c.slat += r.lat * w; c.slng += r.lng * w; c.n++;
      if (r.score > c.best) c.best = r.score;
    }
    const list = [...cells.values()];
    for (const c of list) {
      c.lat = c.slat / c.w; c.lng = c.slng / c.w; c.mean = Math.round(c.sw / c.acres);
      c.share = c.w / cellAcresAt(z, c.lat, CELL3);
    }
    const v = list.map((c) => c.share).sort((a, b) => a - b);
    const norm = v.length ? v[Math.floor(0.99 * (v.length - 1))] : 1;
    for (const c of list) c.frac = Math.pow(Math.min(1, c.share / norm), 1.4);
    return (aggCache[key] = { list });
  }

  // ---- 3D view --------------------------------------------------------------------------
  // Zoomed out, a tilted MapLibre map sits over the Leaflet map and shows the cells as
  // real extruded columns. It hands back to Leaflet (flat, stand-level) at Leaflet zoom 13.
  // MapLibre zoom n shows what Leaflet shows at n + 1.
  const PITCH = 52, HANDOFF = 12;
  let gl = null, glEl = null, tip = null, glFailed = false, active = false, leaving = false, syncing = false;
  let builtKey = null, hoverId = null, getBasemap = null;

  function cellsGeoJSON(z) {
    const agg = aggregate(z);
    if (agg.geo) return agg.geo;
    const F = CELL3 - GAP3, o = GAP3 / 2, features = [];
    const ll = (x, y) => { const p = map.unproject([x, y], z); return [p.lng, p.lat]; };
    for (const c of agg.list) {
      const x = c.cx * CELL3 + o, y = c.cy * CELL3 + o;
      const mPerPx = (40075016 * Math.cos((c.lat * Math.PI) / 180)) / (256 * Math.pow(2, z));
      features.push({
        type: 'Feature', id: features.length,
        properties: { h: Math.max(1, c.frac * HMAX) * mPerPx, mean: c.mean, best: c.best, n: c.n, acres: Math.round(c.acres), lat: c.lat, lng: c.lng },
        geometry: { type: 'Polygon', coordinates: [[ll(x, y), ll(x + F, y), ll(x + F, y + F), ll(x, y + F), ll(x, y)]] },
      });
    }
    return (agg.geo = { type: 'FeatureCollection', features });
  }

  function glStyle() {
    const b = getBasemap();
    const tiles = b.url.includes('{s}') ? ['a', 'b', 'c'].map((s) => b.url.replace('{s}', s)) : [b.url];
    return {
      version: 8,
      sources: {
        base: { type: 'raster', tiles, tileSize: 256, maxzoom: b.maxzoom },
        cells: { type: 'geojson', data: { type: 'FeatureCollection', features: [] } },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#e6e5df' } },
        // the basemap steps back so the columns carry the picture
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': -0.6, 'raster-contrast': -0.1, 'raster-brightness-min': 0.06 } },
        { id: 'cells', type: 'fill-extrusion', source: 'cells', paint: {
          'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#1a1c1b',
            ['step', ['coalesce', ['get', 'mean'], 0], RAMP[0], 35, RAMP[1], 50, RAMP[2], 65, RAMP[3], 80, RAMP[4]]],
          'fill-extrusion-height': ['coalesce', ['get', 'h'], 0], 'fill-extrusion-opacity': 0.93,
        } },
      ],
    };
  }

  function buildCells() {
    if (!gl || !gl.getSource('cells')) return;
    const z = Math.max(5, Math.min(12, Math.round(gl.getZoom()) + 1));
    const key = z + ':' + Math.max(getState().minScore, 20);
    if (key === builtKey) return;
    builtKey = key; hoverId = null;
    gl.getSource('cells').setData(cellsGeoJSON(z));
  }

  function hideTip() {
    if (tip) tip.hidden = true;
    if (gl && hoverId != null) { gl.setFeatureState({ source: 'cells', id: hoverId }, { hover: false }); hoverId = null; }
    if (gl) gl.getCanvas().style.cursor = '';
  }

  function ensureGL() {
    if (gl) return true;
    if (glFailed || !window.maplibregl) return false;
    try {
      glEl = L.DomUtil.create('div', 'map3d', map.getContainer());
      L.DomEvent.disableClickPropagation(glEl); L.DomEvent.disableScrollPropagation(glEl);
      tip = L.DomUtil.create('div', 'hot-tip', map.getContainer());
      tip.hidden = true;
      const c = map.getCenter();
      gl = new maplibregl.Map({
        container: glEl, style: glStyle(), center: [c.lng, c.lat], zoom: map.getZoom() - 1, pitch: 0,
        minZoom: 4, maxZoom: HANDOFF + 0.6, maxPitch: 60, attributionControl: false, fadeDuration: 150,
        maxBounds: [[-95, 39.5], [-78, 50]], // the data is Michigan; a hard fling can't leave the Great Lakes
      });
    } catch (e) { console.warn('3D view unavailable', e); glFailed = true; if (glEl) glEl.remove(); gl = null; return false; }
    gl.on('load', buildCells);
    gl.on('error', (e) => console.warn('3D map:', e && e.error ? e.error.message || e.error : e));
    gl.on('styledata', () => { if (gl.getSource('cells') && builtKey == null) buildCells(); });
    gl.on('zoomend', buildCells);
    gl.on('zoom', () => { if (active && !leaving && gl.getZoom() >= HANDOFF) leave(true); });
    gl.on('moveend', () => { // keep Leaflet (lists, saved view, data loading) on the same spot
      if (!active || leaving) return;
      const p = gl.getCenter();
      syncing = true;
      map.setView([p.lat, p.lng], Math.max(5, Math.min(12, Math.round(gl.getZoom()) + 1)), { animate: false });
      syncing = false;
    });
    gl.on('mousemove', 'cells', (e) => {
      const f = e.features && e.features[0];
      if (!f || leaving) return;
      if (f.id !== hoverId) {
        if (hoverId != null) gl.setFeatureState({ source: 'cells', id: hoverId }, { hover: false });
        hoverId = f.id; gl.setFeatureState({ source: 'cells', id: hoverId }, { hover: true });
        const p = f.properties;
        tip.innerHTML = `<b>${p.acres.toLocaleString()} ac</b> of cover scoring ${Math.max(getState().minScore, 20)}+` +
          `<span>${p.n} stand${p.n === 1 ? '' : 's'} · average ${p.mean} · best ${p.best}</span>`;
      }
      gl.getCanvas().style.cursor = 'pointer';
      tip.hidden = false; tip.style.left = e.point.x + 'px'; tip.style.top = e.point.y - 14 + 'px';
    });
    gl.on('mouseleave', 'cells', hideTip);
    gl.on('movestart', () => { if (tip) tip.hidden = true; });
    gl.on('click', 'cells', (e) => { // tap a column → drop to the flat map over its good cover
      const p = e.features[0].properties;
      leave(true, { lng: p.lng, lat: p.lat });
    });
    return true;
  }

  function enter() {
    if (!ensureGL()) return false;
    const c = map.getCenter();
    active = true; leaving = false;
    gl.stop();
    gl.jumpTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1, pitch: 0, bearing: 0 });
    buildCells();
    glEl.classList.add('on'); map.getContainer().classList.add('is3d');
    gl.resize();
    gl.easeTo({ pitch: PITCH, duration: 800 });
    return true;
  }

  function leave(animated, target) {
    if (!active || leaving) return;
    hideTip();
    const done = () => { active = false; leaving = false; glEl.classList.remove('on'); map.getContainer().classList.remove('is3d'); };
    if (!animated) { gl.stop(); done(); return; }
    leaving = true;
    const c = target || gl.getCenter();
    gl.stop();
    gl.easeTo({ center: [c.lng, c.lat], zoom: HANDOFF, pitch: 0, bearing: 0, duration: 650 });
    gl.once('moveend', () => {
      syncing = true; map.setView([c.lat, c.lng], 13, { animate: false }); syncing = false;
      done(); sync();
    });
  }

  function sync() {
    if (!flat || syncing || leaving) return;
    const zoomedOut = map.getZoom() < 13;
    let want3d = visible && zoomedOut && mode === '3d';
    if (want3d && !active) want3d = enter();
    else if (!want3d && active) leave(false);
    const wantFlat = visible && zoomedOut && !want3d; // also the fallback when WebGL isn't there
    if (wantFlat && !map.hasLayer(flat)) flat.addTo(map); else if (!wantFlat && map.hasLayer(flat)) map.removeLayer(flat);
    layer = flat;
  }

  window.Hotspots = {
    async init(m, stateFn, basemapFn) {
      map = m; getState = stateFn; getBasemap = basemapFn;
      const ok = await load();
      if (!ok) return false;
      flat = makeLayer();
      sync();
      map.on('moveend', () => { // Leaflet moved by something other than the 3D map (zoom buttons, list taps)
        if (!active || leaving || syncing) return;
        const c = map.getCenter();
        gl.easeTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1, pitch: PITCH, duration: 500 });
      });
      map.on('click', (e) => {
        if (map.getZoom() >= 13 || !visible) return;
        // click a hotspot cell → zoom in to where stands load
        const near = rowsIn(L.latLngBounds([e.latlng.lat - 0.02, e.latlng.lng - 0.03], [e.latlng.lat + 0.02, e.latlng.lng + 0.03]))
          .filter((r) => r.score >= getState().minScore);
        if (near.length) map.setView(e.latlng, 13);
      });
      return true;
    },
    setVisible(on) { visible = !!on; sync(); },
    setMode(m) { mode = m === 'flat' ? 'flat' : '3d'; sync(); },
    setBasemap() { if (gl) { builtKey = null; gl.setStyle(glStyle()); } },
    get mode() { return mode; },
    get is3d() { return active; },
    get gl() { return gl; }, // for debugging in the console
    redraw() {
      if (!rows) return;
      scoreAll(); breaksCache = {}; aggCache = {}; builtKey = null;
      if (flat && map.hasLayer(flat)) flat.redraw();
      buildCells();
    },
    top(bounds, limit, min) {
      if (!rows) return [];
      return rowsIn(bounds).filter((r) => r.score >= min).sort((a, b) => b.score - a.score || b.acres - a.acres).slice(0, limit);
    },
    info() { return data ? { generated: data.generated, count: data.count } : null; },
    get loaded() { return !!rows; },
  };
})();
