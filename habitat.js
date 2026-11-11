/*
 * Ruffed grouse habitat model.
 *
 * Scores a forest stand 0–100 for how likely it is to hold grouse during the
 * hunting season. Every number here is a tunable guess built from the research
 * summarized in README.md — edit freely as you learn your coverts.
 *
 * Inputs come from the Michigan DNR forest inventory (MI-Hunt "Stand Cover
 * Types" layer) or from USFS harvest records, normalized into:
 *   { cover, age, sizeDensity, acres, source }
 */
(function () {
  const NOW_YEAR = new Date().getFullYear();

  // --- Cover type groups (DNR "CoverType" values) ---------------------------
  const GROUPS = {
    aspen: ['Aspen', 'Lowland Aspen/Balsam Poplar', 'Paper Birch'],
    mixedDecid: ['Mixed Upland Deciduous', 'Upland Mixed Forest', 'Lowland Mixed Forest'],
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
  const GROUP_OF = {};
  for (const [g, list] of Object.entries(GROUPS)) list.forEach((c) => (GROUP_OF[c] = g));
  function groupOf(cover) { return GROUP_OF[cover] || 'none'; }

  // --- Age response curves ----------------------------------------------------
  // Young aspen regrowth: suckers need ~4 years to get dense enough to hide
  // birds; stem density peaks around 6–15 years and drops below ~2,000
  // stems/acre after ~25. Mature aspen (25–50) is drumming cover and its male
  // flower buds are the main late-fall/winter food.
  // Peaks at 80 so neighbor bonuses (up to ~30) separate the truly great
  // coverts — young aspen *with* alder, conifer and mixed ages — from the rest.
  function aspenCurve(age, season) {
    if (age <= 2) return 12;
    if (age <= 5) return 45;
    if (age <= 15) return 80;
    if (age <= 20) return 70;
    if (age <= 25) return 55;
    if (age <= 50) return season === 'late' ? 45 : 32;
    return 18;
  }

  // Generic regrowth curve for cuts where species is unknown (USFS harvests).
  function regenCurve(age, season) { return Math.round(aspenCurve(age, season) * 0.85); }

  function baseScore(group, age, season) {
    switch (group) {
      case 'aspen': return aspenCurve(age, season);
      case 'mixedDecid': return Math.round(aspenCurve(age, season) * 0.75);
      case 'hardwood': return age <= 15 ? 48 : age <= 25 ? 30 : 12;
      case 'oak': return age <= 15 ? 40 : 15;
      case 'alder': return 58; // tag alder runs: dense cover, worms, classic edge birds
      case 'shrub': return 48; // hazel, dogwood, berries
      case 'lowDecid': return age <= 20 ? 40 : 24;
      case 'conifer':
        // Thermal / snow-roost cover. Matters more once leaves drop.
        if (age <= 20) return season === 'late' ? 45 : 35; // dense young spruce/fir
        return season === 'late' ? 35 : 15;
      case 'pine': return age <= 15 ? 30 : 8; // plantations are near-sterile for grouse
      case 'open': return 10; // value is the edge, handled by neighbor bonus
      default: return 0;
    }
  }

  // Stem density proxy from DNR size/density class.
  function densityMultiplier(sizeDensity) {
    if (!sizeDensity) return 1;
    const s = sizeDensity.toLowerCase();
    const young = s.startsWith('sapling') || s.startsWith('pole');
    if (!young) return 1;
    if (s.includes('poor')) return 0.75;
    if (s.includes('medium')) return 0.9;
    return 1;
  }

  // Fallback age when DominantAge is missing.
  function estimateAge(a) {
    if (Number.isFinite(a.DominantAge) && a.DominantAge > 0) return a.DominantAge;
    if (Number.isFinite(a.FirstOriginYear) && a.FirstOriginYear > 1800) return NOW_YEAR - a.FirstOriginYear;
    const s = (a.OverallSize || a.SizeDensityDescription || '').toLowerCase();
    if (s.startsWith('sapling')) return 10;
    if (s.startsWith('pole')) return 35;
    if (s.startsWith('saw') || s.startsWith('log')) return 60;
    return null;
  }

  /**
   * Score a stand by itself (no neighbors).
   * stand: { cover, group, age, sizeDensity, ageNote }
   * returns { score, reasons[] }
   */
  function standScore(stand, season) {
    const reasons = [];
    const g = stand.group;
    if (g === 'none') return { score: 0, reasons: ['Not grouse cover (' + (stand.cover || 'unknown') + ')'] };
    if (stand.age == null) {
      // Unknown age — give the type a middling score.
      const s = Math.round(baseScore(g, 30, season) * 0.8);
      return { score: s, reasons: [stand.cover + ', age unknown'] };
    }
    let s = baseScore(g, stand.age, season);
    reasons.push(`${stand.cover}, ~${stand.age} yrs → ${s}`);
    if (stand.ageNote) reasons.push(stand.ageNote);
    const m = densityMultiplier(stand.sizeDensity);
    if (m !== 1) {
      s = Math.round(s * m);
      reasons.push(`${stand.sizeDensity} stocking ×${m}`);
    }
    return { score: s, reasons };
  }

  // Neighbor bonuses: grouse use the *mix* — young aspen next to alder, with
  // conifer cover and mature aspen within a short flight.
  function neighborBonus(stand, neighbors, season) {
    let bonus = 0;
    const reasons = [];
    const has = (pred) => neighbors.some(pred);
    const isYoungAspen = (n) => (n.group === 'aspen' || n.group === 'mixedDecid') && n.age != null && n.age >= 4 && n.age <= 20;
    const isMatureAspen = (n) => n.group === 'aspen' && n.age != null && n.age >= 25 && n.age <= 60;
    const selfYoung = isYoungAspen(stand);
    const selfMature = isMatureAspen(stand);

    if (has((n) => n.group === 'conifer')) {
      const b = season === 'late' ? 12 : 5;
      bonus += b; reasons.push(`Conifer cover adjacent +${b}`);
    }
    if (stand.group !== 'alder' && has((n) => n.group === 'alder')) {
      bonus += 8; reasons.push('Alder/lowland shrub adjacent +8');
    }
    if ((selfYoung && has(isMatureAspen)) || (selfMature && has(isYoungAspen))) {
      bonus += 8; reasons.push('Mixed aspen age classes adjacent +8');
    }
    if (stand.group === 'alder' && has(isYoungAspen)) {
      bonus += 10; reasons.push('Young aspen adjacent +10');
    }
    if (has((n) => n.group === 'open' || n.group === 'shrub')) {
      bonus += 4; reasons.push('Opening / shrub edge adjacent +4');
    }
    return { bonus, reasons };
  }

  function scoreWithNeighbors(stand, neighbors, season) {
    const base = standScore(stand, season);
    if (base.score === 0 && stand.group === 'none') return base;
    // Neighbors only help stands that are cover themselves.
    if (base.score < 15) return base;
    const nb = neighborBonus(stand, neighbors, season);
    return {
      score: Math.min(100, base.score + nb.bonus),
      reasons: base.reasons.concat(nb.reasons),
    };
  }

  // USFS regeneration cuts (clearcut, coppice, seed-tree, overstory removal…)
  // reset a stand to early successional; thinning/selection barely do.
  const REGEN_RE = /clearcut|coppice|seed-tree|overstory removal|shelterwood removal|establishment and removal|patch/i;
  function usfsHarvestToStand(p) {
    const done = p.date_completed ? new Date(p.date_completed).getFullYear() : null;
    const age = done ? NOW_YEAR - done : null;
    const regen = REGEN_RE.test(p.activity_name || '');
    return {
      cover: regen ? 'USFS regeneration cut' : 'USFS partial cut',
      group: regen ? 'usfsRegen' : 'usfsPartial',
      age,
      sizeDensity: null,
    };
  }
  function usfsScore(stand, season) {
    if (stand.age == null) return { score: 0, reasons: ['No completion date'] };
    if (stand.group === 'usfsRegen') {
      const s = regenCurve(stand.age, season);
      return { score: s, reasons: [`${stand.cover}, cut ~${stand.age} yrs ago → ${s}`, 'Species unknown (USFS) ×0.85'] };
    }
    const s = stand.age <= 12 ? 25 : 12;
    return { score: s, reasons: [`${stand.cover} ~${stand.age} yrs ago → ${s}`] };
  }

  window.Habitat = {
    NOW_YEAR, GROUPS, groupOf, estimateAge, standScore, scoreWithNeighbors,
    usfsHarvestToStand, usfsScore,
  };
})();
