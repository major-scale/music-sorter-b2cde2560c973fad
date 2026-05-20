// Rating persistence + intra-rater consistency (weighted Cohen's kappa).
//
// Storage primary = localStorage, key "sorter.ratings.v1" → { [track_id]: trackRecord }.
// If localStorage exceeds ~4MB we mirror to IndexedDB ("sorter-db" / "ratings" store)
// and continue writing both; export reads from IndexedDB if present, else localStorage.
//
// Each record matches the spec's data model. track_id = `yt:${youtube_id}`.

window.Ratings = (() => {
  const KEY = "sorter.ratings.v1";
  const SESSION_KEY = "sorter.session.v1";
  const CONSISTENCY_KEY = "sorter.consistency.v1";
  const PRESET_KEY = "sorter.presets.v1";
  const SETTINGS_KEY = "sorter.settings.v1";
  const BATCHES_KEY = "sorter.batches.v1";
  const ACTIVE_BATCH_KEY = "sorter.activeBatch.v1";
  const IDLE_MIN_FOR_NEW_SESSION = 30 * 60 * 1000; // 30 minutes

  const DEFAULT_SETTINGS = { nudgeSeconds: 3, startOffsetSeconds: 20, doubleTapMs: 500 };

  const RATING_TO_5PT_DEFAULT = { LOVE: 4, MID: 3, SLOP: 2 };
  const RATINGS_BETWEEN_CONSISTENCY = 50;

  let ratings = loadJSON(KEY, {});
  let session = ensureSession();
  let consistency = loadJSON(CONSISTENCY_KEY, []); // [{trackId, prevLabel, newLabel, prev5, new5, ts}]

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

  function isConsistencyTarget(youtubeId) {
    return !!_pendingConsistency && _pendingConsistency.youtube_id === youtubeId;
  }
  let _pendingConsistency = null;

  function setConsistencyTarget(record) { _pendingConsistency = record; }
  function clearConsistencyTarget() { _pendingConsistency = null; }

  function rate(opts) {
    // opts: { youtubeId, videoTitle, artist, title, queuedFrom, sourcePlaylistId,
    //         sourcePlaylistTitle, rating3class, rating5point, listenSeconds, notes, subgenreTags }
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
      rating_5point: opts.rating5point != null
        ? opts.rating5point
        : (RATING_TO_5PT_DEFAULT[opts.rating3class] ?? null),
      listen_duration_seconds: Math.round(opts.listenSeconds || 0),
      notes: opts.notes || "",
      session_id: session.sessionId,
      batch_id: activeBatch?.batch_id || existing?.batch_id || null,
      batch_name: activeBatch?.name || existing?.batch_name || null,
      is_consistency_check: isConsistency,
      previous_rating_3class: isConsistency ? existing?.rating_3class || null : (existing?.rating_3class || null),
      device: session.device,
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

    return { added, updated, total: Object.keys(ratings).length };
  }

  function clearAll() {
    ratings = {};
    consistency = [];
    saveJSON(KEY, ratings);
    saveJSON(CONSISTENCY_KEY, consistency);
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
    counts, kappa, rate, deleteRating, putRecord, reRate, importPayload, clearAll, clearSession, getSession,
    maybeQueueConsistencyCheck, setConsistencyTarget, isConsistencyTarget, clearConsistencyTarget,
    getPresets, setPresets,
    getSettings, saveSettings,
    getBatches, getActiveBatch, setActiveBatch, ensureBatchForPlaylist, renameBatch, batchSummaries,
  };
})();
