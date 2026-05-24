// Local-audio backend — mirrors the window.Player interface (see youtube-player.js)
// but plays local mp3s via the File System Access API + an HTML5 <audio> element.
// Used for the Round 2 rich-annotation pilot, where segment timestamps MUST align to
// the exact audio MuQ embedded — so we play the same data/audio/<id>.mp3 files.
//
// Folder model: the user picks the `data/` folder once (contains round2_pilot.json and
// audio/<youtube_id>.mp3). The dir handle is persisted in IndexedDB across reloads.

window.LocalBackend = (() => {
  let audio = null;
  let tracks = [];                 // manifest: [{youtube_id, mp3, artist, title, subgenre, ...}]
  let idx = -1;
  let dirHandle = null;            // FileSystemDirectoryHandle for data/
  let curObjectUrl = null;

  // listen-time accounting (mirror YT semantics)
  let listenAccumulatedMs = 0;
  let lastPlayingStartedAt = null;
  let firstPlayingFired = false;
  let startOffsetSec = 0;
  let seekedThisTrack = false;

  const trackChangeCbs = [];
  const playingStartedCbs = [];
  const playStateCbs = [];

  // ---- tiny IndexedDB kv for the directory handle ----
  let dbP = null;
  function db() {
    if (!dbP) dbP = new Promise((res, rej) => {
      const r = indexedDB.open("sorter-local", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("kv");
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return dbP;
  }
  async function idbGet(k) { const d = await db(); return new Promise((res) => { const t = d.transaction("kv").objectStore("kv").get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(null); }); }
  async function idbPut(k, v) { const d = await db(); d.transaction("kv", "readwrite").objectStore("kv").put(v, k); }

  function ensureAudio() {
    if (audio) return audio;
    audio = document.getElementById("local-audio");
    if (!audio) {
      audio = document.createElement("audio");
      audio.id = "local-audio";
      audio.preload = "auto";
      audio.controls = true;            // native play/pause + draggable scrub bar + time
      audio.style.width = "100%";
      const seg = document.getElementById("segments");
      if (seg) seg.insertBefore(audio, seg.firstChild);   // dock atop the waveform in the Round 2 panel
      else (document.getElementById("player-area") || document.body).appendChild(audio);
    }
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("play", onPlaying);
    audio.addEventListener("pause", onStop);
    audio.addEventListener("ended", onEnded);
    return audio;
  }

  function onPlaying() {
    if (startOffsetSec > 0 && !seekedThisTrack) {
      seekedThisTrack = true;
      const dur = audio.duration || 0;
      if (dur === 0 || dur > startOffsetSec + 5) { try { audio.currentTime = startOffsetSec; } catch (_) {} }
    }
    if (lastPlayingStartedAt == null) lastPlayingStartedAt = performance.now();
    if (!firstPlayingFired) { firstPlayingFired = true; playingStartedCbs.forEach((cb) => cb(currentInfo())); }
    playStateCbs.forEach((cb) => cb(true));
  }
  function onStop() {
    if (lastPlayingStartedAt != null) { listenAccumulatedMs += performance.now() - lastPlayingStartedAt; lastPlayingStartedAt = null; }
    playStateCbs.forEach((cb) => cb(false));
  }
  function onEnded() { onStop(); }

  function currentInfo() {
    const t = tracks[idx];
    if (!t) return null;
    return { videoId: t.youtube_id, videoTitle: t.title || t.artist || t.youtube_id, author: t.artist || "", durationSec: audio?.duration || t.duration_seconds || 0 };
  }

  // Navigate a (possibly nested) path like "audio/abc.mp3" from dirHandle to a File.
  async function fileAt(path) {
    if (!dirHandle) throw new Error("no folder picked");
    const parts = path.split("/").filter(Boolean);
    let h = dirHandle;
    for (let i = 0; i < parts.length - 1; i++) h = await h.getDirectoryHandle(parts[i]);
    const fh = await h.getFileHandle(parts[parts.length - 1]);
    return fh.getFile();
  }

  async function loadIndex(i) {
    if (i < 0 || i >= tracks.length) return;
    idx = i;
    listenAccumulatedMs = 0; lastPlayingStartedAt = null; firstPlayingFired = false; seekedThisTrack = false;
    ensureAudio();
    try {
      const file = await fileAt(tracks[idx].mp3 || `audio/${tracks[idx].youtube_id}.mp3`);
      if (curObjectUrl) URL.revokeObjectURL(curObjectUrl);
      curObjectUrl = URL.createObjectURL(file);
      audio.src = curObjectUrl;
      audio.load();
      audio.play().catch(() => {});            // autoplay the new track (allowed after the first user gesture)
    } catch (e) {
      console.warn("local audio load failed for", tracks[idx]?.youtube_id, e);
    }
    trackChangeCbs.forEach((cb) => cb(currentInfo()));   // fire even if file missing (so UI advances)
  }

  // ---- folder + manifest ----
  async function restoreFolder() {
    try {
      const h = await idbGet("dataDir");
      if (h) {
        let p = await h.queryPermission({ mode: "read" });
        if (p !== "granted") p = await h.requestPermission({ mode: "read" });  // re-grant without re-picking the whole tree
        if (p === "granted") { dirHandle = h; return true; }
      }
    } catch (_) {}
    return false;
  }
  async function pickFolder() {
    if (!window.showDirectoryPicker) throw new Error("File System Access API unavailable (use Chrome/Edge)");
    dirHandle = await window.showDirectoryPicker({ id: "round2-data", mode: "read" });
    await idbPut("dataDir", dirHandle);
    return loadManifestFromFolder();
  }
  async function loadManifestFromFolder(manifestName = "round2_pilot.json") {
    let file;
    try { file = await fileAt(manifestName); }
    catch (_) { throw new Error("MANIFEST_NOT_FOUND"); }   // wrong folder picked (no round2_pilot.json inside)
    const json = JSON.parse(await file.text());
    tracks = json.tracks || json;
    idx = -1;
    return { ok: true, n: tracks.length };
  }

  return {
    init() { ensureAudio(); },
    onReady(cb) { cb(); },
    // load(): for Round 2, restore the saved folder if possible, then load manifest+first track.
    async load() {
      ensureAudio();
      if (!dirHandle) { const ok = await restoreFolder(); if (!ok) return { needsFolder: true }; }
      if (!tracks.length) await loadManifestFromFolder();
      if (tracks.length) await loadIndex(0);
      return { ok: true, n: tracks.length };
    },
    pickFolder,
    hasFolder() { return !!dirHandle; },
    setManifest(arr) { tracks = arr || []; idx = -1; },
    loadVideoIds() { /* n/a for local */ },
    next() { if (idx < tracks.length - 1) loadIndex(idx + 1); },
    previous() { if (idx > 0) loadIndex(idx - 1); },
    playAt(i) { loadIndex(i); },
    getPlaylist() { return tracks.map((t) => t.youtube_id); },
    getPlaylistIndex() { return idx; },
    moveCurrentToEnd() {
      if (tracks.length < 2 || idx < 0) { this.next(); return; }
      const [cur] = tracks.splice(idx, 1); tracks.push(cur);
      loadIndex(idx % tracks.length);
    },
    play() { ensureAudio().play().catch(() => {}); },
    pause() { if (audio) audio.pause(); },
    togglePlay() { if (!audio) return; if (audio.paused) audio.play().catch(() => {}); else audio.pause(); },
    seek(s) { if (audio) { try { audio.currentTime = Math.max(0, s); } catch (_) {} } },
    seekBy(d) { if (audio) { try { audio.currentTime = Math.max(0, (audio.currentTime || 0) + d); } catch (_) {} } },
    currentTime() { return audio ? (audio.currentTime || 0) : 0; },
    setStartOffset(sec) { startOffsetSec = Math.max(0, Number(sec) || 0); },
    getCurrent: currentInfo,
    // expose the full manifest record for the current track (subgenre etc.)
    currentTrack() { return tracks[idx] || null; },
    getTracks() { return tracks.slice(); },
    async urlFor(track) { const f = await fileAt(track.mp3 || `audio/${track.youtube_id}.mp3`); return URL.createObjectURL(f); },
    listenSeconds() { let ms = listenAccumulatedMs; if (lastPlayingStartedAt != null) ms += performance.now() - lastPlayingStartedAt; return ms / 1000; },
    onTrackChange(fn) { trackChangeCbs.push(fn); },
    onPlayingStarted(fn) { playingStartedCbs.push(fn); },
    onPlayStateChange(fn) { playStateCbs.push(fn); },
  };
})();
