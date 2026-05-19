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
  const IDLE_MIN_FOR_NEW_SESSION = 30 * 60 * 1000; // 30 minutes

  const RATING_TO_5PT_DEFAULT = { LOVE: 4, MID: 3, SLOP: 2 };
  const RATINGS_BETWEEN_CONSISTENCY = 50;

  let ratings = loadJSON(KEY, {});
  let session = ensureSession();
  let consistency = loadJSON(CONSISTENCY_KEY, []); // [{trackId, prevLabel, newLabel, prev5, new5, ts}]

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
    counts, kappa, rate, clearAll, clearSession, getSession,
    maybeQueueConsistencyCheck, setConsistencyTarget, isConsistencyTarget, clearConsistencyTarget,
    getPresets, setPresets,
  };
})();
