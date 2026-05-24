// Round 2 self-check. window.round2Health() returns a structured sanity report over the
// collected rich-annotation data — run in the console, or pull via chrome-devtools for
// remote checking. Pure read; no side effects.

window.round2Health = function () {
  const R = window.Ratings;
  if (!R) return { error: "Ratings not loaded" };
  const all = R.getAll();   // all v2 records (test + rich-v1)
  const comps = R.getComparisons ? R.getComparisons() : [];
  const CONF = ["sure", "think_so", "guess"], FAM = ["novel", "known"];
  const CLASS = ["LOVE", "MID", "SLOP"], SEGL = ["love", "mid", "slop"];
  const VERD = [-2, -1, 0, 1, 2];
  const anomalies = [];
  let withSeg = 0, segTotal = 0, withConf = 0, withFam = 0, withAnchor = 0;
  const labelDist = {}, confDist = {}, famDist = {}, segLabelDist = {};

  for (const r of all) {
    labelDist[r.rating_3class] = (labelDist[r.rating_3class] || 0) + 1;
    if (r.confidence) {
      withConf++; confDist[r.confidence] = (confDist[r.confidence] || 0) + 1;
      if (!CONF.includes(r.confidence)) anomalies.push(`bad confidence "${r.confidence}" on ${r.youtube_id}`);
    }
    if (r.is_familiar) {
      withFam++; famDist[r.is_familiar] = (famDist[r.is_familiar] || 0) + 1;
      if (!FAM.includes(r.is_familiar)) anomalies.push(`bad familiarity "${r.is_familiar}" on ${r.youtube_id}`);
    }
    if (r.neutral_anchor_seconds != null) {
      withAnchor++;
      if (r.neutral_anchor_seconds < 0) anomalies.push(`negative anchor on ${r.youtube_id}`);
    }
    const segs = r.segments || [];
    if (segs.length) withSeg++;
    for (const s of segs) {
      segTotal++;
      segLabelDist[s.label] = (segLabelDist[s.label] || 0) + 1;
      if (!(s.start_s >= 0 && s.end_s > s.start_s)) anomalies.push(`segment start>=end on ${r.youtube_id}: ${s.start_s}–${s.end_s}`);
      if (!SEGL.includes(s.label)) anomalies.push(`bad seg label "${s.label}" on ${r.youtube_id}`);
    }
    if (segs.length && !CLASS.includes(r.rating_3class)) anomalies.push(`segments but no LOVE/MID/SLOP label on ${r.youtube_id}`);
  }
  for (const c of comps) {
    if (c.a_id === c.b_id) anomalies.push(`comparison a==b: ${c.a_id}`);
    if (!VERD.includes(c.verdict)) anomalies.push(`bad verdict ${c.verdict} (${c.a_id} vs ${c.b_id})`);
  }
  return {
    rated_total: all.length, with_segments: withSeg, segments_total: segTotal,
    with_confidence: withConf, with_familiarity: withFam, with_neutral_anchor: withAnchor,
    comparisons: comps.length, comparisons_test: comps.filter((c) => c.test_mode).length,
    pass_dist: all.reduce((a, r) => { const k = r.annotation_pass || "(none)"; a[k] = (a[k] || 0) + 1; return a; }, {}),
    label_dist: labelDist, confidence_dist: confDist, familiarity_dist: famDist, seg_label_dist: segLabelDist,
    anomalies, ok: anomalies.length === 0,
  };
};

// Remove test-mode ratings (annotation_pass==="test"); reports remaining test comparisons.
window.clearTestData = function () {
  const R = window.Ratings; if (!R) return { error: "Ratings not loaded" };
  let removed = 0;
  for (const r of R.getAll()) if (r.annotation_pass === "test") { R.deleteRating(r.youtube_id); removed++; }
  const testComps = R.getComparisons().filter((c) => c.test_mode).length;
  return { removed_test_ratings: removed, test_comparisons_flagged: testComps };
};
