/*
 * Statewide hotspots for zoomed-out views (below zoom 13).
 *
 * Loads data/summary.json (built weekly by tools/build_summary.py): one row per DNR stand
 * and USFS cut with cover group, age, stocking, acres and neighbor flags. Rows are scored
 * in the browser with habitat.js and the current weights, then drawn one of two ways:
 *   columns — a block per grid cell. Height = how much of the cell is good cover (acres
 *             weighted toward the best stands); color = acre-weighted average score.
 *   flat    — a grid of squares colored by statewide percentile of the same measure.
 */
(function () {
  const H = window.Habitat;
  const CELL = 10; // px, flat grid
  const CELL3 = 22, GAP3 = 5, HMAX = 88; // px, column grid / gap between columns / tallest column
  let data = null, rows = null, buckets = null, layer = null, map = null, getState = null;
  let flat = null, cols = null, mode = 'columns', visible = true;

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
  // reshuffles them). Heights are scaled to the 98.5th percentile cell at that zoom.
  let aggCache = {};
  function aggregate(z) {
    const min = Math.max(getState().minScore, 20), key = z + ':' + min;
    if (aggCache[key]) return aggCache[key];
    const cells = new Map();
    for (const r of rows) {
      if (r.score < min) continue;
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
    const norm = v.length ? v[Math.floor(0.985 * (v.length - 1))] : 1;
    for (const c of list) c.h = Math.round(HMAX * Math.pow(Math.min(1, c.share / norm), 0.62));
    list.sort((a, b) => a.cy - b.cy || a.cx - b.cx); // north → south, so nearer columns overlap farther ones
    return (aggCache[key] = { list });
  }

  const shade = (hex, f) => '#' + [1, 3, 5].map((i) => Math.round(parseInt(hex.slice(i, i + 2), 16) * f).toString(16).padStart(2, '0')).join('');
  const FACE = RAMP.map((c) => ({ top: c, front: shade(c, 0.74), edge: shade(c, 0.56) }));
  const faceFor = (s) => FACE[s < 35 ? 0 : s < 50 ? 1 : s < 65 ? 2 : s < 80 ? 3 : 4];

  function makeColumns() {
    const Columns = L.Layer.extend({
      onAdd(m) {
        this._c = L.DomUtil.create('canvas', 'hot-columns leaflet-zoom-hide', m.getPane('habitat'));
        this._c.style.pointerEvents = 'none';
        this._tip = L.DomUtil.create('div', 'hot-tip', m.getContainer());
        this._tip.hidden = true;
        this._drawn = []; this._hover = null;
        m.on('moveend zoomend resize', this.draw, this);
        m.on('mousemove', this._move, this);
        m.on('mouseout movestart zoomstart', this._clear, this);
        this.draw();
      },
      onRemove(m) {
        m.off('moveend zoomend resize', this.draw, this);
        m.off('mousemove', this._move, this);
        m.off('mouseout movestart zoomstart', this._clear, this);
        this._clear(); this._c.remove(); this._tip.remove();
      },
      draw() {
        if (!rows || !this._map) return;
        const m = this._map, c = this._c, z = m.getZoom(), size = m.getSize();
        const padX = Math.round(size.x * 0.3), padY = Math.round(size.y * 0.3);
        const tl = m.containerPointToLayerPoint([-padX, -padY]);
        const W = size.x + 2 * padX, Hh = size.y + 2 * padY, dpr = window.devicePixelRatio || 1;
        L.DomUtil.setPosition(c, tl);
        c.width = W * dpr; c.height = Hh * dpr; c.style.width = W + 'px'; c.style.height = Hh + 'px';
        const ctx = c.getContext('2d');
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        const g0 = tl.add(m.getPixelOrigin()); // global pixel position of the canvas corner
        this._g0 = g0;
        const F = CELL3 - GAP3, o = GAP3 / 2;
        const x0 = Math.floor(g0.x / CELL3) - 1, x1 = Math.ceil((g0.x + W) / CELL3) + 1;
        const y0 = Math.floor(g0.y / CELL3) - 1, y1 = Math.ceil((g0.y + Hh + HMAX) / CELL3) + 1;
        const drawn = (this._drawn = []);
        for (const cell of aggregate(z).list) {
          if (cell.cy < y0) continue; if (cell.cy > y1) break;
          if (cell.cx < x0 || cell.cx > x1) continue;
          drawn.push({ cell, x: cell.cx * CELL3 + o - g0.x, y: cell.cy * CELL3 + o - g0.y, h: cell.h });
        }
        // Cast shadows first, as one shape, so overlaps don't stack into dark blotches.
        ctx.beginPath();
        for (const d of drawn) {
          if (d.h < 3) continue;
          const sx = d.h * 0.42, sy = d.h * 0.16;
          ctx.moveTo(d.x + F, d.y + F); ctx.lineTo(d.x + F + sx, d.y + F - sy);
          ctx.lineTo(d.x + F + sx, d.y - sy); ctx.lineTo(d.x + F, d.y); ctx.closePath();
        }
        ctx.fillStyle = 'rgba(20, 24, 22, 0.16)'; ctx.fill();
        const hov = this._hover;
        for (const d of drawn) {
          const f = faceFor(d.cell.mean), on = hov === d.cell;
          if (d.h < 3) { // too little to stand up: a flat tile
            ctx.globalAlpha = 0.72; ctx.fillStyle = f.top; ctx.fillRect(d.x, d.y, F, F);
            ctx.globalAlpha = 1;
            if (on) { ctx.strokeStyle = '#16191a'; ctx.lineWidth = 1.5; ctx.strokeRect(d.x, d.y, F, F); }
            continue;
          }
          ctx.fillStyle = f.front; ctx.fillRect(d.x, d.y + F - d.h, F, d.h); // south face
          ctx.fillStyle = f.top; ctx.fillRect(d.x, d.y - d.h, F, F); // roof
          ctx.fillStyle = f.edge; ctx.fillRect(d.x, d.y + F - 1, F, 1); // where it meets the ground
          ctx.fillStyle = 'rgba(255,255,255,0.42)'; ctx.fillRect(d.x, d.y + F - d.h, F, 1); // lit roof edge
          if (on) { ctx.strokeStyle = '#16191a'; ctx.lineWidth = 1.5; ctx.strokeRect(d.x - 0.25, d.y - d.h - 0.25, F + 0.5, F + d.h + 0.5); }
        }
      },
      // Topmost column under a container point (later-drawn columns sit in front).
      hit(pt) {
        if (!this._g0) return null;
        const F = CELL3 - GAP3, m = this._map;
        const p = m.containerPointToLayerPoint(pt).add(m.getPixelOrigin()).subtract(this._g0);
        const px = p.x, py = p.y;
        for (let i = this._drawn.length - 1; i >= 0; i--) {
          const d = this._drawn[i];
          if (px >= d.x && px <= d.x + F && py >= d.y - d.h && py <= d.y + F) return d;
        }
        return null;
      },
      _move(e) {
        const d = this.hit(e.containerPoint), cell = d ? d.cell : null;
        if (cell === this._hover) return;
        this._hover = cell; this.draw();
        this._map.getContainer().classList.toggle('hot-hover', !!cell);
        if (!cell) { this._tip.hidden = true; return; }
        const F = CELL3 - GAP3;
        this._tip.innerHTML = `<b>${Math.round(cell.acres).toLocaleString()} ac</b> of cover scoring ${Math.max(getState().minScore, 20)}+` +
          `<span>${cell.n} stand${cell.n === 1 ? '' : 's'} · average ${cell.mean} · best ${cell.best}</span>`;
        this._tip.hidden = false;
        const at = this._map.layerPointToContainerPoint(L.point(d.x + F / 2, d.y - d.h).add(this._g0).subtract(this._map.getPixelOrigin()));
        this._tip.style.left = at.x + 'px'; this._tip.style.top = at.y - 8 + 'px';
      },
      _clear() {
        if (this._tip) this._tip.hidden = true;
        if (this._map) this._map.getContainer().classList.remove('hot-hover');
        if (this._hover) { this._hover = null; if (this._map && this._c.isConnected) this.draw(); }
      },
    });
    return new Columns();
  }

  function sync() {
    if (!flat) return;
    for (const [l, on] of [[flat, visible && mode === 'flat'], [cols, visible && mode === 'columns']]) {
      if (on && !map.hasLayer(l)) l.addTo(map); else if (!on && map.hasLayer(l)) map.removeLayer(l);
    }
    layer = mode === 'flat' ? flat : cols;
  }

  window.Hotspots = {
    async init(m, stateFn) {
      map = m; getState = stateFn;
      const ok = await load();
      if (!ok) return false;
      flat = makeLayer(); cols = makeColumns();
      sync();
      map.on('click', (e) => {
        if (map.getZoom() >= 13 || !visible) return;
        if (mode === 'columns') { // tap a column → zoom to the middle of its good cover
          const d = cols.hit(e.containerPoint);
          if (d) { map.setView([d.cell.lat, d.cell.lng], 13); return; }
        }
        const near = rowsIn(L.latLngBounds([e.latlng.lat - 0.02, e.latlng.lng - 0.03], [e.latlng.lat + 0.02, e.latlng.lng + 0.03]))
          .filter((r) => r.score >= getState().minScore);
        if (near.length) map.setView(e.latlng, 13);
      });
      return true;
    },
    setVisible(on) { visible = !!on; sync(); },
    setMode(m) { mode = m === 'flat' ? 'flat' : 'columns'; sync(); },
    get mode() { return mode; },
    redraw() {
      if (!rows) return;
      scoreAll(); breaksCache = {}; aggCache = {};
      if (flat && map.hasLayer(flat)) flat.redraw();
      if (cols && map.hasLayer(cols)) cols.draw();
    },
    top(bounds, limit, min) {
      if (!rows) return [];
      return rowsIn(bounds).filter((r) => r.score >= min).sort((a, b) => b.score - a.score || b.acres - a.acres).slice(0, limit);
    },
    info() { return data ? { generated: data.generated, count: data.count } : null; },
    get loaded() { return !!rows; },
  };
})();
