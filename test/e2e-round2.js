// Round 2 E2E suite. Drives the real app components with seekable blob audio and asserts
// playback, waveform/minimap render, SEEK + MARKER-TIMING correctness, track-change reset,
// the ratings/segments pipeline, and comparisons.
//
// HOW TO RUN:
//   1. Copy two of your mp3s into the served root as t1.mp3 and t2.mp3, e.g.:
//        cp data/audio/<idA>.mp3 t1.mp3 ; cp data/audio/<idB>.mp3 t2.mp3
//   2. Serve the app (no-cache server) and open it; in DevTools console:
//        load this file (or paste it), then:  await runE2E()
//   Returns { passed, total, allPass, failures, results }.  18/18 verified 2026-05-22.
//
// Blob URLs are used deliberately — they're seekable in-memory (like the app's File-System-Access
// playback). Serving mp3s over a range-less HTTP server makes <audio> unseekable (false failures).

window.runE2E = async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const R = []; const ok = (n, c, e) => R.push({ name: n, pass: !!c, ...(e !== undefined ? { extra: e } : {}) });
  const waitEvt = (el, ev, ms = 5000) => new Promise((res) => { const t = setTimeout(res, ms); el.addEventListener(ev, () => { clearTimeout(t); res(); }, { once: true }); });
  const blobUrl = async (u) => URL.createObjectURL(await (await fetch(u)).blob());

  const q = document.getElementById("queue-modal"); if (q && q.open) q.close();
  window.Player.use("local");
  document.body.classList.add("round2-mode");
  document.getElementById("segments").classList.remove("hidden");
  let a = document.getElementById("local-audio");
  if (!a) { a = document.createElement("audio"); a.id = "local-audio"; a.controls = true; a.style.width = "100%"; const s = document.getElementById("segments"); s.insertBefore(a, s.firstChild); }
  window.Player.init();
  const u1 = await blobUrl("/t1.mp3"), u2 = await blobUrl("/t2.mp3");
  a.src = u1; a.load();
  if (window.Segments) { window.Segments.enable(true); window.Segments.setActive("love"); }
  if (!a.duration || a.readyState < 1) await waitEvt(a, "loadedmetadata");
  await sleep(1500);

  const wf = document.getElementById("waveform");
  ok("audio loaded (duration>0)", (a.duration || 0) > 5, +(a.duration || 0).toFixed(1));
  ok("waveform canvases drawn", (wf?.querySelectorAll("canvas").length || 0) > 0);
  ok("minimap drawn", (document.getElementById("waveform-map")?.querySelectorAll("canvas").length || 0) > 0);

  window.Player.seek(30); await waitEvt(a, "seeked", 1500); await sleep(100);
  ok("Player.seek(30) → currentTime≈30", Math.abs(window.Player.currentTime() - 30) < 1.5, +window.Player.currentTime().toFixed(2));

  window.Segments.clear();
  a.currentTime = 42; await waitEvt(a, "seeked", 1500); await sleep(80);
  window.Segments.setActive("love"); window.Segments.addRegion("love");
  let segs = window.Segments.getSegments();
  ok("point marker @ playhead start_s≈42 (TIMING)", segs.length === 1 && Math.abs(segs[0].start_s - 42) < 0.5, segs);

  a.currentTime = 75; await waitEvt(a, "seeked", 1500); await sleep(80);
  window.Segments.setActive("slop"); window.Segments.addRegion("slop");
  segs = window.Segments.getSegments();
  ok("2nd marker (slop) @≈75, count=2", segs.length === 2 && segs.some((s) => s.label === "slop" && Math.abs(s.start_s - 75) < 0.5), segs);

  a.currentTime = 12; await waitEvt(a, "seeked", 1500); await sleep(80);
  window.Segments.setActive("neutral"); window.Segments.addRegion("neutral");
  ok("neutral excluded from segments (still 2)", window.Segments.getSegments().length === 2);
  ok("neutral captured as anchor ≈12", Math.abs((window.Segments.getAnchor() ?? -999) - 12) < 0.6, window.Segments.getAnchor());

  window.Segments.clear();
  ok("clear empties segments", window.Segments.getSegments().length === 0);

  a.currentTime = 20; await waitEvt(a, "seeked", 1500); window.Segments.setActive("love"); window.Segments.addRegion("love");
  a.src = u2; a.load(); window.Segments.reset();
  await waitEvt(a, "loadeddata"); await sleep(1400);
  ok("track change clears segments", window.Segments.getSegments().length === 0);
  ok("track2 waveform redrawn", wf.querySelectorAll("canvas").length > 0);
  ok("track2 audio loaded", a.duration > 5, +(a.duration || 0).toFixed(1));

  a.currentTime = 33; await waitEvt(a, "seeked", 1500); await sleep(80);
  window.Segments.setActive("love"); window.Segments.addRegion("love");
  const segN = window.Segments.getSegments().length;
  const rec = window.Ratings.rate({ youtubeId: "E2E_TEST", videoTitle: "x", artist: "A", title: "T", rating3class: "LOVE",
    confidence: "sure", isFamiliar: "novel", neutralAnchorSeconds: window.Segments.getAnchor(), segments: window.Segments.getSegments(), annotationPass: "test" });
  ok("rating stores confidence", rec.confidence === "sure");
  ok("rating stores familiarity", rec.is_familiar === "novel");
  ok("rating stores segments w/ timing (≈33)", rec.segments.length === segN && Math.abs(rec.segments[0].start_s - 33) < 0.5, rec.segments);
  ok("rating tagged test", rec.annotation_pass === "test");

  const c = window.Ratings.recordComparison({ aId: "yt:A", bId: "yt:B", verdict: 2, context: "anjuna", test: true });
  ok("comparison verdict + test flag", c.verdict === 2 && c.test_mode === true);
  const h = window.round2Health ? window.round2Health() : null;
  ok("round2Health: no anomalies", h && h.anomalies.length === 0, h ? h.anomalies : null);

  if (window.clearTestData) window.clearTestData();
  if (window.Ratings.clearComparisons) window.Ratings.clearComparisons();
  window.Segments.clear();
  const passed = R.filter((r) => r.pass).length;
  return { passed, total: R.length, allPass: passed === R.length, failures: R.filter((r) => !r.pass), results: R };
};
