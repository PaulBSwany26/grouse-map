/* Grouse Cover Finder — map, data loading, scoring glue, import/export. */
(function () {
  const H = window.Habitat;
  const NOW = H.NOW_YEAR;

  // ---------------------------------------------------------------------------
  // Data services (all public, no key needed)
  // ---------------------------------------------------------------------------
  const AGOL = 'https://services3.arcgis.com/Jdnp1TjADvSDxMAX/arcgis/rest/services';
  const EDW = 'https://apps.fs.usda.gov/arcx/rest/services/EDW';
  const SVC = {
    stands: `${AGOL}/MiHuntStandSymbologyFRDPublic/FeatureServer/0`,
    treatments: `${AGOL}/Michigan_DNR_Public_Forest_Inventory_Data/FeatureServer/0`,
    stateForest: `${AGOL}/Michigan_DNR_Public_Forest_Inventory_Data/FeatureServer/5`,
    wildlife: `${AGOL}/DNRWILDLandsOPENDATA/FeatureServer/2`,
    wildProps: `${AGOL}/DNRWILDLandsOPENDATA/FeatureServer/1`,
    hap: `${AGOL}/DNRWILDLandsOPENDATA/FeatureServer/0`,
    parks: `${AGOL}/DNRBoundariesParksHuntableLandsOPENDATA/FeatureServer/2`,
    cfr: `${AGOL}/CommercialForestParcels_View/FeatureServer/0`,
    dnrRoads: `${AGOL}/DNR_ROADS/FeatureServer/0`,
    dnrTrails: 'https://utility.arcgis.com/usrsvcs/servers/860ad7121ae043418c66abb32bb01e96/rest/services/DNR/DNRTrailsOPENDATA/FeatureServer/21',
    fedLand: 'https://services5.arcgis.com/7weheFjxuNkGGiZi/arcgis/rest/services/USA_Federal_Lands_2025/FeatureServer/0',
    usfsHarvest: [`${EDW}/EDW_TimberHarvest_01/MapServer/11`, `${EDW}/EDW_TimberHarvest_01/MapServer/0`, `${EDW}/EDW_TimberHarvest_01/MapServer/1`],
    usfsTrails: `${EDW}/EDW_TrailNFSPublish_01/MapServer/0`,
    usfsClosedRoads: `${EDW}/EDW_RoadBasic_01/MapServer/1`,
  };

  const RAMP = ['#fff1a8', '#ffc95c', '#f2913d', '#d9482b', '#8c1018'];
  function rampColor(s) { return s < 35 ? RAMP[0] : s < 50 ? RAMP[1] : s < 65 ? RAMP[2] : s < 80 ? RAMP[3] : RAMP[4]; }
  const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; } },
  };

  const state = { season: store.get('grouse.season', defaultSeason()), minScore: store.get('grouse.min', 40) };
  function defaultSeason() { const m = new Date().getMonth(); return m >= 10 || m <= 1 ? 'late' : 'early'; }

  // ---------------------------------------------------------------------------
  // Map + basemaps
  // ---------------------------------------------------------------------------
  const savedView = store.get('grouse.view', { lat: 45.05, lng: -84.45, z: 9 });
  const map = L.map('map', { zoomControl: false }).setView([savedView.lat, savedView.lng], savedView.z);
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.control.scale({ imperial: true, metric: false, position: 'bottomright' }).addTo(map);

  [['loss', 350], ['land', 380], ['habitat', 400], ['sales', 420], ['lines', 440], ['imports', 460]]
    .forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
  map.getPane('loss').style.pointerEvents = 'none';
  const renderers = {};
  const rendererFor = (pane) => (renderers[pane] ||= L.canvas({ pane, padding: 0.3, tolerance: 5 }));

  const BASEMAPS = {
    topo: L.tileLayer('https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, maxNativeZoom: 16, attribution: 'USGS The National Map' }),
    imagery: L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      { maxZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }),
    otm: L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
      { maxZoom: 19, maxNativeZoom: 17, attribution: '© OpenStreetMap contributors, SRTM | © OpenTopoMap (CC-BY-SA)' }),
  };
  let basemapKey = store.get('grouse.basemap', 'topo');
  if (!BASEMAPS[basemapKey]) basemapKey = 'topo';
  BASEMAPS[basemapKey].addTo(map);
  const basemapSel = document.getElementById('basemap');
  basemapSel.value = basemapKey;
  basemapSel.addEventListener('change', () => {
    map.removeLayer(BASEMAPS[basemapKey]);
    basemapKey = basemapSel.value;
    BASEMAPS[basemapKey].addTo(map);
    store.set('grouse.basemap', basemapKey);
  });

  // Satellite canopy loss (UMD/Hansen via Global Forest Watch). The year window
  // targets cuts that are now roughly 4–20 years old — prime grouse regrowth.
  const LOSS_START = NOW - 20, LOSS_END = Math.min(NOW - 4, 2024);
  const lossLayer = L.tileLayer(
    `https://tiles.globalforestwatch.org/umd_tree_cover_loss/latest/dynamic/{z}/{x}/{y}.png?start_year=${LOSS_START}&end_year=${LOSS_END}&tree_cover_density_threshold=30`,
    { pane: 'loss', maxNativeZoom: 12, maxZoom: 19, opacity: 0.85, attribution: 'Hansen/UMD/Google/USGS/NASA via Global Forest Watch' });

  // ---------------------------------------------------------------------------
  // ArcGIS REST query → GeoJSON (with paging)
  // ---------------------------------------------------------------------------
  // Keep popups / fitted views clear of the side panel on desktop.
  const panelPad = () => L.point(window.innerWidth > 700 ? 350 : 20, 20);
  const degPerPx = (z) => 360 / (256 * Math.pow(2, z));
  async function queryGeoJSON(url, o, signal) {
    const out = [];
    let offset = 0;
    const pageSize = o.pageSize || 1000;
    for (let page = 0; page < (o.maxPages || 8); page++) {
      const p = new URLSearchParams({
        where: o.where || '1=1', outFields: o.outFields || '*', returnGeometry: 'true', outSR: '4326',
        f: 'geojson', resultOffset: String(offset), resultRecordCount: String(pageSize),
        orderByFields: o.orderBy || 'OBJECTID', geometryPrecision: '6',
      });
      if (o.bounds) {
        const b = o.bounds;
        p.set('geometry', [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((n) => n.toFixed(5)).join(','));
        p.set('geometryType', 'esriGeometryEnvelope'); p.set('inSR', '4326'); p.set('spatialRel', 'esriSpatialRelIntersects');
      }
      if (o.offsetZoom != null) p.set('maxAllowableOffset', (degPerPx(o.offsetZoom) * 0.75).toExponential(2));
      const r = await fetch(url + '/query?' + p.toString(), { signal });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'query failed');
      const feats = j.features || [];
      out.push(...feats);
      const more = j.exceededTransferLimit || (j.properties && j.properties.exceededTransferLimit);
      if (!more || !feats.length) break;
      offset += feats.length;
    }
    return out;
  }

  // ---------------------------------------------------------------------------
  // Generic data layer: loads features for the current view, caches them.
  // ---------------------------------------------------------------------------
  class DataLayer {
    constructor(cfg) {
      this.cfg = cfg;
      this.features = new Map();
      this.loaded = [];
      this.visible = false;
      const pane = cfg.pane;
      this.group = L.geoJSON(null, {
        pane, renderer: rendererFor(pane),
        style: (f) => cfg.style(f),
        onEachFeature: (f, l) => {
          f._layer = l;
          if (cfg.popup) l.bindPopup(() => cfg.popup(f), { maxWidth: 340, autoPanPaddingTopLeft: panelPad(), autoPanPaddingBottomRight: [20, 20] });
          if (cfg.tooltip) { const t = cfg.tooltip(f); if (t) l.bindTooltip(t, { sticky: true }); }
        },
      });
    }
    setVisible(on) {
      this.visible = on;
      if (on) this.group.addTo(map); else map.removeLayer(this.group);
    }
    covers(view) { return this.cfg.statewide ? this.loaded.length > 0 : this.loaded.some((b) => b.contains(view)); }
    async refresh() {
      const c = this.cfg;
      if (!this.visible && !c.alwaysFetch) return 'hidden';
      if (map.getZoom() < (c.minZoom || 0)) return 'zoom';
      const view = map.getBounds();
      if (this.covers(view)) return 'cached';
      const q = c.statewide ? null : view.pad(0.3);
      if (this.abort) this.abort.abort();
      const ac = (this.abort = new AbortController());
      try {
        const feats = await this.fetchNetwork(q, ac.signal);
        if (ac.signal.aborted) return 'aborted';
        this.loaded.push(q || view);
        this.ingest(feats, true);
        return 'loaded';
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        // No signal (or service down): fall back to anything stored for this area.
        const cached = await OfflineStore.query(this.key, q);
        if (!cached.length) throw err;
        this.ingest(cached, false);
        return 'offline';
      }
    }
    async fetchNetwork(bounds, signal, maxPages) {
      const c = this.cfg;
      const urls = Array.isArray(c.url) ? c.url : [c.url];
      const results = await Promise.all(urls.map((u, i) =>
        queryGeoJSON(u, { where: c.where, outFields: c.outFields, bounds, offsetZoom: c.offsetZoom, orderBy: c.orderBy,
          pageSize: c.pageSize, maxPages: maxPages || c.maxPages }, signal)
          .then((fs) => fs.map((f) => {
            const p = f.properties || {};
            f._id = `${i}:${f.id ?? p.OBJECTID ?? p.objectid ?? p.ObjectId}`;
            return f;
          }))));
      return results.flat();
    }
    ingest(feats, persist) {
      const c = this.cfg;
      const fresh = [];
      for (const f of feats) {
        if (this.features.has(f._id)) continue;
        this.features.set(f._id, f);
        fresh.push(f);
      }
      if (persist && fresh.length) OfflineStore.put(this.key, fresh);
      if (!fresh.length) return;
      if (c.prepare) fresh.forEach(c.prepare);
      this.group.addData(fresh);
      if (c.onNew) c.onNew(fresh);
    }
    /** Bulk-load a whole area for offline use, regardless of zoom or visibility. */
    async saveArea(bounds) {
      const feats = await this.fetchNetwork(this.cfg.statewide ? null : bounds, undefined, 40);
      await OfflineStore.put(this.key, feats);
      this.ingest(feats, false);
      if (!this.cfg.statewide) this.loaded.push(bounds);
      return feats.length;
    }
    restyle() { this.group.setStyle((f) => this.cfg.style(f)); }
  }

  // ---------------------------------------------------------------------------
  // Habitat records + neighbor graph
  // ---------------------------------------------------------------------------
  const records = new Map(); // id → record (DNR stands + USFS harvests)
  const soldCuts = new Map(); // StandID → [{year, sale, status}]
  const upcoming = new Map(); // StandID → [{sale, status, year}]
  const standsById = new Map(); // DNR StandID → record

  const K = Math.cos((45 * Math.PI) / 180);
  const proj = ([lng, lat]) => [lng * 111320 * K, lat * 110540];
  const NEAR = 100; // metres — "adjacent" for neighbor bonuses
  const CELL = 500;
  const grid = new Map();

  function ringsOf(geom) {
    if (!geom) return [];
    if (geom.type === 'Polygon') return geom.coordinates;
    if (geom.type === 'MultiPolygon') return geom.coordinates.flat();
    return [];
  }
  function geomPrep(geom) {
    const pts = [];
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
    for (const ring of ringsOf(geom)) {
      for (let i = 0; i < ring.length; i++) {
        const a = proj(ring[i]);
        minx = Math.min(minx, a[0]); maxx = Math.max(maxx, a[0]); miny = Math.min(miny, a[1]); maxy = Math.max(maxy, a[1]);
        pts.push(a);
        if (i + 1 < ring.length) { // densify long edges so shared straight boundaries are detected
          const b = proj(ring[i + 1]);
          const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
          for (let t = 150; t < d; t += 150) pts.push([a[0] + ((b[0] - a[0]) * t) / d, a[1] + ((b[1] - a[1]) * t) / d]);
        }
      }
    }
    const step = Math.max(1, Math.ceil(pts.length / 160));
    return { pts: step === 1 ? pts : pts.filter((_, i) => i % step === 0), bbox: [minx, miny, maxx, maxy] };
  }
  function centroidOf(geom) {
    // area-weighted centroid of the largest ring
    let best = null, bestA = 0;
    for (const ring of ringsOf(geom)) {
      let a = 0, cx = 0, cy = 0;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const f = ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
        a += f; cx += (ring[j][0] + ring[i][0]) * f; cy += (ring[j][1] + ring[i][1]) * f;
      }
      if (Math.abs(a) > bestA) { bestA = Math.abs(a); best = [cx / (3 * a), cy / (3 * a)]; }
    }
    return best ? { lng: best[0], lat: best[1] } : null;
  }
  function cellsFor(bb, pad) {
    const out = [];
    for (let x = Math.floor((bb[0] - pad) / CELL); x <= Math.floor((bb[2] + pad) / CELL); x++)
      for (let y = Math.floor((bb[1] - pad) / CELL); y <= Math.floor((bb[3] + pad) / CELL); y++) out.push(x + ',' + y);
    return out;
  }
  function bboxGap(a, b) {
    const dx = Math.max(0, a[0] - b[2], b[0] - a[2]);
    const dy = Math.max(0, a[1] - b[3], b[1] - a[3]);
    return Math.hypot(dx, dy);
  }
  function isNear(a, b) {
    if (bboxGap(a.bbox, b.bbox) > NEAR) return false;
    const n2 = NEAR * NEAR;
    for (const p of a.pts) for (const q of b.pts) {
      const dx = p[0] - q[0], dy = p[1] - q[1];
      if (dx * dx + dy * dy < n2) return true;
    }
    // one inside the other
    const [A, B] = [a.bbox, b.bbox];
    return (B[0] >= A[0] && B[2] <= A[2] && B[1] >= A[1] && B[3] <= A[3]) || (A[0] >= B[0] && A[2] <= B[2] && A[1] >= B[1] && A[3] <= B[3]);
  }
  function linkNeighbors(newRecs) {
    for (const r of newRecs) for (const c of cellsFor(r.bbox, 0)) { if (!grid.has(c)) grid.set(c, []); grid.get(c).push(r); }
    const dirty = new Set(newRecs);
    for (const r of newRecs) {
      const seen = new Set();
      for (const c of cellsFor(r.bbox, NEAR)) for (const o of grid.get(c) || []) {
        if (o === r || seen.has(o) || r.neighbors.has(o)) continue;
        seen.add(o);
        if (isNear(r, o)) { r.neighbors.add(o); o.neighbors.add(r); dirty.add(o); }
      }
    }
    return dirty;
  }

  function invYear(dateStr) { const m = /(\d{4})$/.exec(dateStr || ''); return m ? +m[1] : null; }

  function effectiveAge(rec) {
    rec.ageNote = null;
    rec.age = rec.baseAge;
    const sold = soldCuts.get(rec.standId);
    if (!sold) return;
    const latest = sold.reduce((a, b) => (b.year > a.year ? b : a));
    const iy = invYear(rec.props.Date);
    const since = NOW - latest.year;
    // Inventory predates the sale and still shows an old stand → assume it was cut.
    if (latest.year >= (iy || 0) && (rec.baseAge == null || rec.baseAge > since + 2)) {
      rec.age = Math.max(0, since - 1);
      rec.ageNote = `Age estimated from SOLD sale "${latest.sale}" (${latest.year}); inventory is from ${iy || '?'}`;
    }
  }

  function scoreRecord(rec) {
    if (rec.kind === 'usfs') {
      Object.assign(rec, H.usfsScore(rec, state.season));
      return;
    }
    effectiveAge(rec);
    const nbs = [...rec.neighbors].filter((n) => n.kind === 'stand');
    Object.assign(rec, H.scoreWithNeighbors(rec, nbs, state.season));
  }

  function habitatStyle(f, dashed) {
    const rec = records.get(f._id);
    const s = rec ? rec.score : 0;
    if (s < state.minScore) {
      return { stroke: map.getZoom() >= 14, color: '#7a7a7a', weight: 0.6, opacity: 0.35, fill: true, fillOpacity: 0 };
    }
    const c = rampColor(s);
    return { stroke: true, color: dashed ? '#5a1a00' : c, weight: dashed ? 1.4 : 1, opacity: 0.95,
      dashArray: dashed ? '5 4' : null, fill: true, fillColor: c, fillOpacity: 0.55 };
  }

  // ---------------------------------------------------------------------------
  // Popups
  // ---------------------------------------------------------------------------
  function actionsHtml(ll) {
    if (!ll) return '';
    const c = `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}`;
    return `<div class="actions"><button type="button" data-copy="${c}">Copy coords</button>
      <a target="_blank" rel="noopener" href="https://www.google.com/maps/dir/?api=1&destination=${ll.lat.toFixed(5)},${ll.lng.toFixed(5)}">Directions</a></div>
      <div class="small">${c} — paste into onX search to drop a pin.</div>`;
  }
  function scoreHtml(rec) {
    return `<div class="big" style="color:${rec.score >= 50 ? rampColor(rec.score) : '#777'};text-shadow:0 0 1px #0004">${rec.score}</div>
      <ul>${rec.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>`;
  }
  function standPopup(f) {
    const rec = records.get(f._id); const p = f.properties;
    const up = upcoming.get(p.StandID) || [];
    const sold = soldCuts.get(p.StandID) || [];
    const notes = (p.ManagementNotes || '').trim();
    return `<div class="pop"><h3>${esc(p.CoverType || 'Unknown')}${rec.age != null ? ` · ~${rec.age} yrs` : ''}</h3>
      ${scoreHtml(rec)}
      <div class="small">${esc(p.SizeDensityDescription || '')} · ${p.Acres ? p.Acres.toFixed(1) + ' ac' : ''} · inventoried ${esc(p.Date || '?')}
      · ${esc(p.CountyName || '')} Co. · stand ${esc(p.FCKey)}-${esc(p.StandNumber)}</div>
      ${sold.map((s) => `<div class="small"><b>Sold for harvest:</b> ${esc(s.sale)} (${s.year})</div>`).join('')}
      ${up.map((s) => `<div class="small"><b>Upcoming harvest:</b> ${esc(s.sale || 'unnamed')} — ${esc(s.status)}${s.year ? ' (' + s.year + ')' : ''}</div>`).join('')}
      ${notes ? `<div class="small" style="margin-top:4px"><b>Forester notes:</b> ${esc(notes.slice(0, 280))}${notes.length > 280 ? '…' : ''}</div>` : ''}
      ${actionsHtml(rec.center)}</div>`;
  }
  function usfsPopup(f) {
    const rec = records.get(f._id); const p = f.properties;
    const d = p.date_completed ? new Date(p.date_completed).toLocaleDateString() : '?';
    return `<div class="pop"><h3>USFS: ${esc(p.activity_name)}</h3>${scoreHtml(rec)}
      <div class="small">Completed ${d} · ${p.gis_acres ? p.gis_acres.toFixed(1) + ' ac' : ''}<br>
      Sale: ${esc(p.sale_name || '—')} · ${esc(p.admin_forest_name || '')}, ${esc(p.admin_district_name || '')}</div>
      ${actionsHtml(rec.center)}</div>`;
  }
  function salePopup(f) {
    const p = f.properties;
    const y = p.ProposedStartDate ? new Date(p.ProposedStartDate).getUTCFullYear() : null;
    const st = (p.ProposalStatusShortDesc || '').trim();
    const sold = st === 'SOLD';
    const rx = (p.RxSpecs || '').trim();
    const outlook = y ? (sold
      ? `Likely cut ${y}–${y + 3}. Expect prime grouse cover roughly ${y + 7}–${y + 20}.`
      : `Not sold yet (${st}). If cut ~${y + 1}–${y + 3}, prime cover ~${y + 8}–${y + 20}.`) : '';
    return `<div class="pop"><h3>DNR timber sale: ${esc(p.SaleName || 'unnamed')}</h3>
      <div><b>${esc(st)}</b>${y ? ` · proposed start ${y}` : ''} · ${p.Acres ? p.Acres.toFixed(1) + ' ac' : ''}</div>
      <div class="small">${esc(p.TreatmentName || '')}${p.SaleNumber ? ' · sale #' + esc(p.SaleNumber) : ''}</div>
      ${outlook ? `<p style="margin:6px 0">${esc(outlook)}</p>` : ''}
      ${rx ? `<div class="small"><b>Prescription:</b> ${esc(rx.slice(0, 400))}${rx.length > 400 ? '…' : ''}</div>` : ''}</div>`;
  }
  const simplePopup = (title, rows) => (f) => {
    const p = f.properties;
    return `<div class="pop"><h3>${esc(typeof title === 'function' ? title(p) : title)}</h3>${rows
      .map(([k, fn]) => { const v = fn(p); return v ? `<div class="small"><b>${esc(k)}:</b> ${esc(v)}</div>` : ''; }).join('')}</div>`;
  };

  map.on('popupopen', (e) => {
    e.popup.getElement().querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
      navigator.clipboard?.writeText(b.dataset.copy).then(() => { b.textContent = 'Copied'; }, () => { b.textContent = b.dataset.copy; });
    }));
  });

  // ---------------------------------------------------------------------------
  // Layers
  // ---------------------------------------------------------------------------
  const STAND_FIELDS = 'OBJECTID,StandID,FCKey,StandNumber,CoverType,DominantAge,FirstOriginYear,SizeDensityDescription,OverallSize,Acres,Date,CountyName,ManagementNotes';
  const outline = (color, o = {}) => () => ({ color, weight: o.weight || 1.5, opacity: 0.9, fill: true, fillColor: color,
    fillOpacity: o.fill ?? 0.06, dashArray: o.dash || null });
  const line = (color, weight, dash) => () => ({ color, weight, opacity: 0.9, dashArray: dash || null });

  const L_ = {};
  L_.stands = new DataLayer({
    url: SVC.stands, outFields: STAND_FIELDS, minZoom: 13, offsetZoom: 15, pane: 'habitat', pageSize: 2000,
    style: (f) => habitatStyle(f, false), popup: standPopup,
    prepare: (f) => {
      const p = f.properties;
      const rec = Object.assign(geomPrep(f.geometry), {
        id: f._id, kind: 'stand', props: p, standId: p.StandID, cover: p.CoverType, group: H.groupOf(p.CoverType),
        baseAge: H.estimateAge(p), sizeDensity: p.SizeDensityDescription, acres: p.Acres,
        neighbors: new Set(), center: centroidOf(f.geometry), feature: f, score: 0, reasons: [],
      });
      records.set(f._id, rec);
      if (p.StandID != null) standsById.set(p.StandID, rec);
    },
    onNew: (fresh) => {
      const dirty = linkNeighbors(fresh.map((f) => records.get(f._id)));
      dirty.forEach(scoreRecord);
      L_.stands.restyle();
    },
  });
  L_.usfs = new DataLayer({
    url: SVC.usfsHarvest, where: `state_abbr='MI' AND fy_completed >= '${NOW - 30}'`, minZoom: 12, offsetZoom: 15, pane: 'habitat',
    orderBy: 'objectid', outFields: 'objectid,activity_name,date_completed,gis_acres,sale_name,admin_forest_name,admin_district_name',
    style: (f) => habitatStyle(f, true), popup: usfsPopup,
    prepare: (f) => {
      const rec = Object.assign(H.usfsHarvestToStand(f.properties), geomPrep(f.geometry),
        { id: f._id, kind: 'usfs', props: f.properties, neighbors: new Set(), center: centroidOf(f.geometry), feature: f, acres: f.properties.gis_acres });
      scoreRecord(rec);
      records.set(f._id, rec);
    },
  });
  L_.treatments = new DataLayer({
    url: SVC.treatments, minZoom: 12, offsetZoom: 15, pane: 'sales', alwaysFetch: true,
    where: "TreatmentName LIKE '%Cut%' AND ProposalStatusShortDesc IS NOT NULL AND ProposalStatusShortDesc NOT LIKE 'No Bid%' AND ProposalStatusShortDesc NOT LIKE 'Withdrawn%' AND ProposalStatusShortDesc NOT LIKE 'Forfeit%' AND ProposalStatusShortDesc NOT LIKE 'CLOSED%'",
    outFields: 'OBJECTID,StandID,SaleName,SaleNumber,ProposalStatusShortDesc,ProposedStartDate,RxSpecs,TreatmentName,Acres',
    style: (f) => {
      const sold = (f.properties.ProposalStatusShortDesc || '').trim() === 'SOLD';
      return { color: sold ? '#6a3d9a' : '#1f78b4', weight: 2, dashArray: '6 4', opacity: 0.95, fill: true,
        fillColor: sold ? '#6a3d9a' : '#1f78b4', fillOpacity: 0.08 };
    },
    popup: salePopup,
    onNew: (fresh) => {
      const touched = new Set();
      for (const f of fresh) {
        const p = f.properties; if (p.StandID == null) continue;
        const year = p.ProposedStartDate ? new Date(p.ProposedStartDate).getUTCFullYear() : null;
        const st = (p.ProposalStatusShortDesc || '').trim();
        const entry = { sale: p.SaleName || 'unnamed', status: st, year };
        const target = st === 'SOLD' && year && year <= NOW ? soldCuts : upcoming;
        if (!target.has(p.StandID)) target.set(p.StandID, []);
        target.get(p.StandID).push(entry);
        touched.add(p.StandID);
      }
      let changed = false;
      touched.forEach((sid) => { const r = standsById.get(sid); if (r) { scoreRecord(r); changed = true; } });
      if (changed) { L_.stands.restyle(); }
    },
  });
  L_.gems = new DataLayer({
    url: SVC.wildProps, where: "PropertyType = 'Grouse enhancement management site'", statewide: true, offsetZoom: 13, pane: 'land',
    style: outline('#c62828', { weight: 3, fill: 0.1 }),
    tooltip: (f) => esc(f.properties.PropertyName),
    popup: simplePopup((p) => p.PropertyName || 'GEMS', [['Type', () => 'Grouse Enhanced Management Site — walk-in grouse & woodcock area with marked trails'],
      ['Info', (p) => p.AdditionalInfo], ['Acres', (p) => p.Acres && Math.round(p.Acres)], ['County', (p) => p.County]]),
  });
  L_.stateForest = new DataLayer({
    url: SVC.stateForest, where: 'ManagementType = 1', minZoom: 10, offsetZoom: 13, pane: 'land', outFields: 'OBJECTID,UnitName,FCKey,County,Acres',
    style: outline('#2e7d32'),
    popup: simplePopup('State Forest', [['Compartment', (p) => p.FCKey], ['Acres', (p) => p.Acres && Math.round(p.Acres)]]),
  });
  L_.wildlife = new DataLayer({
    url: SVC.wildlife, minZoom: 10, offsetZoom: 13, pane: 'land',
    style: outline('#00897b'),
    popup: simplePopup((p) => p.OfficialWLDProjectAreaName || 'State Wildlife Area', [['Type', (p) => p.AreaType],
      ['Note', () => 'Check area-specific rules — a few floodings/refuges are closed']]),
  });
  L_.parks = new DataLayer({
    url: SVC.parks, where: "HuntTrap NOT LIKE '%Closed%'", minZoom: 10, offsetZoom: 13, pane: 'land',
    style: outline('#9e9d24'),
    popup: simplePopup((p) => p.Facility || 'State Park', [['Hunting', (p) => p.HuntTrap], ['Restrictions', (p) => p.HuntTrapRestrictions]]),
  });
  L_.fedLand = new DataLayer({
    url: SVC.fedLand, where: "Agency = 'Forest Service'", minZoom: 9, offsetZoom: 12, pane: 'land',
    style: outline('#1b5e20', { weight: 2, fill: 0.04 }),
    popup: simplePopup((p) => p.Unit_Name || 'National Forest', [['Agency', (p) => p.Agency]]),
  });
  L_.cfr = new DataLayer({
    url: SVC.cfr, where: "ParcelStatusText = 'Active'", minZoom: 11, offsetZoom: 14, pane: 'land', orderBy: 'ObjectId',
    outFields: 'ObjectId,Acres,CountyName,TownName,Town,Range_,Section',
    style: outline('#ef6c00', { fill: 0.1 }),
    popup: simplePopup('Commercial Forest (CFR)', [['Access', () => 'Open to foot-access hunting & fishing by law. No DNR stand data — use the canopy-loss layer to find young cuts.'],
      ['Acres', (p) => p.Acres], ['Location', (p) => [p.TownName, p.CountyName && p.CountyName + ' Co.'].filter(Boolean).join(', ')],
      ['T/R/S', (p) => [p.Town, p.Range_, p.Section].filter(Boolean).join(' ')]]),
  });
  L_.hap = new DataLayer({
    url: SVC.hap, where: "ActiveOrInactive = 'Active'", minZoom: 10, offsetZoom: 14, pane: 'land',
    style: outline('#d81b60', { weight: 2, fill: 0.12 }),
    popup: simplePopup('Hunter Access Program (private land)', [['Hunt types', (p) => p.HuntType], ['Info', (p) => p.HAPInfo],
      ['Note', (p) => p.SpecialComment], ['Forest acres', (p) => p.ForestAcres]]),
  });
  L_.dnrTrails = new DataLayer({
    url: SVC.dnrTrails, minZoom: 13, offsetZoom: 15, pane: 'lines', outFields: 'OBJECTID,Name,TrailNamePrimary,TrailType',
    style: line('#6d4c41', 2.5, '7 4'),
    popup: simplePopup((p) => p.TrailNamePrimary || p.Name || 'DNR trail', [['Type', (p) => p.TrailType]]),
  });
  L_.dnrRoads = new DataLayer({
    url: SVC.dnrRoads, where: 'RoadType NOT IN (3,5,4)', minZoom: 13, offsetZoom: 15, pane: 'lines',
    outFields: 'OBJECTID,RoadPrimary,SurfaceType,Condition,ORVStatus,ClosureCriteria',
    style: line('#a1887f', 1.5),
    popup: simplePopup((p) => p.RoadPrimary || 'DNR road', [['Condition', (p) => p.Condition], ['ORV', (p) => p.ORVStatus], ['Closure', (p) => p.ClosureCriteria]]),
  });
  L_.usfsTrails = new DataLayer({
    url: SVC.usfsTrails, minZoom: 13, offsetZoom: 15, pane: 'lines', orderBy: 'objectid', outFields: 'objectid,trail_name,trail_class,allowed_terra_use',
    style: line('#5d4037', 2.5, '7 4'),
    popup: simplePopup((p) => p.trail_name || 'USFS trail', [['Class', (p) => p.trail_class]]),
  });
  L_.usfsClosed = new DataLayer({
    url: SVC.usfsClosedRoads, minZoom: 12, offsetZoom: 15, pane: 'lines', orderBy: 'objectid', outFields: 'objectid,id,name,oper_maint_level,surface_type',
    style: line('#ff6f00', 3, '2 6'),
    popup: simplePopup((p) => (p.name || 'FS road ' + (p.id || '')).trim(), [['Status', () => 'Closed to motor vehicles — walk-in access'],
      ['Maintenance', (p) => p.oper_maint_level]]),
  });

  Object.entries(L_).forEach(([k, l]) => { l.key = k; }); // offline-store namespace

  // Imports (onX GPX/KML)
  const importGroup = L.geoJSON(null, {
    pane: 'imports',
    style: () => ({ color: '#1565c0', weight: 3, opacity: 0.9, fillOpacity: 0.1 }),
    pointToLayer: (f, ll) => L.circleMarker(ll, { pane: 'imports', radius: 6, color: '#fff', weight: 2, fillColor: '#1565c0', fillOpacity: 1 }),
    onEachFeature: (f, l) => { const n = f.properties && (f.properties.name || f.properties.desc); if (n) l.bindTooltip(esc(n)); },
  });

  // UI rows: key → { label, swatch, members[] }
  const ROWS = [
    { key: 'stands', label: 'Grouse habitat (DNR stands)', swatch: [RAMP[3], RAMP[2]], members: [L_.stands], on: true },
    { key: 'usfs', label: 'USFS harvests, scored (dashed)', swatch: [RAMP[2], '#5a1a00'], members: [L_.usfs], on: true },
    { key: 'gems', label: 'GEMS grouse areas', swatch: ['transparent', '#c62828'], members: [L_.gems], on: true },
    { key: 'sales', label: 'DNR timber sales (purple sold, blue upcoming)', swatch: ['transparent', '#6a3d9a'], members: [L_.treatments], on: true },
    { key: 'loss', label: `Satellite canopy loss ${LOSS_START}–${LOSS_END} (all owners)`, swatch: ['#e9578a', '#e9578a'], tile: lossLayer, on: false },
    { key: 'stateForest', label: 'State Forest', swatch: ['transparent', '#2e7d32'], members: [L_.stateForest], on: true },
    { key: 'wildlife', label: 'State game / wildlife areas', swatch: ['transparent', '#00897b'], members: [L_.wildlife], on: true },
    { key: 'parks', label: 'State parks (huntable)', swatch: ['transparent', '#9e9d24'], members: [L_.parks], on: false },
    { key: 'fedLand', label: 'National Forest', swatch: ['transparent', '#1b5e20'], members: [L_.fedLand], on: true },
    { key: 'cfr', label: 'Commercial Forest (open to foot hunting)', swatch: ['transparent', '#ef6c00'], members: [L_.cfr], on: true },
    { key: 'hap', label: 'Hunter Access Program', swatch: ['transparent', '#d81b60'], members: [L_.hap], on: true },
    { key: 'trails', label: 'Trails & DNR roads', swatch: ['transparent', '#6d4c41'], members: [L_.dnrTrails, L_.dnrRoads, L_.usfsTrails], on: true },
    { key: 'closed', label: 'Gated USFS roads (walk-in)', swatch: ['transparent', '#ff6f00'], members: [L_.usfsClosed], on: true },
    { key: 'imports', label: 'Your onX imports', swatch: ['#1565c0', '#1565c0'], group: importGroup, on: true },
  ];
  const savedRows = store.get('grouse.layers', {});
  const listEl = document.getElementById('layerList');
  for (const row of ROWS) {
    const on = savedRows[row.key] ?? row.on;
    const lab = document.createElement('label');
    lab.className = 'row';
    lab.innerHTML = `<input type="checkbox" ${on ? 'checked' : ''}><span class="sw" style="background:${row.swatch[0]};border-color:${row.swatch[1]}"></span><span>${esc(row.label)}</span>`;
    const cb = lab.querySelector('input');
    const apply = (v) => {
      if (row.members) row.members.forEach((m) => m.setVisible(v));
      if (row.tile) { if (v) row.tile.addTo(map); else map.removeLayer(row.tile); }
      if (row.group) { if (v) row.group.addTo(map); else map.removeLayer(row.group); }
    };
    cb.addEventListener('change', () => { apply(cb.checked); savedRows[row.key] = cb.checked; store.set('grouse.layers', savedRows); refreshAll(); });
    apply(on);
    listEl.appendChild(lab);
  }

  // ---------------------------------------------------------------------------
  // Refresh orchestration
  // ---------------------------------------------------------------------------
  const statusEl = document.getElementById('status');
  const ALL = Object.values(L_);
  let refreshTimer = null, refreshSeq = 0;
  function refreshAll() { clearTimeout(refreshTimer); refreshTimer = setTimeout(doRefresh, 250); }
  async function doRefresh() {
    const seq = ++refreshSeq;
    const z = map.getZoom();
    const c = map.getCenter();
    store.set('grouse.view', { lat: +c.lat.toFixed(5), lng: +c.lng.toFixed(5), z });
    statusEl.textContent = z >= 12 ? 'Loading…' : '';
    const res = await Promise.allSettled(ALL.map((l) => l.refresh()));
    if (seq !== refreshSeq) return;
    const failed = res.filter((r) => r.status === 'rejected' && r.reason?.name !== 'AbortError');
    updateTop();
    const n = inView().length;
    let msg = z < 13 ? `Zoom in to 13+ to score DNR stands (now ${z}).` : `${n.toLocaleString()} scored areas in view · ${state.season} season`;
    if (res.some((r) => r.value === 'offline')) msg += ' · offline, using saved data';
    if (failed.length) {
      msg += navigator.onLine === false ? ' · no signal and nothing saved for some layers here'
        : ` · ${failed.length} layer(s) failed to load`;
      console.warn(failed.map((f) => f.reason));
    }
    statusEl.textContent = msg;
    if (fieldMode.last) updateHere(fieldMode.last);
  }
  map.on('moveend', refreshAll);

  function inView() {
    const b = map.getBounds();
    const out = [];
    for (const r of records.values()) {
      if (!r.center || !b.contains(r.center)) continue;
      if (r.kind === 'stand' && !L_.stands.visible) continue;
      if (r.kind === 'usfs' && !L_.usfs.visible) continue;
      out.push(r);
    }
    return out;
  }
  function topSpots(limit) {
    return inView().filter((r) => r.score >= Math.max(state.minScore, 1)).sort((a, b) => b.score - a.score || (b.acres || 0) - (a.acres || 0)).slice(0, limit);
  }
  function label(r) {
    return r.kind === 'usfs' ? `${r.cover}${r.age != null ? `, cut ${r.age}y ago` : ''}` : `${r.cover}${r.age != null ? `, ${r.age}y` : ''}`;
  }
  function updateTop() {
    const ul = document.getElementById('top');
    const top = map.getZoom() >= 12 ? topSpots(12) : [];
    if (!top.length) { ul.innerHTML = `<li class="meta">${map.getZoom() < 13 ? 'Zoom in to see scored stands.' : 'Nothing above the threshold here.'}</li>`; return; }
    ul.innerHTML = '';
    for (const r of top) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="score" style="background:${rampColor(r.score)};${r.score >= 80 ? 'color:#fff' : ''}">${r.score}</span>
        <span><div>${esc(label(r))}</div><div class="meta">${r.acres ? r.acres.toFixed(0) + ' ac' : ''}${r.neighbors.size ? ' · ' + r.neighbors.size + ' neighbors' : ''}</div></span>`;
      li.addEventListener('click', () => {
        const l = r.feature._layer;
        map.fitBounds(l.getBounds(), { maxZoom: 16, paddingTopLeft: panelPad().add([20, 20]), paddingBottomRight: [40, 40] });
        setTimeout(() => l.openPopup(r.center), 350);
        document.getElementById('panel').classList.remove('open');
      });
      ul.appendChild(li);
    }
  }

  // ---------------------------------------------------------------------------
  // Controls: season, threshold
  // ---------------------------------------------------------------------------
  const SEASON_HINT = {
    early: 'Leaves on: young dense aspen, alder edges, openings with berries & clover.',
    late: 'Leaves down: conifer cover and mature aspen (bud feeding) gain weight.',
  };
  const seasonEl = document.getElementById('season');
  function setSeason(v) {
    state.season = v; store.set('grouse.season', v);
    seasonEl.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v));
    document.getElementById('seasonHint').textContent = SEASON_HINT[v];
    records.forEach(scoreRecord);
    L_.stands.restyle(); L_.usfs.restyle();
    refreshAll();
  }
  seasonEl.addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) setSeason(b.dataset.v); });
  setSeason(state.season);

  const minEl = document.getElementById('minScore'), minVal = document.getElementById('minVal');
  minEl.value = state.minScore; minVal.textContent = state.minScore;
  minEl.addEventListener('input', () => {
    state.minScore = +minEl.value; minVal.textContent = minEl.value; store.set('grouse.min', state.minScore);
    L_.stands.restyle(); L_.usfs.restyle(); updateTop();
  });
  map.on('zoomend', () => { L_.stands.restyle(); L_.usfs.restyle(); });

  // Mobile bottom sheet
  const panel = document.getElementById('panel');
  document.getElementById('panelHeader').addEventListener('click', (e) => {
    if (window.innerWidth <= 700) panel.classList.toggle('open');
  });

  // ---------------------------------------------------------------------------
  // Field mode: live GPS, follow, and "what am I standing in"
  //   tap ◎ once  → track + follow
  //   pan the map → keeps tracking, stops following (button turns outlined)
  //   tap again   → re-center; tap while following → stop tracking
  // ---------------------------------------------------------------------------
  const fieldMode = { on: false, follow: false, last: null, first: true };
  const hereEl = document.getElementById('here');
  let locateBtn = null;
  const Locate = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const div = L.DomUtil.create('div', 'leaflet-bar leaflet-control locate');
      div.innerHTML = '<a href="#" title="Track my location" role="button" aria-label="Track my location">◎</a>';
      L.DomEvent.disableClickPropagation(div);
      L.DomEvent.on(div, 'click', (e) => {
        L.DomEvent.preventDefault(e);
        if (!fieldMode.on) startTracking();
        else if (!fieldMode.follow) { fieldMode.follow = true; if (fieldMode.last) map.setView(fieldMode.last.latlng, Math.max(map.getZoom(), 15)); }
        else stopTracking();
        paintLocate();
      });
      locateBtn = div;
      return div;
    },
  });
  new Locate().addTo(map);
  function paintLocate() {
    locateBtn.classList.toggle('on', fieldMode.on && fieldMode.follow);
    locateBtn.classList.toggle('paused', fieldMode.on && !fieldMode.follow);
  }
  function startTracking() {
    Object.assign(fieldMode, { on: true, follow: true, first: true });
    map.locate({ watch: true, enableHighAccuracy: true, setView: false, maximumAge: 5000, timeout: 20000 });
    hereEl.hidden = false; hereEl.innerHTML = '<div class="h-sub">Finding your location…</div>';
  }
  function stopTracking() {
    map.stopLocate();
    Object.assign(fieldMode, { on: false, follow: false, last: null });
    if (meMarker) { map.removeLayer(meMarker); meMarker = null; }
    hereEl.hidden = true;
  }
  map.on('dragstart', () => { if (fieldMode.on && fieldMode.follow) { fieldMode.follow = false; paintLocate(); } });

  let meMarker = null, meDot = null, meAcc = null;
  map.on('locationfound', (e) => {
    if (!fieldMode.on) return;
    fieldMode.last = e;
    if (!meMarker) {
      meAcc = L.circle(e.latlng, { radius: e.accuracy, weight: 1, color: '#1976d2', fillOpacity: 0.1, interactive: false });
      meDot = L.circleMarker(e.latlng, { radius: 8, color: '#fff', weight: 3, fillColor: '#1976d2', fillOpacity: 1, interactive: false });
      meMarker = L.layerGroup([meAcc, meDot]).addTo(map);
    } else { meAcc.setLatLng(e.latlng).setRadius(e.accuracy); meDot.setLatLng(e.latlng); }
    if (fieldMode.first) { fieldMode.first = false; map.setView(e.latlng, Math.max(map.getZoom(), 15)); }
    else if (fieldMode.follow && !map.getBounds().pad(-0.25).contains(e.latlng)) map.panTo(e.latlng);
    updateHere(e);
  });
  map.on('locationerror', (e) => {
    if (!fieldMode.on) return;
    const denied = e.code === 1;
    if (denied) { stopTracking(); paintLocate(); }
    hereEl.hidden = false;
    hereEl.innerHTML = `<div class="h-sub">${denied ? 'Location permission is off — allow it in your browser/phone settings.' : 'Location unavailable: ' + esc(e.message)}</div>`;
    if (denied) setTimeout(() => { if (!fieldMode.on) hereEl.hidden = true; }, 6000);
  });

  // Point-in-polygon (lng/lat rings, holes respected)
  function inRing([x, y], ring) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const [xi, yi] = ring[i], [xj, yj] = ring[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }
  function inGeom(pt, g) {
    if (!g) return false;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.type === 'MultiPolygon' ? g.coordinates : [];
    return polys.some((poly) => inRing(pt, poly[0]) && !poly.slice(1).some((h) => inRing(pt, h)));
  }
  const LAND_LABELS = [
    ['gems', (p) => `GEMS: ${p.PropertyName || ''}`], ['stateForest', (p) => `State Forest${p.FCKey ? ' · compartment ' + p.FCKey : ''}`],
    ['wildlife', (p) => p.OfficialWLDProjectAreaName || 'State wildlife area'], ['parks', (p) => p.Facility || 'State park (huntable)'],
    ['fedLand', (p) => p.Unit_Name || 'National Forest'], ['cfr', () => 'Commercial Forest (foot access)'], ['hap', () => 'Hunter Access Program land'],
  ];
  function updateHere(e) {
    const pt = [e.latlng.lng, e.latlng.lat];
    const [px, py] = proj(pt);
    let best = null;
    for (const r of records.values()) {
      const b = r.bbox;
      if (px < b[0] || px > b[2] || py < b[1] || py > b[3]) continue;
      if (!inGeom(pt, r.feature.geometry)) continue;
      if (!best || (best.kind === 'usfs' && r.kind === 'stand')) best = r;
    }
    const lands = [];
    let landChecked = false;
    for (const [k, fmt] of LAND_LABELS) {
      const layer = L_[k];
      if (!layer.visible) continue;
      landChecked = true;
      for (const f of layer.features.values()) if (inGeom(pt, f.geometry)) { lands.push(fmt(f.properties)); break; }
    }
    const standLine = best
      ? `<span class="h-score" style="background:${rampColor(best.score)};${best.score >= 80 ? 'color:#fff' : ''}">${best.score}</span> ${esc(label(best))}`
      : `<span class="h-score" style="background:#ccc">–</span> No stand data here`;
    const landLine = !landChecked ? '' : lands.length
      ? `<div class="h-land ok">✓ ${esc(lands.join(' · '))}</div>`
      : `<div class="h-land warn">⚠ Not on mapped public land — check boundaries</div>`;
    hereEl.hidden = false;
    hereEl.innerHTML = `<div class="h-main">${standLine}</div>${landLine}<div class="h-sub">±${Math.round(e.accuracy)} m${
      navigator.onLine === false ? ' · offline' : ''}</div>`;
    if (best) hereEl.onclick = () => best.feature._layer.openPopup(best.center || e.latlng);
  }

  // ---------------------------------------------------------------------------
  // Import onX GPX / KML
  // ---------------------------------------------------------------------------
  const importInfo = document.getElementById('importInfo');
  let imports = store.get('grouse.imports', []);
  function renderImports(fit) {
    importGroup.clearLayers();
    let count = 0;
    for (const im of imports) {
      try {
        const dom = new DOMParser().parseFromString(im.text, 'text/xml');
        const gj = im.kind === 'kml' ? toGeoJSON.kml(dom) : toGeoJSON.gpx(dom);
        importGroup.addData(gj); count += gj.features.length;
      } catch (err) { console.warn('import failed', im.name, err); }
    }
    importInfo.textContent = imports.length ? `${imports.length} file(s), ${count} features: ${imports.map((i) => i.name).join(', ')}` :
      'Export from onX (Markups → Export) and drop the file here or on the map.';
    if (fit && importGroup.getLayers().length) map.fitBounds(importGroup.getBounds(), { maxZoom: 15, padding: [30, 30] });
  }
  async function addFiles(files) {
    for (const file of files) {
      const kind = /\.kml$/i.test(file.name) ? 'kml' : /\.gpx$/i.test(file.name) ? 'gpx' : null;
      if (!kind) continue;
      imports.push({ name: file.name, kind, text: await file.text() });
    }
    if (!store.set('grouse.imports', imports)) importInfo.textContent = 'Too large to remember between visits — shown for this session only.';
    renderImports(true);
  }
  document.getElementById('importFile').addEventListener('change', (e) => addFiles([...e.target.files]));
  document.getElementById('clearImports').addEventListener('click', () => { imports = []; store.set('grouse.imports', imports); renderImports(false); });
  const mapEl = document.getElementById('map');
  mapEl.addEventListener('dragover', (e) => e.preventDefault());
  mapEl.addEventListener('drop', (e) => { e.preventDefault(); addFiles([...e.dataTransfer.files]); });
  renderImports(false);

  // ---------------------------------------------------------------------------
  // Export top spots for onX
  // ---------------------------------------------------------------------------
  const xml = (s) => String(s ?? '').replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  function download(name, text, type) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type }));
    a.download = name; document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  document.getElementById('exportGpx').addEventListener('click', () => {
    const top = topSpots(60);
    if (!top.length) { statusEl.textContent = 'Nothing to export — zoom in and lower the threshold.'; return; }
    const wpts = top.map((r) => `  <wpt lat="${r.center.lat.toFixed(6)}" lon="${r.center.lng.toFixed(6)}">
    <name>${xml(`G${r.score} ${label(r)}`)}</name>
    <desc>${xml(r.reasons.join('; '))}</desc>
  </wpt>`).join('\n');
    download(`grouse-spots-${stamp()}.gpx`, `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Grouse Cover Finder" xmlns="http://www.topografix.com/GPX/1/1">
${wpts}
</gpx>`, 'application/gpx+xml');
  });
  document.getElementById('exportKml').addEventListener('click', () => {
    const top = topSpots(60);
    if (!top.length) { statusEl.textContent = 'Nothing to export — zoom in and lower the threshold.'; return; }
    const kmlColor = (hex) => 'aa' + hex.slice(5, 7) + hex.slice(3, 5) + hex.slice(1, 3);
    const pms = top.map((r) => {
      const polys = ringsOf(r.feature.geometry).length ? (r.feature.geometry.type === 'Polygon' ? [r.feature.geometry.coordinates] : r.feature.geometry.coordinates) : [];
      const geo = polys.map((poly) => `<Polygon><outerBoundaryIs><LinearRing><coordinates>${poly[0].map((c) => `${c[0].toFixed(6)},${c[1].toFixed(6)},0`).join(' ')}</coordinates></LinearRing></outerBoundaryIs></Polygon>`).join('');
      return `<Placemark><name>${xml(`G${r.score} ${label(r)}`)}</name><description>${xml(r.reasons.join('; '))}</description>
<Style><LineStyle><color>ff${kmlColor(rampColor(r.score)).slice(2)}</color><width>2</width></LineStyle><PolyStyle><color>${kmlColor(rampColor(r.score)).replace(/^aa/, '55')}</color></PolyStyle></Style>
${polys.length > 1 ? `<MultiGeometry>${geo}</MultiGeometry>` : geo}</Placemark>`;
    }).join('\n');
    download(`grouse-spots-${stamp()}.kml`, `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>Grouse spots ${stamp()}</name>
${pms}
</Document></kml>`, 'application/vnd.google-earth.kml+xml');
  });

  // ---------------------------------------------------------------------------
  // Offline: save an area (data + topo tiles) before heading out
  // ---------------------------------------------------------------------------
  const offlineInfo = document.getElementById('offlineInfo');
  const areasEl = document.getElementById('areas');
  const saveBtn = document.getElementById('saveArea');
  const USGS_TILE = 'https://basemap.nationalmap.gov/arcgis/rest/services/USGSTopo/MapServer/tile/{z}/{y}/{x}';
  const MAX_TILES = 5000;

  async function refreshOfflineInfo() {
    const [n, s, areas] = await Promise.all([OfflineStore.count(), OfflineTiles.storageInfo(), OfflineStore.areas()]);
    const swOk = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
    offlineInfo.textContent = `${n.toLocaleString()} map features stored${s ? ` · ${s.usageMB.toFixed(0)} MB used` : ''}` +
      (swOk ? '' : ' · tile caching starts after the app reloads once');
    areasEl.innerHTML = '';
    for (const a of areas.sort((x, y) => y.id - x.id)) {
      const li = document.createElement('li');
      li.innerHTML = `<span><div>${esc(a.name)}</div><div class="meta">${new Date(a.id).toLocaleDateString()} · ${a.features.toLocaleString()} features · ${a.tiles.toLocaleString()} tiles (to z${a.zMax})</div></span>
        <button class="btn" type="button" data-go>Go</button><button class="btn" type="button" data-del aria-label="Remove">✕</button>`;
      li.querySelector('[data-go]').addEventListener('click', () => {
        map.fitBounds(L.latLngBounds(a.bounds)); panel.classList.remove('open');
      });
      li.querySelector('[data-del]').addEventListener('click', async () => { await OfflineStore.deleteArea(a.id); refreshOfflineInfo(); });
      areasEl.appendChild(li);
    }
  }

  async function saveArea() {
    if (map.getZoom() < 11) { offlineInfo.textContent = 'Zoom in to about a township or two (zoom 11+) first.'; return; }
    if (navigator.onLine === false) { offlineInfo.textContent = 'You need a connection to save an area.'; return; }
    saveBtn.disabled = true;
    const bounds = map.getBounds();
    await OfflineTiles.requestPersistence();
    let features = 0;
    try {
      // 1) Feature data for every layer
      const layers = Object.entries(L_);
      for (let i = 0; i < layers.length; i++) {
        offlineInfo.textContent = `Saving map data ${i + 1}/${layers.length}…`;
        try { features += await layers[i][1].saveArea(bounds); } catch (err) { console.warn('save failed', layers[i][0], err); }
      }
      // 2) USGS topo tiles (public domain) — as deep as fits under the tile cap
      let zMax = 16, topo;
      const zMin = Math.max(8, Math.min(map.getZoom() - 2, 12));
      do { topo = OfflineTiles.tileUrls(USGS_TILE, bounds, zMin, zMax); } while (topo.length > MAX_TILES && --zMax > zMin);
      // 3) Canopy-loss tiles (native to z12)
      const loss = OfflineTiles.tileUrls(lossLayer._url, bounds, Math.min(zMin, 12), 12);
      const urls = topo.concat(loss);
      const res = await OfflineTiles.prefetch(urls, (d, t) => { offlineInfo.textContent = `Saving map tiles ${d.toLocaleString()} / ${t.toLocaleString()}…`; });
      const c = bounds.getCenter();
      await OfflineStore.saveAreaRecord({
        id: Date.now(), name: `Near ${c.lat.toFixed(3)}, ${c.lng.toFixed(3)}`,
        bounds: [[bounds.getSouth(), bounds.getWest()], [bounds.getNorth(), bounds.getEast()]],
        features, tiles: res.ok + res.skipped, zMax,
      });
      await refreshOfflineInfo();
      offlineInfo.textContent = `Saved: ${features.toLocaleString()} features, ${(res.ok + res.skipped).toLocaleString()} tiles (topo to zoom ${zMax})` +
        (res.fail ? `, ${res.fail} tiles failed` : '') + '. Use the USGS Topo basemap offline.';
      L_.stands.restyle(); updateTop();
    } finally {
      saveBtn.disabled = false;
    }
  }
  saveBtn.addEventListener('click', saveArea);
  document.getElementById('clearOffline').addEventListener('click', async () => {
    if (!confirm('Delete all saved offline maps and data from this device?')) return;
    await OfflineStore.clearAll(); refreshOfflineInfo();
  });
  window.addEventListener('online', refreshAll);
  window.addEventListener('offline', () => { statusEl.textContent = 'No signal — showing saved data.'; });

  // Install: service worker + install prompts
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    navigator.serviceWorker.register('sw.js').then(() => navigator.serviceWorker.ready).then(refreshOfflineInfo)
      .catch((err) => console.warn('service worker failed', err));
  }
  const installBtn = document.getElementById('installBtn');
  const installHint = document.getElementById('installHint');
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  let deferredPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; installBtn.hidden = false; });
  installBtn.addEventListener('click', async () => { if (!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt = null; installBtn.hidden = true; });
  if (!standalone && /iPhone|iPad|iPod/.test(navigator.userAgent)) installHint.hidden = false;

  refreshOfflineInfo();
  refreshAll();
  window.__grouse = { map, records, L_, state }; // for debugging in the console
})();
