/*
 * Ruffed grouse habitat model (research-based defaults).
 *
 * Every default below is explained, with sources, in the report
 * "Ruffed Grouse in the Upper Midwest: A Field Reference" (section
 * "From research to the app"). Short version:
 *   - Young aspen 6–20 yrs is peak cover (Kubisiak 1985; Gullion; MI DNR 2016).
 *   - Alder next to aspen multiplies density (Kubisiak: 11.1 vs 2.2 drummers/100 ac).
 *   - Mature male aspen within ~330 ft of young aspen (Gullion 1986).
 *   - Upland–lowland transitions hold most birds (Berner 1969, Wexford Co.).
 *   - Young conifer helps in thin-snow late season; mature conifer hurts (Vispo 1995; Gullion).
 *
 * The same scoring runs on live stands (zoomed in) and on the statewide
 * summary (zoomed out), so neighbor information is passed in as flags.
 */
(function () {
  const NOW_YEAR = new Date().getFullYear();

  // --- Defaults (sliders can override) --------------------------------------
  const DEFAULTS = {
    // Aspen age curve
    aspenPeakStart: 6, aspenPeakEnd: 20,
    aspenPeak: 75, aspenLate: 60, aspenYoung: 35, aspenFresh: 10,
    aspenMatureEarly: 25, aspenMatureLate: 35, aspenOld: 15,
    birchFactor: 0.8, mixedFactor: 0.65,
    // Other cover types
    uplandShrub: 50, alder: 45,
    nhYoung: 40, nhMid: 25, nhOld: 8,
    lowDecidYoung: 35, lowDecidOld: 30,
    oakYoung: 25, oakOld: 12,
    coniferYoung: 25, coniferOld: 8,
    pineYoung: 12, pineMid: 18, pineOld: 3,
    open: 5,
    // Stand adjustments
    stockPoor: 0.75, stockMedium: 0.9,
    size20: 0.9, size40: 0.8, size80: 0.7,
    // Neighbors within ~330 ft
    nbAlder: 15, nbMatureEarly: 12, nbMatureLate: 15, nbTransition: 6,
    nbYoungConiferLate: 5, nbMatureConifer: -5, nbShrubEarly: 3,
    // USFS regeneration cuts (species unknown)
    usfsFactor: 0.85,
  };
  let W = Object.assign({}, DEFAULTS);
  function setWeights(overrides) { W = Object.assign({}, DEFAULTS, overrides || {}); }
  function weights() { return W; }

  // Slider definitions for the "Tune the model" panel.
  const SLIDERS = [
    { group: 'Young aspen', key: 'aspenPeak', label: 'Peak score, young aspen', min: 30, max: 100, step: 5 },
    { group: 'Young aspen', key: 'aspenPeakStart', label: 'Peak starts at age', min: 3, max: 12, step: 1, unit: 'yr' },
    { group: 'Young aspen', key: 'aspenPeakEnd', label: 'Peak ends at age', min: 12, max: 30, step: 1, unit: 'yr' },
    { group: 'Other cover', key: 'aspenMatureLate', label: 'Mature aspen (late season)', min: 0, max: 75, step: 5 },
    { group: 'Other cover', key: 'alder', label: 'Alder / lowland shrub', min: 0, max: 75, step: 5 },
    { group: 'Other cover', key: 'uplandShrub', label: 'Upland shrub (hazel, dogwood)', min: 0, max: 75, step: 5 },
    { group: 'Other cover', key: 'nhYoung', label: 'Young northern hardwood', min: 0, max: 75, step: 5 },
    { group: 'Other cover', key: 'oakYoung', label: 'Young oak', min: 0, max: 75, step: 5 },
    { group: 'Other cover', key: 'coniferYoung', label: 'Young conifer', min: 0, max: 75, step: 5 },
    { group: 'Neighbors', key: 'nbAlder', label: 'Alder next door', min: 0, max: 30, step: 1, signed: true },
    { group: 'Neighbors', key: 'nbMatureLate', label: 'Mature aspen next door', min: 0, max: 30, step: 1, signed: true },
    { group: 'Neighbors', key: 'nbTransition', label: 'Upland–lowland transition', min: 0, max: 20, step: 1, signed: true },
    { group: 'Neighbors', key: 'nbMatureConifer', label: 'Mature conifer next door', min: -20, max: 10, step: 1, signed: true },
  ];

  // --- Cover groups (DNR "CoverType") ----------------------------------------
  const GROUPS = {
    aspen: ['Aspen'],
    lowAspen: ['Lowland Aspen/Balsam Poplar'],
    birch: ['Paper Birch'],
    mixed: ['Mixed Upland Deciduous', 'Upland Mixed Forest', 'Lowland Mixed Forest'],
    hardwood: ['Northern Hardwood'],
    oak: ['Oak'],
    alder: ['Lowland Shrub'],
    shrub: ['Upland Shrub'],
    lowDecid: ['Lowland Deciduous'],
    conifer: ['Cedar', 'Lowland Conifers', 'Lowland Spruce/Fir', 'Hemlock', 'Upland Spruce/Fir',
      'Upland Conifers', 'Tamarack', 'White Pine'],
    pine: ['Red Pine', 'Jack Pine', 'Natural Mixed Pines', 'Planted Mixed Pines'],
    open: ['Herbaceous Openland', 'Low-Density Trees'],
  };
  const GROUP_LIST = ['none', ...Object.keys(GROUPS), 'usfsRegen', 'usfsPartial'];
  const GROUP_OF = {};
  for (const [g, list] of Object.entries(GROUPS)) list.forEach((c) => (GROUP_OF[c] = g));
  const groupOf = (cover) => GROUP_OF[cover] || 'none';
  const LOWLAND_GROUPS = new Set(['lowAspen', 'alder', 'lowDecid']);

  // Neighbor classes (fixed thresholds, shared by live + statewide summary)
  const isAspenish = (g) => g === 'aspen' || g === 'lowAspen' || g === 'birch' || g === 'mixed' || g === 'usfsRegen';
  const isYoungAspen = (n) => isAspenish(n.group) && n.age != null && n.age >= 4 && n.age <= 25;
  const isMatureAspen = (n) => (n.group === 'aspen' || n.group === 'lowAspen') && n.age != null && n.age >= 26 && n.age <= 70;
  const isYoungConifer = (n) => (n.group === 'conifer' || n.group === 'pine') && n.age != null && n.age <= 20;
  const isMatureConifer = (n) => n.group === 'conifer' && n.age != null && n.age > 40;
  const isLowland = (n) => n.lowland || LOWLAND_GROUPS.has(n.group);

  // Flags bitmask
  const F = { alder: 1, matureAspen: 2, youngAspen: 4, lowland: 8, youngConifer: 16, matureConifer: 32, shrub: 64 };
  function flagsFromNeighbors(neighbors) {
    let f = 0;
    for (const n of neighbors) {
      if (n.group === 'alder') f |= F.alder;
      if (isMatureAspen(n)) f |= F.matureAspen;
      if (isYoungAspen(n)) f |= F.youngAspen;
      if (isLowland(n)) f |= F.lowland;
      if (isYoungConifer(n)) f |= F.youngConifer;
      if (isMatureConifer(n)) f |= F.matureConifer;
      if (n.group === 'shrub') f |= F.shrub;
    }
    return f;
  }

  // --- Base curves ------------------------------------------------------------
  function aspenCurve(age, season) {
    if (age <= 2) return W.aspenFresh;
    if (age < W.aspenPeakStart) return W.aspenYoung;
    if (age <= W.aspenPeakEnd) return W.aspenPeak;
    if (age <= Math.max(W.aspenPeakEnd + 5, 25)) return W.aspenLate;
    if (age <= 60) return season === 'late' ? W.aspenMatureLate : W.aspenMatureEarly;
    return W.aspenOld;
  }
  function baseScore(g, age, season) {
    switch (g) {
      case 'aspen': case 'lowAspen': return aspenCurve(age, season);
      case 'birch': return Math.round(aspenCurve(age, season) * W.birchFactor);
      case 'mixed': return Math.round(aspenCurve(age, season) * W.mixedFactor);
      case 'usfsRegen': return Math.round(aspenCurve(age, season) * W.usfsFactor);
      case 'usfsPartial': return age <= 12 ? 20 : 10;
      case 'hardwood': return age <= 15 ? W.nhYoung : age <= 25 ? W.nhMid : W.nhOld;
      case 'oak': return age <= 15 ? W.oakYoung : W.oakOld;
      case 'alder': return W.alder;
      case 'shrub': return W.uplandShrub;
      case 'lowDecid': return age <= 20 ? W.lowDecidYoung : W.lowDecidOld;
      case 'conifer': return age <= 20 ? W.coniferYoung : W.coniferOld;
      case 'pine': return age <= 12 ? W.pineYoung : age <= 30 ? W.pineMid : W.pineOld;
      case 'open': return W.open;
      default: return 0;
    }
  }
  const DECIDUOUS = new Set(['aspen', 'lowAspen', 'birch', 'mixed', 'hardwood', 'oak', 'usfsRegen']);

  /**
   * Score a stand.
   * s: { group, cover, age, stock ('well'|'medium'|'poor'|null), acres, lowland, transition, ageNote }
   * flags: neighbor bitmask (see F)
   * returns { score, reasons[] }
   */
  function score(s, flags, season) {
    const reasons = [];
    const g = s.group;
    if (g === 'none') return { score: 0, reasons: ['Not grouse cover (' + (s.cover || 'unknown') + ')'] };
    const age = s.age == null ? 30 : s.age;
    let v = baseScore(g, age, season);
    reasons.push(`${s.cover}, ${s.age == null ? 'age unknown' : '~' + s.age + ' yrs'} → ${v}`);
    if (s.ageNote) reasons.push(s.ageNote);
    if (s.age == null) { v = Math.round(v * 0.8); reasons.push('Unknown age ×0.8'); }

    // Stocking (sapling/pole stands)
    if (s.stock === 'poor') { v = Math.round(v * W.stockPoor); reasons.push(`Poor stocking ×${W.stockPoor}`); }
    else if (s.stock === 'medium') { v = Math.round(v * W.stockMedium); reasons.push(`Medium stocking ×${W.stockMedium}`); }

    // Large young deciduous cuts (Gullion: 20 ac ≈ 70% of 10 ac)
    if (DECIDUOUS.has(g) && age <= 25 && s.acres > 20) {
      const m = s.acres > 80 ? W.size80 : s.acres > 40 ? W.size40 : W.size20;
      v = Math.round(v * m); reasons.push(`Large young stand (${Math.round(s.acres)} ac) ×${m}`);
    }
    if (v < 10) return { score: v, reasons };

    // Neighbors
    const young = isYoungAspen(s), mature = isMatureAspen(s);
    const add = (pts, why) => { if (pts) { v += pts; reasons.push(`${why} ${pts > 0 ? '+' : ''}${pts}`); } };
    if ((isAspenish(g) || g === 'shrub') && flags & F.alder) add(W.nbAlder, 'Alder next door');
    else if (g === 'alder' && flags & F.youngAspen) add(W.nbAlder, 'Young aspen next door');
    if ((young && flags & F.matureAspen) || (mature && flags & F.youngAspen))
      add(season === 'late' ? W.nbMatureLate : W.nbMatureEarly, young ? 'Mature aspen next door' : 'Young aspen next door');
    if (s.transition || (!s.lowland && (flags & F.lowland) && g !== 'pine' && g !== 'open'))
      add(W.nbTransition, 'Upland–lowland transition');
    if (season === 'late' && flags & F.youngConifer) add(W.nbYoungConiferLate, 'Young conifer next door (late season)');
    if (flags & F.matureConifer) add(W.nbMatureConifer, 'Mature conifer next door (raptors)');
    if (season === 'early' && flags & F.shrub && g !== 'shrub') add(W.nbShrubEarly, 'Upland shrub next door (fruit)');
    return { score: Math.max(0, Math.min(100, Math.round(v))), reasons };
  }

  // --- Normalizers -------------------------------------------------------------
  function estimateAge(a) {
    if (Number.isFinite(a.DominantAge) && a.DominantAge > 0) return a.DominantAge;
    if (Number.isFinite(a.FirstOriginYear) && a.FirstOriginYear > 1800) return NOW_YEAR - a.FirstOriginYear;
    const s = (a.OverallSize || a.SizeDensityDescription || '').toLowerCase();
    if (s.startsWith('sapling')) return 10;
    if (s.startsWith('pole')) return 35;
    if (s.startsWith('saw') || s.startsWith('log')) return 60;
    return null;
  }
  function stockOf(sizeDensity) {
    const s = (sizeDensity || '').toLowerCase();
    if (!(s.startsWith('sapling') || s.startsWith('pole'))) return null;
    return s.includes('poor') ? 'poor' : s.includes('medium') ? 'medium' : 'well';
  }
  function standFromDNR(p) {
    const ul = p.UplandLowland || '';
    return {
      cover: p.CoverType, group: groupOf(p.CoverType), baseAge: estimateAge(p), stock: stockOf(p.SizeDensityDescription),
      acres: p.Acres || 0, lowland: ul.startsWith('Lowland'), transition: ul.includes('w/'),
    };
  }
  const REGEN_RE = /clearcut|coppice|seed-tree|overstory removal|shelterwood removal|establishment and removal|patch/i;
  function standFromUSFS(p) {
    const done = p.date_completed ? new Date(p.date_completed).getFullYear() : null;
    const regen = REGEN_RE.test(p.activity_name || '');
    return {
      cover: regen ? 'USFS regeneration cut' : 'USFS partial cut', group: regen ? 'usfsRegen' : 'usfsPartial',
      baseAge: done ? NOW_YEAR - done : null, stock: null, acres: p.gis_acres || 0, lowland: false, transition: false,
    };
  }

  window.Habitat = {
    NOW_YEAR, DEFAULTS, SLIDERS, GROUPS, GROUP_LIST, F, setWeights, weights, groupOf, estimateAge, stockOf,
    standFromDNR, standFromUSFS, flagsFromNeighbors, score, isYoungAspen, isMatureAspen,
  };
})();
