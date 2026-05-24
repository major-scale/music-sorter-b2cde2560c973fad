// Global ranking from pairwise comparisons: Elo seeding + Swiss (adaptive) pairing.
// Pure, side-effect-free → unit-testable. window.Ranking = { pairKey, elo, swissRound }.
(function () {
  "use strict";

  function pairKey(a, b) { return a < b ? a + "|" + b : b + "|" + a; }

  // comps: [{a, b, verdict(-2..2, negative = A better)}] over a set of ids.
  // Multi-pass shuffled Elo → order-stable global rating per id. Decisive verdicts (±2) update harder.
  function elo(ids, comps, opts) {
    opts = opts || {};
    const passes = opts.passes || 30, base = opts.base || 1500, bases = opts.bases || null;
    const R = {}; ids.forEach((id) => { R[id] = (bases && bases[id] != null) ? bases[id] : base; });   // tier priors so a global ranking respects LOVE>MID>SLOP before cross-tier battles exist
    const games = [];
    (comps || []).forEach((c) => {
      if (!(c.a in R) || !(c.b in R)) return;
      const v = Math.max(-2, Math.min(2, Number(c.verdict) || 0));
      games.push({ a: c.a, b: c.b, sa: v < 0 ? 1 : v > 0 ? 0 : 0.5, k: Math.abs(v) >= 2 ? 32 : 22 });
    });
    for (let p = 0; p < passes; p++) {
      for (let i = games.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0; const t = games[i]; games[i] = games[j]; games[j] = t; }
      games.forEach((g) => {
        const ea = 1 / (1 + Math.pow(10, (R[g.b] - R[g.a]) / 400));
        const d = g.k * (g.sa - ea);
        R[g.a] += d; R[g.b] -= d;
      });
    }
    return R;
  }

  // Swiss/playoff pairing: sort by rating, pair each unpaired track with the nearest lower-ranked
  // one it hasn't faced yet (winners vs winners, losers vs losers). Falls back to a repeat if all faced.
  function swissRound(ids, R, comparedSet) {
    comparedSet = comparedSet || new Set();
    const ranked = ids.slice().sort((x, y) => (R[y] || 0) - (R[x] || 0));
    const used = new Set(), round = [];
    for (let i = 0; i < ranked.length; i++) {
      if (used.has(ranked[i])) continue;
      let pick = -1, repeat = -1;
      for (let j = i + 1; j < ranked.length; j++) {
        if (used.has(ranked[j])) continue;
        if (!comparedSet.has(pairKey(ranked[i], ranked[j]))) { pick = j; break; }
        if (repeat < 0) repeat = j;
      }
      if (pick < 0) pick = repeat;
      if (pick < 0) continue;
      used.add(ranked[i]); used.add(ranked[pick]);
      round.push({ a: ranked[i], b: ranked[pick] });
    }
    return round;
  }

  // Flexible playoff round: mostly nearest-rank within tier (exploit), with ~wildcard fraction of "wildcards" (explore) —
  // within-tier gap-jumps AND cross-tier BOUNDARY matchups (weakest of a tier vs strongest of the next-lower tier).
  // pools: ordered high→low [{tier, ids}]. Returns [{a,b,tier} | {a,b,cross:[hiTier,loTier]}].
  function flexibleRound(pools, R, comparedSet, opts) {
    opts = opts || {};
    const wildcard = opts.wildcard != null ? opts.wildcard : 0.3, maxGap = opts.maxGap || 3, upset = opts.upset != null ? opts.upset : 0.2;
    comparedSet = comparedSet || new Set();
    const used = new Set(), round = [];
    const faced = (a, b) => comparedSet.has(pairKey(a, b));
    const ranked = pools.map((p) => ({ tier: p.tier, list: p.ids.slice().sort((x, y) => (R[y] || 0) - (R[x] || 0)) }));
    // (0) rare long-shot UPSET check: a far-apart pair (>=2 tiers apart, e.g. LOVE vs SLOP) — strongest of the high tier
    //     vs weakest of the low tier, so the result is usually obvious but a surprise is a big, informative shock.
    if (Math.random() < upset && ranked.length >= 3) {
      outer:
      for (let hi = 0; hi <= ranked.length - 3; hi++) {
        for (let lo = ranked.length - 1; lo >= hi + 2; lo--) {
          for (const a of ranked[hi].list) {
            if (used.has(a)) continue;
            for (let k = ranked[lo].list.length - 1; k >= 0; k--) {
              const b = ranked[lo].list[k];
              if (used.has(b) || faced(a, b)) continue;
              used.add(a); used.add(b); round.push({ a, b, cross: [ranked[hi].tier, ranked[lo].tier], upset: true });
              break outer;
            }
          }
        }
      }
    }
    // (1) occasional cross-tier boundary matchups
    for (let t = 0; t < ranked.length - 1; t++) {
      if (Math.random() >= wildcard) continue;
      const hi = ranked[t].list, lo = ranked[t + 1].list;
      let a = null; for (let i = hi.length - 1; i >= 0; i--) if (!used.has(hi[i])) { a = hi[i]; break; }   // weakest of higher tier
      let b = null; for (let j = 0; j < lo.length; j++) if (!used.has(lo[j])) { b = lo[j]; break; }        // strongest of lower tier
      if (a && b && !faced(a, b)) { used.add(a); used.add(b); round.push({ a, b, cross: [ranked[t].tier, ranked[t + 1].tier] }); }
    }
    // (2) within tier: usually the nearest unused partner, sometimes a gap-jump
    for (const { tier, list } of ranked) {
      for (let i = 0; i < list.length; i++) {
        if (used.has(list[i])) continue;
        const cands = []; for (let j = i + 1; j < list.length; j++) if (!used.has(list[j])) cands.push(j);
        if (!cands.length) continue;
        const fresh = cands.filter((j) => !faced(list[i], list[j]));
        const src = fresh.length ? fresh : cands;
        let j;
        if (Math.random() < wildcard && src.length > 1) {
          const gapped = src.filter((jj) => jj - i >= 2 && jj - i <= maxGap);
          const from = gapped.length ? gapped : src; j = from[Math.floor(Math.random() * from.length)];
        } else j = src[0];
        used.add(list[i]); used.add(list[j]); round.push({ a: list[i], b: list[j], tier });
      }
    }
    return round;
  }

  window.Ranking = { pairKey, elo, swissRound, flexibleRound };
})();
