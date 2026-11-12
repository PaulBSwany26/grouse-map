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
  const CELL3 = 24, GAP3 = 11, HMAX = 84; // px at the matching Leaflet zoom: column grid / gap / tallest column
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
  // Zoomed out, a tilted MapLibre map sits over the Leaflet map and shows each cell as a
  // round-topped column. It hands back to Leaflet (flat, stand-level) at Leaflet zoom 13.
  // MapLibre zoom n shows what Leaflet shows at n + 1.
  const PITCH = 58, BEARING = -12, HANDOFF = 12;
  const VECTOR_STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const DEM_TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png';
  const CREDIT = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> · <a href="https://openmaptiles.org">OpenMapTiles</a> · <a href="https://openfreemap.org">OpenFreeMap</a>';
  const credit = (on) => { const a = map.attributionControl; if (a) { if (on && wantVector()) a.addAttribution(CREDIT); else a.removeAttribution(CREDIT); } };
  const calm = () => window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);
  let gl = null, glEl = null, tip = null, compass = null, glFailed = false, active = false, leaving = false, syncing = false;
  let builtKey = null, builtBox = null, hoverCid = null, getBasemap = null, vectorStyle = null, grow = 1, growRaf = 0;

  // Columns are stacked extrusions: a round body, then rings that close in like a dome.
  const SIDES = 18, CAPS = 7, PARTS = CAPS + 1;
  const RING = Array.from({ length: SIDES + 1 }, (_, i) => [Math.cos((i / SIDES) * 2 * Math.PI), Math.sin((i / SIDES) * 2 * Math.PI)]);
  function circle(px, py, r, world) { // global pixel circle → lng/lat ring
    const out = new Array(SIDES + 1);
    for (let i = 0; i <= SIDES; i++) {
      const x = (px + RING[i][0] * r) / world, y = (py + RING[i][1] * r) / world;
      out[i] = [x * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI];
    }
    return out;
  }
  function cellsGeoJSON(z, box) {
    const R = (CELL3 - GAP3) / 2, world = 256 * Math.pow(2, z), features = [];
    for (const c of aggregate(z).list) {
      if (c.lng < box[0] || c.lng > box[2] || c.lat < box[1] || c.lat > box[3]) continue;
      const px = (c.cx + 0.5) * CELL3, py = (c.cy + 0.5) * CELL3;
      const mPerPx = (40075016 * Math.cos((c.lat * Math.PI) / 180)) / world;
      const hpx = Math.max(1.2, c.frac * HMAX), cid = c.cx * 100003 + c.cy;
      const props = { mean: c.mean, best: c.best, n: c.n, acres: Math.round(c.acres), lat: c.lat, lng: c.lng, cid };
      const part = (i, r, b, h, t) => features.push({
        type: 'Feature', id: cid * 8 + i, properties: { ...props, b: b * mPerPx, h: h * mPerPx, t },
        geometry: { type: 'Polygon', coordinates: [circle(px, py, r, world)] },
      });
      if (hpx < 4) { part(0, R, 0, hpx, 0); continue; } // too little to stand up: a disc
      const D = Math.min(R, hpx * 0.5), hb = hpx - D;
      part(0, R, 0, hb, 0);
      for (let k = 0; k < CAPS; k++) {
        const t0 = (k / CAPS) * (Math.PI / 2), t1 = ((k + 1) / CAPS) * (Math.PI / 2);
        part(k + 1, R * Math.cos((t0 + t1) / 2), hb + D * Math.sin(t0), hb + D * Math.sin(t1), (k + 1) / CAPS);
      }
    }
    return { type: 'FeatureCollection', features };
  }

  const cellLayer = () => {
    const base = ['step', ['coalesce', ['get', 'mean'], 0], RAMP[0], 35, RAMP[1], 50, RAMP[2], 65, RAMP[3], 80, RAMP[4]];
    return { id: 'cells', type: 'fill-extrusion', source: 'cells', paint: {
      // the dome lightens toward its crown; a hovered column lights up whole
      'fill-extrusion-color': ['case', ['boolean', ['feature-state', 'hover'], false], '#fffbe9',
        ['interpolate', ['linear'], ['coalesce', ['get', 't'], 0], 0, base, 1, ['interpolate-lab', ['linear'], 0.26, 0, base, 1, '#ffffff']]],
      'fill-extrusion-base': ['*', ['coalesce', ['get', 'b'], 0], grow],
      'fill-extrusion-height': ['*', ['coalesce', ['get', 'h'], 0], grow],
      'fill-extrusion-opacity': 0.94,
    } };
  };
  const EMPTY = { type: 'FeatureCollection', features: [] };

  function rasterStyle() { // satellite, or the fallback when the vector map can't be fetched
    const b = getBasemap();
    const tiles = b.url.includes('{s}') ? ['a', 'b', 'c'].map((s) => b.url.replace('{s}', s)) : [b.url];
    return {
      version: 8,
      sources: { base: { type: 'raster', tiles, tileSize: 256, maxzoom: b.maxzoom }, cells: { type: 'geojson', data: EMPTY } },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#dfe5d6' } },
        { id: 'base', type: 'raster', source: 'base', paint: { 'raster-saturation': 0.12, 'raster-contrast': 0.06 } },
        cellLayer(),
      ],
    };
  }
  // A full vector map: forests, lakes, rivers, roads and place names that stay crisp when tilted,
  // recolored toward the north woods and shaded with real relief.
  function vectorMapStyle() {
    const st = JSON.parse(JSON.stringify(vectorStyle));
    st.sources.dem = { type: 'raster-dem', tiles: [DEM_TILES], tileSize: 256, maxzoom: 12, encoding: 'terrarium' };
    st.sources.cells = { type: 'geojson', data: EMPTY };
    const tint = { background: ['background-color', '#eef0e1'], landcover_wood: ['fill-color', '#b4d39b'], landcover_grass: ['fill-color', '#d5e6b8'],
      landcover_wetland: ['fill-color', '#c3dccb'], park: ['fill-color', '#c9e0ac'], water: ['fill-color', '#9cc8e6'], waterway_river: ['line-color', '#8fbfe0'],
      waterway_other: ['line-color', '#8fbfe0'] };
    st.layers = st.layers.filter((l) => l.type !== 'fill-extrusion' && l.id !== 'natural_earth');
    for (const l of st.layers) {
      if (tint[l.id]) { l.paint = l.paint || {}; l.paint[tint[l.id][0]] = tint[l.id][1]; if (l.id === 'landcover_wood') l.paint['fill-opacity'] = 0.75; }
    }
    const at = st.layers.findIndex((l) => /^waterway|^water$/.test(l.id));
    st.layers.splice(at < 0 ? 1 : at, 0, { id: 'relief', type: 'hillshade', source: 'dem',
      paint: { 'hillshade-exaggeration': 0.55, 'hillshade-shadow-color': '#3d5a3a', 'hillshade-highlight-color': '#fffdf0', 'hillshade-accent-color': '#5b7a4e' } });
    st.layers.push(cellLayer());
    return st;
  }
  const wantVector = () => vectorStyle && getBasemap().key !== 'imagery';
  const glStyle = () => (wantVector() ? vectorMapStyle() : rasterStyle());
  function dressScene() {
    try { gl.setLight({ anchor: 'map', position: [1.4, 300, 38], intensity: 0.42, color: '#fff6e6' }); } catch (e) { /* older engines */ }
    try { if (gl.setSky) gl.setSky({ 'sky-color': '#a9cdea', 'horizon-color': '#f4efe2', 'fog-color': '#f1eee2', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.8, 'fog-ground-blend': 0.72 }); } catch (e) { /* no sky */ }
  }

  function buildCells(force) {
    if (!gl || !gl.getSource('cells')) return;
    const z = Math.max(5, Math.min(12, Math.round(gl.getZoom()) + 1));
    const key = z + ':' + Math.max(getState().minScore, 20);
    const vb = gl.getBounds(), w = vb.getWest(), e = vb.getEast(), so = vb.getSouth(), n = vb.getNorth();
    if (!force && key === builtKey && builtBox && w >= builtBox[0] && so >= builtBox[1] && e <= builtBox[2] && n <= builtBox[3]) return;
    const px = (e - w) * 0.6, py = (n - so) * 0.6;
    builtKey = key; builtBox = [w - px, so - py, e + px, n + py]; hoverCid = null;
    gl.getSource('cells').setData(cellsGeoJSON(z, builtBox));
  }

  // Columns rise out of the ground and sink back into it.
  function setGrow(v) {
    grow = v;
    if (!gl || !gl.getLayer('cells')) return;
    gl.setPaintProperty('cells', 'fill-extrusion-base', ['*', ['coalesce', ['get', 'b'], 0], v]);
    gl.setPaintProperty('cells', 'fill-extrusion-height', ['*', ['coalesce', ['get', 'h'], 0], v]);
  }
  function growTo(to, ms, then) {
    cancelAnimationFrame(growRaf);
    if (calm() || !ms) { setGrow(to); if (then) then(); return; }
    const from = grow, t0 = performance.now(); let last = 0;
    const step = (now) => {
      const t = Math.min(1, (now - t0) / ms);
      if (t === 1 || now - last > 40) { last = now; setGrow(from + (to - from) * easeOut(t)); }
      if (t < 1) growRaf = requestAnimationFrame(step); else if (then) then();
    };
    growRaf = requestAnimationFrame(step);
  }

  function setHover(cid) {
    if (cid === hoverCid) return;
    for (const [id, on] of [[hoverCid, false], [cid, true]]) {
      if (id == null) continue;
      for (let i = 0; i < PARTS; i++) gl.setFeatureState({ source: 'cells', id: id * 8 + i }, { hover: on });
    }
    hoverCid = cid;
  }
  function hideTip() {
    if (tip) tip.classList.remove('on');
    if (gl && gl.getSource('cells')) setHover(null);
    if (gl) gl.getCanvas().style.cursor = '';
  }

  function ensureGL() {
    if (gl) return true;
    if (glFailed || !window.maplibregl) return false;
    try {
      glEl = L.DomUtil.create('div', 'map3d', map.getContainer());
      L.DomEvent.disableClickPropagation(glEl); L.DomEvent.disableScrollPropagation(glEl);
      tip = L.DomUtil.create('div', 'hot-tip', map.getContainer());
      const c = map.getCenter();
      gl = new maplibregl.Map({
        container: glEl, style: glStyle(), center: [c.lng, c.lat], zoom: map.getZoom() - 1, pitch: 0,
        minZoom: 4, maxZoom: HANDOFF + 0.6, maxPitch: 72, attributionControl: false, fadeDuration: 200,
        maxBounds: [[-97, 38], [-76, 51]], // the data is Michigan; a hard fling can't leave the Great Lakes
      });
    } catch (e) { console.warn('3D view unavailable', e); glFailed = true; if (glEl) glEl.remove(); gl = null; return false; }
    // Compass: turns with the map, tap to face north again.
    const Compass = L.Control.extend({
      options: { position: 'topright' },
      onAdd() {
        const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control compass');
        div.innerHTML = '<a href="#" role="button" title="Face north" aria-label="Face north"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 15.4 12H8.6L12 3.5Z" fill="currentColor"/><path d="M12 20.5 8.6 12h6.8L12 20.5Z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/></svg></a>';
        L.DomEvent.disableClickPropagation(div);
        L.DomEvent.on(div, 'click', (e) => { L.DomEvent.preventDefault(e); if (active) gl.easeTo({ bearing: 0, pitch: PITCH, duration: 700 }); });
        return div;
      },
    });
    compass = new Compass().addTo(map).getContainer();
    const needle = compass.querySelector('svg');
    gl.on('rotate', () => { needle.style.transform = `rotate(${-gl.getBearing()}deg)`; });
    gl.on('error', (e) => console.warn('3D map:', e && e.error ? e.error.message || e.error : e));
    gl.on('load', () => { dressScene(); buildCells(true); });
    gl.on('styledata', () => { if (gl.getSource('cells') && builtKey == null) { dressScene(); buildCells(true); } });
    gl.on('zoom', () => { if (active && !leaving && gl.getZoom() >= HANDOFF) leave(true); });
    gl.on('moveend', () => { // keep Leaflet (lists, saved view, data loading) on the same spot
      if (!active || leaving) return;
      buildCells();
      const p = gl.getCenter();
      syncing = true;
      map.setView([p.lat, p.lng], Math.max(5, Math.min(12, Math.round(gl.getZoom()) + 1)), { animate: false });
      syncing = false;
    });
    gl.on('mousemove', 'cells', (e) => {
      const f = e.features && e.features[0];
      if (!f || leaving) return;
      const p = f.properties;
      if (p.cid !== hoverCid) {
        setHover(p.cid);
        tip.innerHTML = `<b>${p.acres.toLocaleString()} ac</b> of cover scoring ${Math.max(getState().minScore, 20)}+` +
          `<span>${p.n} stand${p.n === 1 ? '' : 's'} · average ${p.mean} · best ${p.best}</span>`;
      }
      gl.getCanvas().style.cursor = 'pointer';
      tip.classList.add('on'); tip.style.left = e.point.x + 'px'; tip.style.top = e.point.y - 16 + 'px';
    });
    gl.on('mouseleave', 'cells', hideTip);
    gl.on('movestart', () => { if (tip) tip.classList.remove('on'); });
    gl.on('click', 'cells', (e) => { // tap a column → drop to the flat map over its good cover
      const p = e.features[0].properties;
      leave(true, { lng: p.lng, lat: p.lat });
    });
    // Swap in the full vector map once it arrives (it is fetched once and reused).
    if (!vectorStyle) {
      fetch(VECTOR_STYLE).then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
        .then((j) => { vectorStyle = j; if (wantVector()) restyle(); })
        .catch((e) => console.warn('vector basemap unavailable, using the raster map', e));
    }
    return true;
  }
  function restyle() { if (!gl) return; builtKey = null; builtBox = null; gl.setStyle(glStyle(), { diff: false }); credit(active); }

  function enter() {
    if (!ensureGL()) return false;
    const c = map.getCenter();
    active = true; leaving = false;
    gl.stop();
    gl.jumpTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1, pitch: 0, bearing: 0 });
    setGrow(calm() ? 1 : 0);
    buildCells();
    glEl.classList.add('on'); map.getContainer().classList.add('is3d'); credit(true);
    gl.resize();
    // the map leans back and turns a little while the columns rise
    gl.easeTo({ pitch: PITCH, bearing: BEARING, duration: calm() ? 0 : 1500, easing: easeOut });
    setTimeout(() => { if (active && !leaving) growTo(1, 1100); }, calm() ? 0 : 250);
    return true;
  }

  function leave(animated, target) {
    if (!active || leaving) return;
    hideTip();
    const done = () => { active = false; leaving = false; glEl.classList.remove('on'); map.getContainer().classList.remove('is3d'); credit(false); cancelAnimationFrame(growRaf); };
    if (!animated) { gl.stop(); done(); return; }
    leaving = true;
    const c = target || gl.getCenter();
    gl.stop();
    growTo(0, 420); // columns sink as the map levels out
    gl.easeTo({ center: [c.lng, c.lat], zoom: HANDOFF, pitch: 0, bearing: 0, duration: calm() ? 0 : 800, easing: (t) => t * t * (3 - 2 * t) });
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
        gl.easeTo({ center: [c.lng, c.lat], zoom: map.getZoom() - 1, pitch: PITCH, duration: 600, easing: easeOut });
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
    setBasemap() { restyle(); },
    get mode() { return mode; },
    get is3d() { return active; },
    get gl() { return gl; }, // for debugging in the console
    redraw() {
      if (!rows) return;
      scoreAll(); breaksCache = {}; aggCache = {}; builtKey = null; builtBox = null;
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
