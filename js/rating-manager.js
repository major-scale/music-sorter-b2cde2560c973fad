// Rating persistence + intra-rater consistency (weighted Cohen's kappa).
//
// Storage primary = localStorage, key "sorter.ratings.v1" → { [track_id]: trackRecord }.
// If localStorage exceeds ~4MB we mirror to IndexedDB ("sorter-db" / "ratings" store)
// and continue writing both; export reads from IndexedDB if present, else localStorage.
//
// Each record matches the spec's data model. track_id = `yt:${youtube_id}`.

window.Ratings = (() => {
  const KEY = "sorter.ratings.v2";              // Round 2 rich pass (v1 store preserved separately)
  const SESSION_KEY = "sorter.session.v1";
  const CONSISTENCY_KEY = "sorter.consistency.v1";
  const PRESET_KEY = "sorter.presets.v1";
  const SETTINGS_KEY = "sorter.settings.v1";
  const BATCHES_KEY = "sorter.batches.v1";
  const ACTIVE_BATCH_KEY = "sorter.activeBatch.v1";
  const KAPPATEST_KEY = "sorter.kappatest.v1";
  const COMPARISONS_KEY = "sorter.comparisons.v2"; // pairwise/playoff verdicts
  const IDLE_MIN_FOR_NEW_SESSION = 30 * 60 * 1000; // 30 minutes

  const DEFAULT_SETTINGS = { nudgeSeconds: 3, startOffsetSeconds: 20, doubleTapMs: 500 };

  const RATING_TO_5PT_DEFAULT = { LOVE: 4, MID: 3, SLOP: 2 };
  // 5-point scale: 1 HATE · 2 DISLIKE · 3 MID · 4 LIKE · 5 LOVE → buckets must agree with the 3-class.
  const CLASS_5PT_RANGE = { SLOP: [1, 2], MID: [3, 3], LOVE: [4, 5] };
  // Keep rating_5point consistent with rating_3class: keep an in-range detail, else snap to the class default.
  function reconcile5pt(cls, fivePt) {
    const r = CLASS_5PT_RANGE[cls];
    if (!r) return fivePt != null ? fivePt : null;
    return (fivePt != null && fivePt >= r[0] && fivePt <= r[1]) ? fivePt : RATING_TO_5PT_DEFAULT[cls];
  }
  // One-time repair of records saved before reconciliation (e.g. LOVE paired with a 2). Returns #fixed.
  function reconcileAll() {
    let fixed = 0;
    for (const id in ratings) {
      const rec = ratings[id];
      if (!rec || !rec.rating_3class) continue;
      const want = reconcile5pt(rec.rating_3class, rec.rating_5point);
      if (want !== rec.rating_5point) { rec.rating_5point = want; fixed++; }
    }
    if (fixed) saveJSON(KEY, ratings);
    return fixed;
  }
  const RATINGS_BETWEEN_CONSISTENCY = 50;

  let ratings = loadJSON(KEY, {});
  let session = ensureSession();
  let consistency = loadJSON(CONSISTENCY_KEY, []); // [{trackId, prevLabel, newLabel, prev5, new5, ts}]
  // Dedicated blind re-rate session for measuring intra-rater reliability (κ).
  // { startedAt, plan:[{youtube_id, original_label, original_5pt, artist, title}], responses:[{youtube_id, rerate_label, rerate_5pt, time_to_rate, listen_seconds, ts}] }
  let kappaTest = loadJSON(KAPPATEST_KEY, null);
  // Pairwise/playoff verdicts: [{a_id,b_id,verdict(-2..2),context,session_id,device,ts}]
  let comparisons = loadJSON(COMPARISONS_KEY, []);

  // ----------------- settings -----------------

  function getSettings() {
    return { ...DEFAULT_SETTINGS, ...loadJSON(SETTINGS_KEY, {}) };
  }
  function saveSettings(patch) {
    saveJSON(SETTINGS_KEY, { ...getSettings(), ...patch });
    return getSettings();
  }

  // ----------------- batches -----------------
  // A batch = one playlist's worth of rating history. Records carry batch_id/batch_name
  // so history can be browsed and exported per playlist.

  function getBatches() { return loadJSON(BATCHES_KEY, []); }
  function getActiveBatch() {
    const id = loadJSON(ACTIVE_BATCH_KEY, null);
    return getBatches().find((b) => b.batch_id === id) || null;
  }
  function setActiveBatch(id) { saveJSON(ACTIVE_BATCH_KEY, id); }

  function ensureBatchForPlaylist(playlistId, name) {
    const batches = getBatches();
    let b = batches.find((x) => x.playlist_id === playlistId);
    if (!b) {
      b = {
        batch_id: `batch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        name: name || "Untitled batch",
        playlist_id: playlistId,
        created_at: new Date().toISOString(),
      };
      batches.push(b);
      saveJSON(BATCHES_KEY, batches);
    } else if (name && b.name !== name && (b.name === "Untitled batch" || b.name === "Custom playlist")) {
      b.name = name;
      saveJSON(BATCHES_KEY, batches);
    }
    setActiveBatch(b.batch_id);
    return b;
  }

  function renameBatch(id, name) {
    const batches = getBatches();
    const b = batches.find((x) => x.batch_id === id);
    if (b) { b.name = name; saveJSON(BATCHES_KEY, batches); }
  }

  function batchSummaries() {
    const out = {};
    for (const r of Object.values(ratings)) {
      const bid = r.batch_id || "(unbatched)";
      if (!out[bid]) {
        out[bid] = { batch_id: bid, name: r.batch_name || "(unbatched)",
                     playlist_id: r.source_playlist_id || null,
                     count: 0, LOVE: 0, MID: 0, SLOP: 0, first: r.rated_at, last: r.rated_at };
      }
      const o = out[bid];
      o.count++;
      o[r.rating_3class] = (o[r.rating_3class] || 0) + 1;
      if (r.rated_at < o.first) o.first = r.rated_at;
      if (r.rated_at > o.last) o.last = r.rated_at;
    }
    // include empty batches that exist in the registry but have no ratings yet
    for (const b of getBatches()) {
      if (!out[b.batch_id]) {
        out[b.batch_id] = { batch_id: b.batch_id, name: b.name, playlist_id: b.playlist_id,
                            count: 0, LOVE: 0, MID: 0, SLOP: 0, first: b.created_at, last: b.created_at };
      } else {
        out[b.batch_id].name = b.name; // registry name wins (renames)
      }
    }
    return Object.values(out).sort((a, b) => (a.last < b.last ? 1 : -1));
  }

  // ----------------- persistence -----------------

  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.warn("localStorage write failed; falling back to IndexedDB", e);
      idbPut(key, value);
    }
  }

  // Lightweight IndexedDB fallback for large datasets
  let dbPromise = null;
  function openDB() {
    if (!dbPromise) {
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open("sorter-db", 1);
        req.onupgradeneeded = () => req.result.createObjectStore("kv");
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }
    return dbPromise;
  }
  async function idbPut(key, val) {
    try {
      const db = await openDB();
      const tx = db.transaction("kv", "readwrite");
      tx.objectStore("kv").put(val, key);
    } catch (e) { console.error("idb put failed", e); }
  }

  // ----------------- session -----------------

  function ensureSession() {
    const stored = loadJSON(SESSION_KEY, null);
    const now = Date.now();
    if (stored && (now - stored.lastTickAt) < IDLE_MIN_FOR_NEW_SESSION) {
      stored.lastTickAt = now;
      saveJSON(SESSION_KEY, stored);
      return stored;
    }
    const fresh = {
      sessionId: `session_${new Date().toISOString().replace(/[:.]/g, "-")}`,
      startedAt: new Date().toISOString(),
      device: matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop",
      lastTickAt: now,
      ratedCount: 0,
    };
    saveJSON(SESSION_KEY, fresh);
    return fresh;
  }
  function tickSession() {
    session.lastTickAt = Date.now();
    session.ratedCount += 1;
    saveJSON(SESSION_KEY, session);
  }

  // ----------------- consistency pick -----------------

  function pickConsistencyCheck() {
    const ids = Object.keys(ratings);
    if (ids.length < 20) return null;
    // 5% of recent ratings; one at a time
    const rated = ids.map((id) => ratings[id]).filter((r) => r.rating_3class !== "UNAVAILABLE");
    if (rated.length < 20) return null;
    // Prefer tracks last rated > 7 days ago; fall back to any
    const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
    const old = rated.filter((r) => new Date(r.rated_at).getTime() < cutoff);
    const pool = old.length >= 5 ? old : rated;
    return pool[Math.floor(Math.random() * pool.length)];
  }

  function maybeQueueConsistencyCheck() {
    const total = Object.keys(ratings).length;
    if (total === 0 || total % RATINGS_BETWEEN_CONSISTENCY !== 0) return null;
    return pickConsistencyCheck();
  }

  // ----------------- weighted Cohen's κ -----------------
  // Linear weights over ordinal LOVE>MID>SLOP. Code labels {SLOP:0, MID:1, LOVE:2}.

  function weightedKappa(pairs) {
    const code = { SLOP: 0, MID: 1, LOVE: 2 };
    const filtered = pairs
      .map((p) => [code[p.prevLabel], code[p.newLabel]])
      .filter((p) => p[0] != null && p[1] != null);
    if (filtered.length < 5) return null;
    const n = filtered.length;
    const k = 3;
    const O = Array.from({ length: k }, () => new Array(k).fill(0));
    const row = new Array(k).fill(0);
    const col = new Array(k).fill(0);
    for (const [a, b] of filtered) { O[a][b]++; row[a]++; col[b]++; }
    let num = 0, den = 0;
    for (let i = 0; i < k; i++) {
      for (let j = 0; j < k; j++) {
        const w = Math.abs(i - j) / (k - 1);
        const e = (row[i] * col[j]) / n;
        num += w * O[i][j];
        den += w * e;
      }
    }
    if (den === 0) return 1;
    return 1 - num / den;
  }

  // Unweighted Cohen's κ over the 3 nominal classes.
  function cohenKappa(pairs) {
    const code = { SLOP: 0, MID: 1, LOVE: 2 };
    const f = pairs
      .map((p) => [code[p.prevLabel], code[p.newLabel]])
      .filter((p) => p[0] != null && p[1] != null);
    if (f.length < 2) return null;
    const n = f.length, k = 3;
    const O = Array.from({ length: k }, () => new Array(k).fill(0));
    const row = new Array(k).fill(0), col = new Array(k).fill(0);
    for (const [a, b] of f) { O[a][b]++; row[a]++; col[b]++; }
    let po = 0, pe = 0;
    for (let i = 0; i < k; i++) { po += O[i][i]; pe += (row[i] * col[i]) / n; }
    po /= n; pe /= n;
    if (pe >= 1) return 1;
    return (po - pe) / (1 - pe);
  }

  // ----------------- blind reliability test (κ) -----------------
  // A self-contained session: sample already-rated tracks, replay them, take a
  // FRESH rating without revealing the old one, then score agreement. Never
  // overwrites the original ratings — responses live in their own store.

  function shuffle(a) {
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function startKappaTest(n = 50) {
    const all = Object.values(ratings).filter((r) => ["LOVE", "MID", "SLOP"].includes(r.rating_3class));
    const byLabel = { LOVE: [], MID: [], SLOP: [] };
    for (const r of all) byLabel[r.rating_3class].push(r);
    Object.values(byLabel).forEach(shuffle);
    const perLabel = Math.ceil(n / 3);
    let picked = [];
    for (const lab of ["LOVE", "MID", "SLOP"]) picked = picked.concat(byLabel[lab].slice(0, perLabel));
    picked = shuffle(picked).slice(0, n);
    if (!picked.length) return null;
    kappaTest = {
      startedAt: new Date().toISOString(),
      plan: picked.map((r) => ({
        youtube_id: r.youtube_id,
        original_label: r.rating_3class,
        original_5pt: r.rating_5point,
        original_rated_at: r.rated_at,
        artist: r.artist,
        title: r.title,
      })),
      responses: [],
    };
    saveJSON(KAPPATEST_KEY, kappaTest);
    return kappaTest;
  }

  function recordKappaRerate(o) {
    if (!kappaTest) return null;
    kappaTest.responses = kappaTest.responses.filter((r) => r.youtube_id !== o.youtube_id);
    kappaTest.responses.push({
      youtube_id: o.youtube_id,
      rerate_label: o.rerate_label,
      rerate_5pt: o.rerate_5pt != null ? o.rerate_5pt : null,
      time_to_rate: o.timeToRate != null ? Math.round(o.timeToRate * 10) / 10 : null,
      listen_seconds: Math.round(o.listenSeconds || 0),
      ts: new Date().toISOString(),
    });
    saveJSON(KAPPATEST_KEY, kappaTest);
    return kappaTest;
  }

  function getKappaTest() { return kappaTest; }
  function clearKappaTest() { kappaTest = null; saveJSON(KAPPATEST_KEY, null); }

  function computeKappaTest() {
    if (!kappaTest || !kappaTest.responses.length) return null;
    const origById = {};
    for (const p of kappaTest.plan) origById[p.youtube_id] = p;
    const pairs = [];
    for (const r of kappaTest.responses) {
      const o = origById[r.youtube_id];
      if (!o) continue;
      pairs.push({ prevLabel: o.original_label, newLabel: r.rerate_label, prev5: o.original_5pt, new5: r.rerate_5pt });
    }
    const n = pairs.length;
    let agree = 0;
    const byLabel = { LOVE: { n: 0, agree: 0 }, MID: { n: 0, agree: 0 }, SLOP: { n: 0, agree: 0 } };
    const confusion = {};
    for (const p of pairs) {
      byLabel[p.prevLabel].n++;
      if (p.prevLabel === p.newLabel) { agree++; byLabel[p.prevLabel].agree++; }
      const key = `${p.prevLabel}→${p.newLabel}`;
      confusion[key] = (confusion[key] || 0) + 1;
    }
    return {
      n,
      planned: kappaTest.plan.length,
      exactAgree: n ? agree / n : null,
      cohenK: cohenKappa(pairs),
      weightedK: weightedKappa(pairs),
      byLabel,
      confusion,
    };
  }

  // ----------------- public API -----------------

  // Strip trailing "(Official Music Video)" / "[Lyric Video]" / "(Lyrics)" / etc.
  // but keep meaningful bracketed info: feat/ft, remix, mix, edit, version, extended,
  // radio, live, acoustic, instrumental, original, cover, bootleg, rework, 4-digit years.
  const NOISE_TERMS = /\b(official|music\s*video|lyric\s*video|lyrics?|audio|visualizer|hd|hq|4k|hi[\s-]?res|free\s*download)\b/i;
  const KEEP_TERMS  = /\b(remix|mix|edit|feat\.?|ft\.?|version|extended|radio|live|acoustic|instrumental|original|cover|bootleg|rework|remaster|with|vs|cut|edit|\d{4})\b/i;

  function cleanTitle(s) {
    if (!s) return s;
    let prev;
    do {
      prev = s;
      s = s.replace(/\s*[\(\[]([^\(\)\[\]]*)[\)\]]\s*$/, (m, inner) => {
        if (KEEP_TERMS.test(inner)) return m;        // keep meaningful brackets
        if (NOISE_TERMS.test(inner)) return "";      // strip cruft
        return m;                                    // unknown → keep (safer)
      });
    } while (s !== prev);
    return s.trim();
  }

  function parseTitle(rawTitle) {
    if (!rawTitle) return { artist: "", title: "" };
    const seps = [" - ", " – ", " — ", " | ", " : "];
    for (const s of seps) {
      const i = rawTitle.indexOf(s);
      if (i > 0) {
        return {
          artist: rawTitle.slice(0, i).trim(),
          title:  cleanTitle(rawTitle.slice(i + s.length).trim()),
        };
      }
    }
    return { artist: "", title: cleanTitle(rawTitle.trim()) };
  }

  // One-time retroactive cleanup of existing records when the parser changes.
  // Bump the flag string ("v2", "v3"…) to re-run.
  function reparseAllOnce(flag = "sorter.reparsed.v2") {
    try {
      if (localStorage.getItem(flag)) return;
      let changed = 0;
      for (const id of Object.keys(ratings)) {
        const r = ratings[id];
        const p = parseTitle(r.video_title || "");
        if (p.artist && p.artist !== r.artist) { r.artist = p.artist; changed++; }
        if (p.title && p.title !== r.title)   { r.title  = p.title;  changed++; }
      }
      if (changed) saveJSON(KEY, ratings);
      localStorage.setItem(flag, "1");
    } catch (e) { console.warn("reparseAllOnce failed", e); }
  }
  reparseAllOnce();

  function getRating(youtubeId) {
    return ratings[`yt:${youtubeId}`] || null;
  }

  // Patch confidence / familiarity / 5-point on an EXISTING record without re-rating (no rated_at bump). No-op if unrated.
  function setDetail(youtubeId, fields) {
    const rec = ratings[`yt:${youtubeId}`];
    if (!rec || !rec.rating_3class) return null;
    if (fields.confidence !== undefined) rec.confidence = fields.confidence;
    if (fields.isFamiliar !== undefined) rec.is_familiar = fields.isFamiliar;
    if (fields.rating5point !== undefined) rec.rating_5point = reconcile5pt(rec.rating_3class, fields.rating5point);
    saveJSON(KEY, ratings);
    return rec;
  }

  function isConsistencyTarget(youtubeId) {
    return !!_pendingConsistency && _pendingConsistency.youtube_id === youtubeId;
  }
  let _pendingConsistency = null;

  function setConsistencyTarget(record) { _pendingConsistency = record; }
  function clearConsistencyTarget() { _pendingConsistency = null; }

  function rate(opts) {
    // opts: { youtubeId, videoTitle, artist, title, queuedFrom, sourcePlaylistId,
    //         sourcePlaylistTitle, rating3class, rating5point, listenSeconds, notes, subgenreTags,
    //         confidence ("sure"|"think_so"|"guess"), isFamiliar ("novel"|"known"),
    //         neutralAnchorSeconds, segments [{start_s,end_s,label,strength,ts}], annotationPass }
    const id = `yt:${opts.youtubeId}`;
    const existing = ratings[id];
    const isConsistency = isConsistencyTarget(opts.youtubeId);
    const activeBatch = getActiveBatch();

    const record = {
      track_id: id,
      youtube_id: opts.youtubeId,
      artist: opts.artist || existing?.artist || "",
      title: opts.title || existing?.title || "",
      video_title: opts.videoTitle || existing?.video_title || "",
      year: null,
      label: null,
      queued_from: opts.queuedFrom || existing?.queued_from || "youtube_playlist",
      source_playlist_id: opts.sourcePlaylistId || existing?.source_playlist_id || null,
      source_playlist_title: opts.sourcePlaylistTitle || existing?.source_playlist_title || null,
      subgenre_tags: opts.subgenreTags || existing?.subgenre_tags || [],
      rated_at: new Date().toISOString(),
      rating_3class: opts.rating3class,
      rating_5point: reconcile5pt(opts.rating3class, opts.rating5point),
      listen_duration_seconds: Math.round(opts.listenSeconds || 0),
      time_to_rate_seconds: opts.timeToRate != null ? Math.round(opts.timeToRate * 10) / 10 : null,
      notes: opts.notes || "",
      session_id: session.sessionId,
      batch_id: activeBatch?.batch_id || existing?.batch_id || null,
      batch_name: activeBatch?.name || existing?.batch_name || null,
      is_consistency_check: isConsistency,
      previous_rating_3class: isConsistency ? existing?.rating_3class || null : (existing?.rating_3class || null),
      device: session.device,
      // Round 2 rich-annotation fields:
      confidence: opts.confidence != null ? opts.confidence : (existing?.confidence ?? null),
      is_familiar: opts.isFamiliar != null ? opts.isFamiliar : (existing?.is_familiar ?? null),
      neutral_anchor_seconds: opts.neutralAnchorSeconds != null ? opts.neutralAnchorSeconds : (existing?.neutral_anchor_seconds ?? null),
      neutral_markers: opts.neutralMarkers != null ? opts.neutralMarkers : (existing?.neutral_markers ?? []),
      segments: opts.segments != null ? opts.segments : (existing?.segments ?? []),
      annotation_pass: opts.annotationPass || existing?.annotation_pass || "rich-v1",
    };

    ratings[id] = record;
    saveJSON(KEY, ratings);

    if (isConsistency && existing) {
      consistency.push({
        trackId: id,
        prevLabel: existing.rating_3class,
        newLabel: record.rating_3class,
        prev5: existing.rating_5point,
        new5:  record.rating_5point,
        ts: record.rated_at,
      });
      saveJSON(CONSISTENCY_KEY, consistency);
      clearConsistencyTarget();
    }

    tickSession();
    return record;
  }

  // Merge YouTube Data API metadata into a stored record (fills artist/title if empty).
  function enrich(youtubeId, meta) {
    const id = `yt:${youtubeId}`;
    const r = ratings[id];
    if (!r || !meta) return false;
    for (const k of ["channel_title", "published_at", "duration_seconds", "tags",
                     "yt_title", "yt_artist", "yt_album", "yt_label", "yt_release_date",
                     "view_count", "like_count", "is_music_category", "topics", "default_language", "enriched_at"]) {
      if (meta[k] != null && !(Array.isArray(meta[k]) && meta[k].length === 0)) r[k] = meta[k];
    }
    if (!r.artist && meta.yt_artist) r.artist = meta.yt_artist;
    if ((!r.title || r.title === r.video_title) && meta.yt_title) r.title = meta.yt_title;
    if (meta.yt_release_date && /^\d{4}/.test(meta.yt_release_date)) r.year = parseInt(meta.yt_release_date, 10);
    saveJSON(KEY, ratings);
    return true;
  }

  function unenrichedIds() {
    return Object.values(ratings)
      .filter((r) => !r.enriched_at && r.rating_3class !== "UNAVAILABLE")
      .map((r) => r.youtube_id);
  }

  function deleteRating(youtubeId) {
    const id = `yt:${youtubeId}`;
    if (ratings[id]) { delete ratings[id]; saveJSON(KEY, ratings); }
  }

  function putRecord(record) {
    if (record && record.track_id) { ratings[record.track_id] = record; saveJSON(KEY, ratings); }
  }

  // Re-rate an already-stored track in place (used by the Recent-list edit buttons).
  function reRate(youtubeId, newLabel) {
    const id = `yt:${youtubeId}`;
    const existing = ratings[id];
    if (!existing) return null;
    const prev = existing.rating_3class;
    existing.previous_rating_3class = prev;
    existing.rating_3class = newLabel;
    existing.rating_5point = { LOVE: 4, MID: 3, SLOP: 2 }[newLabel] ?? existing.rating_5point;
    existing.rated_at = new Date().toISOString();
    saveJSON(KEY, ratings);
    return existing;
  }

  // Merge an exported payload into this instance's storage. By track_id; the newer
  // rated_at wins. Also merges batch registry entries. Returns a small report.
  function importPayload(payload) {
    let added = 0, updated = 0;
    for (const t of (payload && payload.tracks) || []) {
      if (!t || !t.track_id) continue;
      const ex = ratings[t.track_id];
      if (!ex) { ratings[t.track_id] = t; added++; }
      else if ((t.rated_at || "") > (ex.rated_at || "")) { ratings[t.track_id] = t; updated++; }
    }
    saveJSON(KEY, ratings);

    const batches = getBatches();
    const seen = new Set(batches.map((b) => b.batch_id));
    for (const b of (payload && payload.batches) || []) {
      if (b && b.batch_id && !seen.has(b.batch_id)) { batches.push(b); seen.add(b.batch_id); }
    }
    saveJSON(BATCHES_KEY, batches);

    if (payload && Array.isArray(payload.comparisons) && payload.comparisons.length) {
      const seenC = new Set(comparisons.map((c) => `${c.a_id}|${c.b_id}|${c.ts}`));
      for (const c of payload.comparisons) {
        const k = `${c.a_id}|${c.b_id}|${c.ts}`;
        if (c && !seenC.has(k)) { comparisons.push(c); seenC.add(k); }
      }
      saveJSON(COMPARISONS_KEY, comparisons);
    }

    return { added, updated, total: Object.keys(ratings).length };
  }

  // ----------------- pairwise comparisons -----------------
  function recordComparison(o) {
    // o: { aId, bId, verdict (-2..2: -2 A>>B, 0 tie, +2 B>>A), context, test }
    const rec = {
      a_id: o.aId, b_id: o.bId, verdict: o.verdict,
      context: o.context || null, test_mode: !!o.test,
      session_id: session.sessionId, device: session.device,
      ts: new Date().toISOString(),
    };
    comparisons.push(rec);
    saveJSON(COMPARISONS_KEY, comparisons);
    return rec;
  }
  function getComparisons() { return comparisons.slice(); }
  function clearComparisons() { comparisons = []; saveJSON(COMPARISONS_KEY, comparisons); }

  function clearAll() {
    ratings = {};
    consistency = [];
    comparisons = [];
    saveJSON(KEY, ratings);
    saveJSON(CONSISTENCY_KEY, consistency);
    saveJSON(COMPARISONS_KEY, comparisons);
  }

  function clearSession() {
    const sid = session.sessionId;
    for (const id of Object.keys(ratings)) {
      if (ratings[id].session_id === sid) delete ratings[id];
    }
    saveJSON(KEY, ratings);
    session = ensureSession(); // force-roll a fresh session
  }

  function getAll() { return Object.values(ratings); }
  function getRatedIds() { return new Set(Object.values(ratings).map((r) => r.youtube_id)); }
  function getConsistency() { return consistency.slice(); }
  function getSession() { return { ...session }; }
  function counts() {
    const out = { total: 0, LOVE: 0, MID: 0, SLOP: 0, SKIPPED: 0, UNAVAILABLE: 0, session: 0 };
    for (const r of Object.values(ratings)) {
      out.total++;
      out[r.rating_3class] = (out[r.rating_3class] || 0) + 1;
      if (r.session_id === session.sessionId) out.session++;
    }
    return out;
  }
  function kappa() {
    return weightedKappa(consistency);
  }

  // Presets stored separately so they survive ratings clear-all
  function getPresets() {
    return loadJSON(PRESET_KEY, [
      // Single safe default; user adds more via UI
      { title: "Anjunabeats Worldwide (label official)", url: "https://www.youtube.com/playlist?list=PLAajD0Auu8oQuKaPYf5l6IO1aUWHJzM38" },
    ]);
  }
  function setPresets(list) { saveJSON(PRESET_KEY, list); }

  return {
    parseTitle, cleanTitle, getRating, getRatedIds, getAll, getConsistency,
    counts, kappa, rate, reconcile5pt, reconcileAll, setDetail, deleteRating, putRecord, reRate, importPayload, enrich, unenrichedIds, clearAll, clearSession, getSession,
    maybeQueueConsistencyCheck, setConsistencyTarget, isConsistencyTarget, clearConsistencyTarget,
    startKappaTest, recordKappaRerate, getKappaTest, clearKappaTest, computeKappaTest,
    recordComparison, getComparisons, clearComparisons,
    getPresets, setPresets,
    getSettings, saveSettings,
    getBatches, getActiveBatch, setActiveBatch, ensureBatchForPlaylist, renameBatch, batchSummaries,
  };
})();
