// JSON export — download / clipboard / Web Share API.

window.Exporter = (() => {
  function buildPayload() {
    const ratings = Ratings.getAll();
    const consistency = Ratings.getConsistency();
    const session = Ratings.getSession();
    const k = Ratings.kappa();

    const dates = ratings.map((r) => r.rated_at).sort();
    const deviceBreakdown = ratings.reduce((acc, r) => {
      acc[r.device] = (acc[r.device] || 0) + 1; return acc;
    }, {});

    return {
      metadata: {
        exported_at: new Date().toISOString(),
        total_tracks: ratings.length,
        rating_period_start: dates[0] || null,
        rating_period_end: dates[dates.length - 1] || null,
        device_breakdown: deviceBreakdown,
        consistency_kappa: k == null ? null : Number(k.toFixed(3)),
        consistency_pairs: consistency.length,
        comparisons: Ratings.getComparisons ? Ratings.getComparisons().length : 0,
      },
      tracks: ratings,
      consistency_checks: consistency,
      comparisons: Ratings.getComparisons ? Ratings.getComparisons() : [],
      sessions: [session],
      batches: Ratings.getBatches(),
    };
  }

  function _save(payload, filename) {
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function download() {
    _save(buildPayload(), `sorter-export-${new Date().toISOString().slice(0, 10)}.json`);
  }

  function downloadBatch(batchId) {
    const all = buildPayload();
    const tracks = all.tracks.filter((t) => t.batch_id === batchId);
    const batch = (all.batches || []).find((b) => b.batch_id === batchId);
    const name = (batch?.name || batchId).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
    _save(
      { ...all, tracks, batches: batch ? [batch] : [], metadata: { ...all.metadata, total_tracks: tracks.length, batch_id: batchId } },
      `sorter-batch-${name}-${new Date().toISOString().slice(0, 10)}.json`
    );
  }

  async function clipboard() {
    const payload = buildPayload();
    const json = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(json);
      return true;
    }
    return false;
  }

  async function share() {
    const payload = buildPayload();
    const json = JSON.stringify(payload, null, 2);
    if (navigator.share && navigator.canShare) {
      const file = new File([json], `sorter-export-${Date.now()}.json`, { type: "application/json" });
      if (navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: "Sorter ratings", text: "" });
        return true;
      }
    }
    if (navigator.share) {
      // Fallback to text-only share if file share unsupported (iOS sometimes)
      await navigator.share({ title: "Sorter ratings", text: json });
      return true;
    }
    return false;
  }

  return { download, downloadBatch, clipboard, share, buildPayload };
})();
