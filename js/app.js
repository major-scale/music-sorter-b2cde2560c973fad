// Main wiring: UI events, listen-time gate, rating → advance flow,
// consistency-check insertion, keyboard / swipe / haptic.

(function () {
  const $ = (id) => document.getElementById(id);
  const ratingRow = $("rating-row");
  const slopBtn = $("btn-slop");
  const midBtn  = $("btn-mid");
  const loveBtn = $("btn-love");
  const overlay = $("player-overlay");
  const metaArtist = $("meta-artist");
  const metaTitle  = $("meta-title");
  const metaVideoTitle = $("meta-video-title");
  const notesInput = $("notes-input");

  let active = Queue.getActive();
  let selected5pt = null;
  let selectedConfidence = null;   // "sure" | "think_so" | "guess"
  let selectedFamiliar = null;     // "novel" | "known"
  let testMode = false;            // flag actions as test (annotation_pass="test") so the real pass stays clean
  let trackInfo = null;
  let advancePending = false;
  let pendingConsistency = null;
  const metaCache = {};   // youtube_id → fetched metadata (so the line shows before rating)
  let settings = Ratings.getSettings();

  // double-tap rating state
  let pendingKey = null;
  let pendingKeyTimer = null;

  // navigation / undo state
  let suppressAutoSkipOnce = false;
  let undoState = null;        // { youtubeId, prevRecord|null }
  let resumeChecked = false;   // jump-to-first-unrated only once per load
  // κ (reliability) mode: blind re-rate of already-rated tracks; never overwrites.
  let kappaMode = false;
  let prevActivePlaylistId = null;
  // timer tracks actual seconds played (Player.listenSeconds); globallyStopped mirrors
  // the YouTube player's real paused state (synced both ways via onPlayStateChange).
  let globallyStopped = true;

  // ----------------- bootstrap -----------------

  PWA.register();
  PWA.captureInstallPrompt();
  try {                                   // repair any 3-class/5-point mismatches saved before reconciliation
    const fixed = Ratings.reconcileAll ? Ratings.reconcileAll() : 0;
    if (fixed) { console.log(`[ratings] reconciled ${fixed} 3-class/5-point mismatch(es)`); setTimeout(() => PWA.showToast(`Fixed ${fixed} rating(s) where the detailed score didn't match SLOP/MID/LOVE`, 4200), 600); }
  } catch (_) {}
  Stats.refreshCompact();
  renderPresets();
  updateRatedCountNote();
  applySettings();
  setInterval(updateRateTimer, 500);   // live played-seconds display
  updateStopButton();
  $("btn-stop").addEventListener("click", toggleStop);

  // Resume live-sync silently if a handle was previously stored
  Sync.tryRestore().then((on) => {
    refreshSyncMenuLabel();
    if (on) PWA.showToast("Live sync resumed", 1200);
  });

  // Pull + merge cloud history on load so this instance converges to the full
  // cross-device, cross-origin history (only if a token is configured here).
  if (GithubSync.isEnabled()) {
    GithubSync.pullMerge()
      .then((n) => {
        Stats.refreshCompact(); updateRatedCountNote(); updateQueueProgress();
        if (n) PWA.showToast(`Synced ${n} ratings from cloud`, 2500);
        recheckCurrentForSkip();
      })
      .catch((err) => console.warn("cloud pull failed", err));
  }

  if (!active) {
    openModal("queue-modal");
  } else {
    Player.onReady(() => Player.load(active.playlistId));
    showOverlayIfMobile();
  }

  Player.onTrackChange((info) => onTrack(info));
  Player.onPlayingStarted(() => overlay.classList.add("hidden"));
  // Mirror the YouTube player's real play/pause state onto the global stop + timer.
  Player.onPlayStateChange((playing) => {
    globallyStopped = !playing;
    updateStopButton();
    updateRateTimer();
  });

  // ----------------- queue modal -----------------

  function renderPresets() {
    const ul = $("preset-list");
    ul.innerHTML = "";
    const presets = Ratings.getPresets();
    presets.forEach((p, idx) => {
      const li = document.createElement("li");
      li.className = "preset-row";
      li.innerHTML = `
        <div>
          <div class="preset-title"></div>
          <code class="preset-url"></code>
        </div>
        <button type="button" class="primary-btn" data-i="${idx}">Use</button>
        <button type="button" class="ghost-btn small" data-del="${idx}" aria-label="Remove">✕</button>
      `;
      li.querySelector(".preset-title").textContent = p.title;
      li.querySelector(".preset-url").textContent = p.url;
      ul.appendChild(li);
    });
  }

  $("preset-list").addEventListener("click", (e) => {
    const useIdx = e.target.dataset.i;
    const delIdx = e.target.dataset.del;
    if (useIdx != null) {
      const p = Ratings.getPresets()[Number(useIdx)];
      loadFromUrl(p.url, p.title);
    } else if (delIdx != null) {
      const presets = Ratings.getPresets();
      presets.splice(Number(delIdx), 1);
      Ratings.setPresets(presets);
      renderPresets();
    }
  });

  $("add-preset").addEventListener("click", () => {
    const title = prompt("Preset title (e.g. \"Anjunadeep Best of 2026\"):");
    if (!title) return;
    const url = prompt("Playlist URL:");
    if (!url) return;
    if (!Queue.parsePlaylistId(url)) {
      alert("Couldn't extract a playlist ID from that URL.");
      return;
    }
    const presets = Ratings.getPresets();
    presets.push({ title: title.trim(), url: url.trim() });
    Ratings.setPresets(presets);
    renderPresets();
  });

  $("load-custom").addEventListener("click", () => {
    const url = $("custom-url").value;
    loadFromUrl(url, "Custom playlist");
  });

  function loadFromUrl(url, title) {
    const id = Queue.parsePlaylistId(url);
    if (!id) { alert("Couldn't extract a playlist ID from that URL."); return; }
    active = Queue.setActive({ playlistId: id, title, skipRated: $("opt-skip-rated").checked });
    const batchName = (title && title !== "Custom playlist")
      ? title
      : (prompt("Name this batch (for your history):", title || "New batch") || title || "New batch");
    Ratings.ensureBatchForPlaylist(id, batchName);
    resumeChecked = false;
    Player.load(id);
    closeModal("queue-modal");
    showOverlayIfMobile();
  }

  function updateRatedCountNote() {
    $("rated-count-note").textContent = `${Ratings.getRatedIds().size} tracks rated so far.`;
  }

  // ----------------- track change -----------------

  function onTrack(info) {
    if (!info) return;
    trackInfo = info;
    resetTrackUI(info);
    Stats.refreshCompact();
    updateRatedCountNote();
    updateQueueProgress();
    setMediaSession(info);

    // κ mode: replay the sampled tracks in order, blind. No auto-skip, no resume
    // jump, no revealing the prior rating. The banner tracks progress.
    if (kappaMode) {
      updateKappaBanner();
      showEnrichedMeta(info.videoId);
      maybeEnrichCurrent(info.videoId);
      return;
    }

    maybeResume();

    const skipSuppressed = suppressAutoSkipOnce;
    suppressAutoSkipOnce = false;

    // Already-rated handling (cross-batch): skip if user opted in, not a consistency
    // check, and not currently navigating backward to review/re-rate. Jumps over a
    // whole run of already-rated tracks in one hop rather than stepping through them.
    if (active && active.skipRated !== false && !skipSuppressed) {
      const rated = Ratings.getRating(info.videoId);
      const isConsistencyTarget = pendingConsistency && pendingConsistency.youtube_id === info.videoId;
      if (rated && !isConsistencyTarget) {
        const idx = Player.getPlaylistIndex();
        const nxt = nextUnratedIndex(idx);
        if (nxt >= 0) {
          const jumped = nxt - idx;
          PWA.showToast(jumped > 1 ? `Skipping ${jumped} already-rated` : `Already rated ${rated.rating_3class} — skipping`, 1400);
          Player.playAt(nxt);
        } else {
          PWA.showToast("All remaining tracks already rated — switch queue or turn off skip", 3500);
        }
        return;
      }
    }

    // Reflect an existing rating so the user can re-rate intentionally.
    showExistingRating(info.videoId);
    showEnrichedMeta(info.videoId);
    maybeEnrichCurrent(info.videoId);

    // Apply consistency target if this is the inserted re-rate
    if (pendingConsistency && pendingConsistency.youtube_id === info.videoId) {
      Ratings.setConsistencyTarget(pendingConsistency);
      PWA.showToast("Consistency check — rate it fresh", 2200);
      pendingConsistency = null;
    }
  }

  function showExistingRating(youtubeId) {
    const el = $("current-rating");
    const existing = Ratings.getRating(youtubeId);
    if (existing && existing.rating_3class) {
      el.textContent = `rated: ${existing.rating_3class}${existing.rating_5point ? " (" + existing.rating_5point + ")" : ""}`;
      el.className = "current-rating " + existing.rating_3class;
      // prefill notes + 5pt so a re-rate preserves them unless changed
      if (existing.notes) notesInput.value = existing.notes;
      if (existing.rating_5point) {
        selected5pt = existing.rating_5point;
        const b = document.querySelector(`.fp-btn[data-fp="${existing.rating_5point}"]`);
        if (b) { document.querySelectorAll(".fp-btn").forEach((x) => x.classList.remove("selected")); b.classList.add("selected"); }
      }
      if (existing.artist && !metaArtist.value) metaArtist.value = existing.artist;
      if (existing.title && !metaTitle.value) metaTitle.value = existing.title;
    } else {
      el.textContent = "";
      el.className = "current-rating";
    }
  }

  // Toggling just drives the player; globallyStopped + button update via onPlayStateChange.
  function toggleStop() {
    if (globallyStopped) Player.play(); else Player.pause();
  }
  function updateStopButton() {
    const b = $("btn-stop");
    if (!b) return;
    b.textContent = globallyStopped ? "▶" : "⏸";
    b.classList.toggle("stopped", globallyStopped);
    b.title = globallyStopped ? "Resume playback" : "Pause playback";
  }

  function updateRateTimer() {
    const el = $("rate-timer");
    if (!el) return;
    if (!trackInfo) { el.textContent = ""; return; }
    const s = Player.listenSeconds();   // actual accumulated playback seconds for this track
    el.textContent = `${globallyStopped ? "⏸" : "▶"} ${s.toFixed(0)}s played`;
  }

  function fmtDur(sec) {
    if (!sec) return "";
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }
  function fmtViews(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
    if (n >= 1e3) return Math.round(n / 1e3) + "K";
    return String(n);
  }

  // Fetch metadata for the track being viewed (even before it's rated) so the line
  // shows while you decide. Cached per session; persisted onto the record if rated.
  function maybeEnrichCurrent(youtubeId) {
    if (!YTMeta.isEnabled()) return;
    const existing = Ratings.getRating(youtubeId);
    if ((existing && existing.enriched_at) || metaCache[youtubeId]) return;
    YTMeta.lookup(youtubeId).then((meta) => {
      if (!meta) return;
      metaCache[youtubeId] = meta;
      if (existing) Ratings.enrich(youtubeId, meta);
      if (trackInfo && trackInfo.videoId === youtubeId) showEnrichedMeta(youtubeId);
    }).catch((e) => console.warn("[YTMeta] load enrich failed", e.message));
  }

  function showEnrichedMeta(youtubeId) {
    const el = $("enriched-meta");
    if (!el) return;
    const r = Ratings.getRating(youtubeId) || metaCache[youtubeId];
    if (!r) { el.innerHTML = ""; return; }
    const bits = [];
    if (r.yt_label) bits.push(`<span class="label">🏷 ${r.yt_label}</span>`);
    if (r.yt_release_date) bits.push(`released ${r.yt_release_date}`);
    else if (r.published_at) bits.push(`uploaded ${r.published_at.slice(0, 10)}`);
    if (r.channel_title) bits.push(r.channel_title);
    if (r.duration_seconds) bits.push(fmtDur(r.duration_seconds));
    if (r.view_count) bits.push(fmtViews(r.view_count) + " views");
    if (r.topics && r.topics.length) bits.push(r.topics.slice(0, 2).join(", "));
    el.innerHTML = bits.join(" · ");
  }

  function updateQueueProgress() {
    const el = $("queue-progress");
    const list = Player.getPlaylist();
    const idx = Player.getPlaylistIndex();
    if (!list.length || idx < 0) { el.textContent = ""; return; }
    const rated = Ratings.getRatedIds();
    const unrated = list.filter((id) => !rated.has(id)).length;
    el.textContent = `track ${idx + 1} / ${list.length} · ${unrated} unrated`;
  }

  function nextUnratedIndex(fromIndex) {
    const list = Player.getPlaylist();
    if (!list.length) return -1;
    const rated = Ratings.getRatedIds();
    for (let i = fromIndex + 1; i < list.length; i++) {
      if (!rated.has(list[i])) return i;
    }
    return -1;
  }

  // Re-evaluate the currently-playing track after ratings load asynchronously
  // (e.g., a cloud pull finishing after playback started). Jumps over a run of
  // already-rated tracks if the current one is rated.
  function recheckCurrentForSkip() {
    if (!trackInfo) return;
    if (!active || active.skipRated === false) return;
    if (!Ratings.getRating(trackInfo.videoId)) return;
    const idx = Player.getPlaylistIndex();
    const nxt = nextUnratedIndex(idx);
    if (nxt >= 0) {
      const jumped = nxt - idx;
      PWA.showToast(jumped > 1 ? `Skipping ${jumped} already-rated` : "Already rated — skipping", 1400);
      Player.playAt(nxt);
    }
  }

  function maybeResume() {
    if (resumeChecked) return;
    const list = Player.getPlaylist();
    if (!list.length) return; // playlist not ready yet; retry on next track event
    resumeChecked = true;

    const rated = Ratings.getRatedIds();
    const ratedCount = list.filter((id) => rated.has(id)).length;
    if (ratedCount > 0) {
      PWA.showToast(`${list.length} tracks · ${ratedCount} already rated across all batches`, 2800);
    }
    if (!active || active.skipRated === false) return;
    const firstUnrated = list.findIndex((id) => !rated.has(id));
    const idx = Player.getPlaylistIndex();
    if (firstUnrated === -1) {
      PWA.showToast("Every track in this playlist is already rated — switch queue or turn off skip", 4000);
    } else if (firstUnrated > idx) {
      Player.playAt(firstUnrated);
    }
  }

  function setMediaSession(info) {
    if (!("mediaSession" in navigator)) return;
    try {
      const parsed = Ratings.parseTitle(info.videoTitle);
      navigator.mediaSession.metadata = new MediaMetadata({
        title: parsed.title || info.videoTitle || "",
        artist: parsed.artist || "",
        artwork: [
          { src: `https://i.ytimg.com/vi/${info.videoId}/hqdefault.jpg`, sizes: "480x360", type: "image/jpeg" },
        ],
      });
      navigator.mediaSession.setActionHandler("nexttrack", () => Player.next());
      navigator.mediaSession.setActionHandler("previoustrack", () => goPrev());
      navigator.mediaSession.setActionHandler("play", () => Player.play());
      navigator.mediaSession.setActionHandler("pause", () => Player.pause());
    } catch (_) {}
  }

  function resetTrackUI(info) {
    const local = Player.backendName && Player.backendName() === "local" && Player.currentTrack;
    if (local) {
      const t = Player.currentTrack() || {};
      metaArtist.value = t.artist || "";
      metaTitle.value  = t.title || "";
      metaVideoTitle.textContent = `${t.artist || ""} — ${t.title || ""}${t.subgenre ? "  ·  " + t.subgenre : ""}`;
    } else {
      const parsed = Ratings.parseTitle(info.videoTitle);
      metaArtist.value = parsed.artist;
      metaTitle.value  = parsed.title;
      metaVideoTitle.textContent = info.videoTitle || "(unknown)";
    }
    notesInput.value = "";
    selected5pt = null;
    selectedConfidence = null;
    selectedFamiliar = null;
    document.querySelectorAll(".fp-btn, .conf-btn, .fam-btn").forEach((b) => b.classList.remove("selected"));
    const em = $("enriched-meta"); if (em) em.innerHTML = "";
    if (window.Segments) {
      Segments.reset(info && info.durationSec);
      Segments.setActive("neutral");
      const yid = (Player.backendName && Player.backendName() === "local" && Player.currentTrack && Player.currentTrack()?.youtube_id) || (info && info.videoId);
      const saved = yid ? Ratings.getRating(yid) : null;
      if (saved) {                                         // returning to a labeled track → restore the work
        if ((saved.segments || []).length || (saved.neutral_markers || []).length) Segments.restore(saved.neutral_markers, saved.segments);
        selectedConfidence = saved.confidence || null;
        selectedFamiliar = saved.is_familiar || null;
        if (selectedConfidence) document.querySelector('.conf-btn[data-conf="' + selectedConfidence + '"]')?.classList.add("selected");
        if (selectedFamiliar) document.querySelector('.fam-btn[data-fam="' + selectedFamiliar + '"]')?.classList.add("selected");
      }
    }
    document.querySelectorAll(".seg-mark").forEach((x) => x.classList.remove("active"));
    document.querySelector('.seg-mark[data-seg="neutral"]')?.classList.add("active");   // neutral = base case, default each song
  }

  // ----------------- rating -----------------

  function recordRating(label) {
    if (!trackInfo) { PWA.showToast("No track loaded yet"); return; }
    if (kappaMode) { recordKappaRerate(label); return; }
    if (advancePending) return;
    advancePending = true;

    const btn = label === "LOVE" ? loveBtn : (label === "MID" ? midBtn : slopBtn);
    btn.classList.add("flash");
    haptic();

    // capture state for undo (before overwrite)
    undoState = { youtubeId: trackInfo.videoId, prevRecord: Ratings.getRating(trackInfo.videoId) };

    const timeToRate = Player.listenSeconds();   // actual seconds of the song played before deciding

    const record = Ratings.rate({
      youtubeId: trackInfo.videoId,
      videoTitle: trackInfo.videoTitle,
      artist: metaArtist.value || null,
      title: metaTitle.value || null,
      queuedFrom: "youtube_playlist",
      sourcePlaylistId: active?.playlistId || null,
      sourcePlaylistTitle: active?.title || null,
      rating3class: label,
      rating5point: selected5pt,
      listenSeconds: Player.listenSeconds(),
      timeToRate,
      notes: notesInput.value || "",
      subgenreTags: (Player.backendName && Player.backendName() === "local" && Player.currentTrack && Player.currentTrack()?.subgenre)
        ? [Player.currentTrack().subgenre] : [],
      confidence: selectedConfidence,
      isFamiliar: selectedFamiliar,
      neutralAnchorSeconds: window.Segments ? Segments.getAnchor() : null,
      neutralMarkers: window.Segments ? Segments.getNeutrals() : [],
      segments: window.Segments ? Segments.getSegments() : [],
      annotationPass: testMode ? "test" : ((Player.backendName && Player.backendName() === "local") ? "rich-v1" : null),
    });
    selected5pt = record.rating_5point;   // keep in sync with the reconciled stored value
    Stats.refreshCompact();
    syncAll();
    PWA.showToast(`Rated ${label} (${record.rating_5point})${record.is_consistency_check ? " · consistency check" : ""}`, 1200);

    // Enrich with YouTube metadata: reuse what was fetched on load, else fetch now.
    if (metaCache[record.youtube_id]) {
      Ratings.enrich(record.youtube_id, metaCache[record.youtube_id]);
    } else if (YTMeta.isEnabled() && !record.enriched_at) {
      YTMeta.lookup(record.youtube_id)
        .then((meta) => { if (meta && Ratings.enrich(record.youtube_id, meta)) { metaCache[record.youtube_id] = meta; syncAll(); } })
        .catch((e) => console.warn("[YTMeta] enrich failed", e.message));
    }

    // Maybe queue a consistency check for after the next advance
    const consistencyTarget = Ratings.maybeQueueConsistencyCheck();
    if (consistencyTarget) pendingConsistency = consistencyTarget;

    setTimeout(() => {
      btn.classList.remove("flash");
      advancePending = false;
      Player.next();
    }, 600);
  }

  function haptic() {
    if (navigator.vibrate) navigator.vibrate(20);
  }

  // ----------------- reliability check (κ) -----------------

  function startKappa() {
    const test = Ratings.startKappaTest(50);
    if (!test || !test.plan.length) { PWA.showToast("No rated tracks yet to re-test", 2800); return; }
    kappaMode = true;
    prevActivePlaylistId = active?.playlistId || null;
    resumeChecked = true;            // never jump-to-unrated in κ mode
    suppressAutoSkipOnce = false;
    const ids = test.plan.map((p) => p.youtube_id);
    Player.onReady(() => Player.loadVideoIds(ids));
    updateKappaBanner();
    showOverlayIfMobile();
    PWA.showToast(`κ-test: ${ids.length} tracks. Rate each one FRESH — your old ratings are hidden.`, 4500);
  }

  function updateKappaBanner() {
    const banner = $("kappa-banner");
    if (!banner) return;
    if (!kappaMode) { banner.classList.add("hidden"); return; }
    const test = Ratings.getKappaTest();
    const done = test ? test.responses.length : 0;
    const total = test ? test.plan.length : 0;
    $("kappa-banner-text").textContent = `κ-test · rate fresh (old ratings hidden) · ${done}/${total}`;
    banner.classList.remove("hidden");
  }

  function recordKappaRerate(label) {
    if (advancePending) return;
    advancePending = true;
    const btn = label === "LOVE" ? loveBtn : (label === "MID" ? midBtn : slopBtn);
    btn.classList.add("flash");
    haptic();
    Ratings.recordKappaRerate({
      youtube_id: trackInfo.videoId,
      rerate_label: label,
      rerate_5pt: selected5pt,
      timeToRate: Player.listenSeconds(),
      listenSeconds: Player.listenSeconds(),
    });
    updateKappaBanner();
    const test = Ratings.getKappaTest();
    const done = test.responses.length, total = test.plan.length;
    setTimeout(() => {
      btn.classList.remove("flash");
      advancePending = false;
      if (done >= total) finishKappa();
      else { PWA.showToast(`Logged ${done}/${total}`, 800); Player.next(); }
    }, 450);
  }

  function finishKappa() {
    kappaMode = false;
    updateKappaBanner();
    showKappaResults();
    if (prevActivePlaylistId) { resumeChecked = false; Player.load(prevActivePlaylistId); }
  }

  function showKappaResults() {
    const r = Ratings.computeKappaTest();
    const el = $("kappa-results");
    if (!r) {
      el.innerHTML = "<p class='modal-note'>No re-ratings recorded yet.</p>";
      openModal("kappa-modal");
      return;
    }
    const pct = (x) => x == null ? "—" : (x * 100).toFixed(0) + "%";
    const kfmt = (x) => x == null ? "—" : x.toFixed(2);
    const interp = (k) => k == null ? "" :
      k >= 0.8 ? "almost perfect" : k >= 0.6 ? "substantial" :
      k >= 0.4 ? "moderate" : k >= 0.2 ? "fair" : "slight";
    const ck = r.cohenK;
    const verdict = ck == null ? "" :
      ck >= 0.7 ? "Your taste is highly self-consistent — strong evidence the signal is real, and the model has a high ceiling to chase." :
      ck >= 0.5 ? "Moderately consistent — there's real signal, but label noise caps how high any model can score." :
      "Low self-consistency — the labels are noisy, which structurally limits any model. Worth re-rating more deliberately.";
    const labelRows = ["LOVE", "MID", "SLOP"].map((lab) => {
      const b = r.byLabel[lab];
      return `<tr><td class="${lab.toLowerCase()}">${lab}</td><td>${b.n}</td><td>${b.n ? pct(b.agree / b.n) : "—"}</td></tr>`;
    }).join("");
    const flips = Object.entries(r.confusion)
      .filter(([k]) => k.split("→")[0] !== k.split("→")[1])
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k} ×${v}`).join(" · ") || "none — no disagreements";
    el.innerHTML = `
      <p class="modal-note">Blind re-rate of ${r.n}${r.planned !== r.n ? " of " + r.planned : ""} tracks. Your originals were never shown or changed.</p>
      <div class="kappa-big">
        <div><span class="kappa-num">${pct(r.exactAgree)}</span><span class="kappa-lbl">exact agreement</span></div>
        <div><span class="kappa-num">${kfmt(r.cohenK)}</span><span class="kappa-lbl">Cohen's κ <em>(${interp(r.cohenK)})</em></span></div>
        <div><span class="kappa-num">${kfmt(r.weightedK)}</span><span class="kappa-lbl">weighted κ (ordinal)</span></div>
      </div>
      <table class="kappa-table">
        <thead><tr><th>label</th><th>n</th><th>agreed</th></tr></thead>
        <tbody>${labelRows}</tbody>
      </table>
      <p class="modal-note">Disagreements: ${flips}</p>
      <p class="modal-note"><strong>${verdict}</strong></p>`;
    openModal("kappa-modal");
  }

  ratingRow.addEventListener("click", (e) => {
    const btn = e.target.closest(".rate-btn");
    if (!btn || btn.disabled) return;
    recordRating(btn.dataset.rating);
  });

  // ----------------- quick actions -----------------

  function goPrev() {
    suppressAutoSkipOnce = true;
    Player.previous();
  }
  $("btn-prev").addEventListener("click", goPrev);
  // Next advances forward and auto-skips already-rated (does NOT suppress); Prev
  // suppresses so you can step back onto rated tracks to review / re-rate.
  $("btn-next").addEventListener("click", () => Player.next());
  $("btn-skip").addEventListener("click", () => {
    PWA.showToast("Moved to end of queue", 1400);
    Player.moveCurrentToEnd();
  });
  $("btn-undo").addEventListener("click", undoLastRating);

  function undoLastRating() {
    if (!undoState) { PWA.showToast("Nothing to undo", 1200); return; }
    const { youtubeId, prevRecord } = undoState;
    if (prevRecord) Ratings.putRecord(prevRecord);
    else Ratings.deleteRating(youtubeId);
    undoState = null;
    Stats.refreshCompact();
    syncAll();
    PWA.showToast(prevRecord ? `Reverted to ${prevRecord.rating_3class}` : "Rating removed", 1600);
    // navigate back to that track so the user can re-decide
    suppressAutoSkipOnce = true;
    Player.previous();
  }

  $("btn-unavailable").addEventListener("click", () => {
    if (!trackInfo) return;
    Ratings.rate({
      youtubeId: trackInfo.videoId,
      videoTitle: trackInfo.videoTitle,
      artist: metaArtist.value, title: metaTitle.value,
      queuedFrom: "youtube_playlist",
      sourcePlaylistId: active?.playlistId || null,
      sourcePlaylistTitle: active?.title || null,
      rating3class: "UNAVAILABLE",
      rating5point: null,
      listenSeconds: Player.listenSeconds(),
      notes: notesInput.value || "",
    });
    Stats.refreshCompact();
    syncAll();
    Player.next();
  });

  // ----------------- more detail -----------------

  $("more-toggle").addEventListener("click", () => {
    const wrap = $("more-detail");
    const open = wrap.classList.toggle("collapsed");
    $("more-toggle").setAttribute("aria-expanded", String(!open));
    $("more-toggle").textContent = open ? "More detail ▾" : "More detail ▴";
  });
  function persistDetailEdit() {            // if the track is already rated, save confidence/familiarity/5pt right away
    if (!trackInfo) return false;
    const existing = Ratings.getRating(trackInfo.videoId);
    if (!existing || !existing.rating_3class) return false;   // unrated → held until you click a tier
    Ratings.setDetail(trackInfo.videoId, { confidence: selectedConfidence, isFamiliar: selectedFamiliar, rating5point: selected5pt });
    syncAll();
    return true;
  }
  document.querySelectorAll(".fp-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".fp-btn").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      selected5pt = Number(b.dataset.fp);
      if (persistDetailEdit()) PWA.showToast("✓ saved", 800);
    });
  });
  document.querySelectorAll(".conf-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".conf-btn").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      selectedConfidence = b.dataset.conf;
      if (persistDetailEdit()) PWA.showToast("✓ saved", 800);
    });
  });
  document.querySelectorAll(".fam-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".fam-btn").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      selectedFamiliar = b.dataset.fam;
      if (persistDetailEdit()) PWA.showToast("✓ saved", 800);
    });
  });
  // Segment markers: the label buttons are SELECTORS (set the active type); markers are
  // PLACED by dragging on the waveform (slight drag = point, wider = range; plain click = seek).
  if ($("seg-clear")) $("seg-clear").addEventListener("click", () => window.Segments && Segments.clear());
  document.querySelectorAll(".seg-mark").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".seg-mark").forEach((x) => x.classList.remove("active"));
      b.classList.add("active");
      if (window.Segments) Segments.setActive(b.dataset.seg);
    });
  });
  // Round 2 (local-audio pilot) activation: switch backend, pick the data/ folder, load manifest.
  async function activateRound2() {
    try {
      Player.use("local");
      let res = await Player.load();                   // resume the saved folder silently / quick allow-prompt
      if (res && res.needsFolder) {                    // first time or handle gone → full picker
        await Player.pickFolder();
        res = await Player.load();
      }
      if (res && res.ok) {
        document.body.classList.add("round2-mode");
        $("segments").classList.remove("hidden");
        if (window.Segments) { Segments.enable(true); Segments.setActive("neutral"); }
        document.querySelector('.seg-mark[data-seg="neutral"]')?.classList.add("active");
        PWA.showToast(`Round 2: ${res.n} tracks (local audio)`, 2400);
      }
    } catch (e) {
      console.warn("Round 2 activation failed", e);
      PWA.showToast("Round 2 cancelled / unavailable (needs Chrome/Edge)", 2400);
      Player.use("youtube");
    }
  }
  if ($("btn-round2")) $("btn-round2").addEventListener("click", activateRound2);
  if ($("queue-round2")) $("queue-round2").addEventListener("click", () => { closeModal("queue-modal"); activateRound2(); });

  // ---------------- pairwise / playoff (Round 2) ----------------
  let pairState = null, lastPairKey = null, battleQueue = null, battleStartedAt = 0, battleIsLocal = false;
  const flipPair = (p) => (Math.random() < 0.5 ? p : { ...p, a: p.b, b: p.a });   // randomize A/B side to kill position bias
  const pairAudios = () => [$("pair-audio-a"), $("pair-audio-b")];
  function pairStopAudio() { pairAudios().forEach((a) => { if (a) { try { a.pause(); } catch (_) {} } }); }
  function pairPick() {
    const tracks = (Player.getTracks ? Player.getTracks() : []).filter((t) => t.has_audio !== false);
    const bySg = {};
    for (const t of tracks) { const k = t.subgenre || "?"; (bySg[k] = bySg[k] || []).push(t); }
    const styles = Object.keys(bySg).filter((k) => bySg[k].length >= 2);
    if (!styles.length) return null;
    for (let i = 0; i < 30; i++) {
      const sg = styles[Math.floor(Math.random() * styles.length)];
      const pool = bySg[sg];
      const a = pool[Math.floor(Math.random() * pool.length)];
      const b = pool[Math.floor(Math.random() * pool.length)];
      if (a.youtube_id === b.youtube_id) continue;
      const key = [a.youtube_id, b.youtube_id].sort().join("|");
      if (key === lastPairKey) continue;
      lastPairKey = key; return { a, b, context: sg };
    }
    return null;
  }
  function pairRender() {
    if (!pairState) return;
    let ctx;
    if (pairState.battle) {                                 // derive each side's tier (robust to A/B flip)
      const order = { LOVE: 0, MID: 1, SLOP: 2 };
      const at = (Ratings.getRating(pairState.a.youtube_id) || {}).rating_3class;
      const bt = (Ratings.getRating(pairState.b.youtube_id) || {}).rating_3class;
      if (at && bt && at !== bt) {
        const gap = Math.abs((order[at] ?? 0) - (order[bt] ?? 0));
        ctx = gap >= 2 ? `🎲 long-shot — A is ${at}, B is ${bt}. Usually obvious… any upset?` : `🔀 cross-tier — A is ${at}, B is ${bt}: which is actually better?`;
      } else ctx = `both rated ${at || pairState.context} — which is better?`;
    } else ctx = `same style: ${pairState.context}`;
    $("pair-context").textContent = ctx;
    $("pair-a-meta").textContent = `A:  ${pairState.a.artist || ""} — ${pairState.a.title || ""}`;
    $("pair-b-meta").textContent = `B:  ${pairState.b.artist || ""} — ${pairState.b.title || ""}`;
    loadPairAudio();
  }
  async function loadPairAudio() {                        // two independent big-scrub players (A & B separately)
    const cur = pairState;
    for (const side of ["a", "b"]) {
      const el = $("pair-audio-" + side), t = cur && cur[side];
      const seek = document.querySelector(`.pair-seek[data-side="${side}"]`);
      const pp = document.querySelector(`.pair-pp[data-side="${side}"]`);
      if (!el || !t) continue;
      try { el.pause(); } catch (_) {}
      if (seek) seek.value = 0; if (pp) pp.textContent = "▶";
      try {
        const url = await Player.urlFor(t);
        if (pairState !== cur) return;                    // a newer pair loaded — abandon
        el.src = url; el.load();
      } catch (e) { PWA.showToast("Couldn't load audio — did you pick the folder?", 2000); }
    }
  }
  function setupPairPlayers() {                           // wire the custom play/seek/time controls once
    const fmt = (s) => { s = Math.max(0, Math.floor(s || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`; };
    const scrub = {};
    ["a", "b"].forEach((side) => {
      const el = $("pair-audio-" + side);
      const seek = document.querySelector(`.pair-seek[data-side="${side}"]`);
      const pp = document.querySelector(`.pair-pp[data-side="${side}"]`);
      const time = document.querySelector(`.pair-time[data-side="${side}"]`);
      if (!el) return;
      const upd = () => { if (time) time.textContent = `${fmt(el.currentTime)} / ${fmt(el.duration)}`; };
      el.addEventListener("loadedmetadata", () => { if (seek) seek.max = el.duration || 0; try { if (el.duration > 35) el.currentTime = 30; } catch (_) {} if (seek) seek.value = el.currentTime; upd(); });
      el.addEventListener("timeupdate", () => { if (!scrub[side] && seek) seek.value = el.currentTime; upd(); });
      el.addEventListener("play", () => { if (pp) pp.textContent = "⏸"; const o = $("pair-audio-" + (side === "a" ? "b" : "a")); if (o && !o.paused) o.pause(); });
      el.addEventListener("pause", () => { if (pp) pp.textContent = "▶"; });
      el.addEventListener("ended", () => { if (pp) pp.textContent = "▶"; });
      if (pp) pp.addEventListener("click", () => { if (el.paused) el.play().catch(() => {}); else el.pause(); });
      if (seek) {
        seek.addEventListener("input", () => { scrub[side] = true; el.currentTime = Number(seek.value); upd(); });
        seek.addEventListener("change", () => { scrub[side] = false; });
      }
    });
  }
  setupPairPlayers();
  function pairNext() {
    pairStopAudio();
    if (battleQueue) {                                    // batch-battle / playoff mode: same-rated matchups
      if (!battleQueue.length) {
        const playoff = !!(pairState && pairState.playoff);
        const finishedLocal = battleIsLocal && !playoff;   // only a FULLY-finished local battle consumes the batch
        battleQueue = null; pairState = null; battleIsLocal = false; closeModal("pairwise-modal"); snapshotRanking();
        if (playoff) { PWA.showToast("Round done — ranking updated", 2000); openPlayoff(playoffTier); }
        else { if (finishedLocal) localStorage.setItem("sorter.lastBattleDoneTs", String(battleStartedAt || Date.now())); PWA.showToast("Battle complete — batch ranked", 2600); }
        return;
      }
      pairState = battleQueue.shift(); pairRender(); return;
    }
    pairState = pairPick();
    if (pairState) pairRender(); else closeModal("pairwise-modal");
  }
  function startBattle() {                                // pit same-rated songs from the recent batch head-to-head
    if (!(Player.backendName && Player.backendName() === "local" && Player.hasFolder && Player.hasFolder())) { PWA.showToast("Tap 🎚 Round 2 first", 2600); return; }
    const byId = {}; (Player.getTracks ? Player.getTracks() : []).forEach((t) => { byId[t.youtube_id] = t; });
    const allRich = Ratings.getAll().filter((r) => r.annotation_pass === "rich-v1" && ["LOVE", "MID", "SLOP"].includes(r.rating_3class) && byId[r.youtube_id]);
    const since = Number(localStorage.getItem("sorter.lastBattleDoneTs") || 0);   // songs rated since the last FINISHED battle = this batch
    const rated = allRich.filter((r) => (Date.parse(r.rated_at) || 0) > since);
    const tiers = {}; rated.forEach((r) => { (tiers[r.rating_3class] = tiers[r.rating_3class] || []).push(byId[r.youtube_id]); });
    const strip = (x) => (x || "").replace("yt:", "");
    const compared = new Set((Ratings.getComparisons ? Ratings.getComparisons() : []).map((c) => window.Ranking.pairKey(strip(c.a_id), strip(c.b_id))));
    const pairs = [];
    for (const tier of Object.keys(tiers)) { const pool = tiers[tier]; for (let i = 0; i < pool.length; i++) for (let j = i + 1; j < pool.length; j++) { if (!compared.has(window.Ranking.pairKey(pool[i].youtube_id, pool[j].youtube_id))) pairs.push({ a: pool[i], b: pool[j], context: tier, battle: true }); } }
    if (!pairs.length) {                                   // explain WHY, with the actual batch breakdown
      const cnt = (arr) => ["LOVE", "MID", "SLOP"].map((t) => `${arr.filter((r) => r.rating_3class === t).length} ${t}`).join(" · ");
      const tierMax = Math.max(0, ...["LOVE", "MID", "SLOP"].map((t) => rated.filter((r) => r.rating_3class === t).length));
      let msg;
      if (rated.length === 0 && allRich.length >= 2) msg = `No new songs since your last finished battle (${allRich.length} rated total) — use 🏆 Playoff to rank across all, or label more.`;
      else if (rated.length === 0) msg = "No Round-2 songs rated yet here — label a few (♥/~/✗), then ⚔ Battle.";
      else if (tierMax >= 2) msg = "You've already compared every same-rating pair in this batch — 🏆 Playoff re-ranks across all, or label more.";
      else msg = `Batch: ${cnt(rated)} — need 2 with the SAME rating. (🏆 Playoff ranks across all.)`;
      PWA.showToast(msg, 4600);
      console.log("[battle] done-watermark:", since ? new Date(since).toLocaleString() : "none", "| this batch:", cnt(rated), "| all rich-v1:", cnt(allRich));
      return;
    }
    for (let i = pairs.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [pairs[i], pairs[j]] = [pairs[j], pairs[i]]; }
    battleQueue = pairs.slice(0, 12).map(flipPair);
    battleStartedAt = Date.now(); battleIsLocal = true;       // batch consumed only when the battle is FINISHED (pairNext)
    Player.pause();
    PWA.showToast(`⚔ Batch battle: ${battleQueue.length} same-rating matchups`, 2600);
    pairNext(); openModal("pairwise-modal");
  }
  function pairOpen() {
    if (!(Player.backendName && Player.backendName() === "local" && Player.hasFolder && Player.hasFolder())) {
      PWA.showToast("Tap 🎚 Round 2 first to load the local audio", 2800); return;
    }
    Player.pause(); battleQueue = null; battleIsLocal = false;
    pairState = pairPick();
    if (!pairState) { PWA.showToast("Need ≥2 same-style tracks", 2000); return; }
    pairRender(); openModal("pairwise-modal");
  }
  function pairVerdict(v) {
    if (!pairState) return;
    Ratings.recordComparison({ aId: `yt:${pairState.a.youtube_id}`, bId: `yt:${pairState.b.youtube_id}`, verdict: Number(v), context: pairState.context, test: testMode });
    syncAll();
    PWA.showToast("Logged comparison", 900);
    pairNext();
  }
  // ---------------- global playoff (flexible tier-seeded ranking across ALL rated songs) ----------------
  let playoffTier = "ALL";
  const TIER_BASE = { LOVE: 1800, MID: 1500, SLOP: 1200 };   // Elo priors so the global order respects the labels
  function ratedTiers() {
    const byId = {}; (Player.getTracks ? Player.getTracks() : []).forEach((t) => { byId[t.youtube_id] = t; });
    const tiers = { LOVE: [], MID: [], SLOP: [] };
    Ratings.getAll().forEach((r) => { if (r.annotation_pass === "rich-v1" && tiers[r.rating_3class] && byId[r.youtube_id]) tiers[r.rating_3class].push(byId[r.youtube_id]); });
    return { tiers, byId };
  }
  function tierComps(idSet) {
    const strip = (x) => (x || "").replace("yt:", "");
    return (Ratings.getComparisons ? Ratings.getComparisons() : [])
      .map((c) => ({ a: strip(c.a_id), b: strip(c.b_id), verdict: c.verdict }))
      .filter((c) => idSet.has(c.a) && idSet.has(c.b));
  }
  function openPlayoff(tier) {
    if (!(Player.backendName && Player.backendName() === "local" && Player.hasFolder && Player.hasFolder())) { PWA.showToast("Tap 🎚 Round 2 first", 2600); return; }
    playoffTier = tier || playoffTier || "ALL";
    renderPlayoff();
    openModal("playoff-modal");
  }
  function globalRanking() {                                 // one tier-seeded Elo over ALL rated songs (incl. cross-tier comps)
    const { tiers, byId } = ratedTiers();
    const order = ["LOVE", "MID", "SLOP"];
    const all = [], tierOf = {}, bases = {};
    order.forEach((t) => (tiers[t] || []).forEach((x) => { all.push(x); tierOf[x.youtube_id] = t; bases[x.youtube_id] = TIER_BASE[t]; }));
    const ids = all.map((x) => x.youtube_id);
    const comps = tierComps(new Set(ids));
    const R = window.Ranking.elo(ids, comps, { bases });
    return { tiers, byId, order, all, tierOf, ids, comps, R };
  }
  function renderPlayoff() {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const g = globalRanking();
    const view = playoffTier === "ALL" ? g.all : g.all.filter((x) => g.tierOf[x.youtube_id] === playoffTier);
    const ranked = view.slice().sort((a, b) => (g.R[b.youtube_id] || 0) - (g.R[a.youtube_id] || 0));
    const lbl = { ALL: "All", LOVE: "♥ Love", MID: "~ Mid", SLOP: "✗ Slop" }[playoffTier] || playoffTier;
    $("playoff-title").textContent = `🏆 ${lbl} ranking`;
    $("playoff-sub").textContent = g.ids.length < 2 ? "Need ≥2 rated tracks to rank" : `${ranked.length} shown · ${g.comps.length} comparisons so far`;
    const chip = (t) => `<span class="po-tier po-${t}">${({ LOVE: "♥", MID: "~", SLOP: "✗" }[t]) || ""}</span>`;
    $("playoff-list").innerHTML = ranked.map((t, i) => `<li><span class="po-rank">${i + 1}</span>${playoffTier === "ALL" ? chip(g.tierOf[t.youtube_id]) : ""}<span class="po-name">${esc(t.artist || "")} — ${esc(t.title || "")}</span><span class="po-score">${Math.round(g.R[t.youtube_id] || 1500)}</span></li>`).join("");
    document.querySelectorAll(".playoff-tab").forEach((b) => b.setAttribute("aria-pressed", b.dataset.tier === playoffTier ? "true" : "false"));
  }
  function playoffPlayRound() {
    const g = globalRanking();
    if (g.ids.length < 2) { PWA.showToast("Need ≥2 rated songs to rank", 2400); return; }
    const compared = new Set(g.comps.map((c) => window.Ranking.pairKey(c.a, c.b)));
    const pools = g.order.map((t) => ({ tier: t, ids: (g.tiers[t] || []).map((x) => x.youtube_id) }));   // keep all 3 (even empty) so tier gaps are stable
    const round = window.Ranking.flexibleRound(pools, g.R, compared, { wildcard: 0.3, maxGap: 3, upset: 0.2 });
    if (!round.length) { PWA.showToast("Every nearby matchup has been played — ranking's settled, or label more.", 3200); return; }
    battleIsLocal = false;
    battleQueue = round.map((m) => ({ a: g.byId[m.a], b: g.byId[m.b], context: m.upset ? "upset" : m.cross ? "cross" : m.tier, battle: true, playoff: true })).slice(0, 12).map(flipPair);
    closeModal("playoff-modal");
    Player.pause();
    PWA.showToast(`🏆 Playoff round: ${battleQueue.length} matchups (mostly close, some wildcards)`, 2800);
    pairNext(); openModal("pairwise-modal");
  }
  if ($("btn-playoff")) $("btn-playoff").addEventListener("click", () => openPlayoff(playoffTier));
  if ($("close-playoff")) $("close-playoff").addEventListener("click", () => closeModal("playoff-modal"));
  if ($("playoff-round")) $("playoff-round").addEventListener("click", playoffPlayRound);
  document.querySelectorAll(".playoff-tab").forEach((b) => b.addEventListener("click", () => openPlayoff(b.dataset.tier)));

  // ---------------- insights / stats tracker ----------------
  function snapshotRanking() {                              // capture global Elo over time → movers (rising/dropping)
    try {
      const g = globalRanking(); if (g.ids.length < 2) return;
      const snaps = JSON.parse(localStorage.getItem("sorter.eloSnapshots") || "[]");
      const R = {}; g.ids.forEach((id) => { R[id] = Math.round(g.R[id]); });
      const last = snaps[snaps.length - 1];
      if (!last || JSON.stringify(last.R) !== JSON.stringify(R)) { snaps.push({ ts: Date.now(), R }); while (snaps.length > 40) snaps.shift(); localStorage.setItem("sorter.eloSnapshots", JSON.stringify(snaps)); }
    } catch (_) {}
  }
  function openInsights() {
    if (!(Player.backendName && Player.backendName() === "local" && Player.hasFolder && Player.hasFolder())) { PWA.showToast("Tap 🎚 Round 2 first", 2600); return; }
    if (!JSON.parse(localStorage.getItem("sorter.eloSnapshots") || "[]").length) snapshotRanking();   // baseline → movers after the 1st round
    renderInsights(); openModal("insights-modal");
  }
  function renderInsights() {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const g = globalRanking();
    const rated = Ratings.getAll().filter((r) => r.annotation_pass === "rich-v1" && ["LOVE", "MID", "SLOP"].includes(r.rating_3class) && g.byId[r.youtube_id]);
    const comps = g.comps;
    const nm = (id) => { const t = g.byId[id] || {}; return `${esc(t.artist || "?")} — ${esc(t.title || "?")}`; };
    const chip = (id) => `<span class="po-tier po-${g.tierOf[id]}">${({ LOVE: "♥", MID: "~", SLOP: "✗" }[g.tierOf[id]]) || ""}</span>`;
    const rec = {}; g.ids.forEach((id) => rec[id] = { w: 0, l: 0, t: 0 });
    comps.forEach((c) => { if (!(c.a in rec) || !(c.b in rec)) return; if (c.verdict < 0) { rec[c.a].w++; rec[c.b].l++; } else if (c.verdict > 0) { rec[c.b].w++; rec[c.a].l++; } else { rec[c.a].t++; rec[c.b].t++; } });
    const sorted = g.all.slice().sort((a, b) => (g.R[b.youtube_id] || 0) - (g.R[a.youtube_id] || 0));
    const rowR = (t, i) => { const id = t.youtube_id, r = rec[id]; return `<li><span class="po-rank">${i + 1}</span>${chip(id)}<span class="po-name">${nm(id)}</span><span class="ins-rec" title="Head-to-head record: wins-losses${r.t ? "-ties" : ""}">${r.w}-${r.l}${r.t ? "-" + r.t : ""}</span><span class="po-score" title="Ranking score (Elo). Higher = you pick it more often.">${Math.round(g.R[id])}</span></li>`; };
    const topRows = sorted.slice(0, 6).map(rowR).join("");
    const botRows = sorted.length > 9 ? `<li class="ins-sep">⋯</li>` + sorted.slice(-3).map((t, i) => rowR(t, sorted.length - 3 + i)).join("") : "";
    const snaps = JSON.parse(localStorage.getItem("sorter.eloSnapshots") || "[]");
    let moversHtml = "<p class='ins-dim'>Movers appear after you finish a round or two.</p>";
    if (snaps.length >= 2) {
      const cur = snaps[snaps.length - 1].R, prev = snaps[snaps.length - 2].R;
      const deltas = g.ids.filter((id) => id in cur && id in prev).map((id) => ({ id, d: cur[id] - prev[id] })).filter((x) => x.d !== 0).sort((a, b) => b.d - a.d);
      if (deltas.length) {
        const risers = deltas.filter((x) => x.d > 0).slice(0, 3), fallers = deltas.filter((x) => x.d < 0).slice(-3);
        moversHtml = `<ul class="ins-list">${risers.map((x) => `<li>▲ ${chip(x.id)}<span class="po-name">${nm(x.id)}</span><span class="po-score up">+${x.d}</span></li>`).join("")}${fallers.map((x) => `<li>▼ ${chip(x.id)}<span class="po-name">${nm(x.id)}</span><span class="po-score down">${x.d}</span></li>`).join("")}</ul>`;
      } else moversHtml = "<p class='ins-dim'>No movement since the last round.</p>";
    }
    const tc = { LOVE: 0, MID: 0, SLOP: 0 }; rated.forEach((r) => tc[r.rating_3class]++);
    const conf = rated.filter((r) => r.confidence).length, fam = rated.filter((r) => r.is_familiar).length;
    const marks = rated.filter((r) => (r.segments || []).length || (r.neutral_markers || []).length).length;
    let possible = 0; ["LOVE", "MID", "SLOP"].forEach((t) => { possible += tc[t] * (tc[t] - 1) / 2; });
    const comparedPairs = new Set(comps.map((c) => window.Ranking.pairKey(c.a, c.b))).size;
    const settled = possible ? Math.round(100 * Math.min(comparedPairs, possible) / possible) : 0;
    const nonTie = comps.filter((c) => c.verdict !== 0);
    let agree = 0; nonTie.forEach((c) => { const w = c.verdict < 0 ? c.a : c.b, l = c.verdict < 0 ? c.b : c.a; if ((g.R[w] || 0) > (g.R[l] || 0)) agree++; });
    const orderC = nonTie.length ? Math.round(100 * agree / nonTie.length) : null;
    $("insights-sub").textContent = `${rated.length} rated · ${comps.length} comparisons · ${snaps.length} snapshots`;
    $("insights-body").innerHTML = `
      <div class="ins-section"><h3 title="How far each song's ranking score moved since your last finished round (▲ up / ▼ down)">📈 Movers <span class="ins-dim">since last round</span></h3>${moversHtml}</div>
      <div class="ins-section"><h3 title="All your songs ordered by ranking score from your head-to-head verdicts — your first-pass quality order">🏅 Quality ranking</h3><ol class="ins-list ranked">${topRows}${botRows}</ol></div>
      <div class="ins-section"><h3 title="How complete and rich your labeling is so far">🧪 Labeling health</h3><ul class="ins-kv">
        <li title="Songs rated, split into LOVE · MID · SLOP">Rated <b>${rated.length}</b> — ♥${tc.LOVE} · ~${tc.MID} · ✗${tc.SLOP}</li>
        <li title="How often you set the confidence / familiarity channels — training uses these as weights">Confidence set <b>${conf}/${rated.length}</b> · familiarity <b>${fam}/${rated.length}</b></li>
        <li title="Songs with at least one segment or neutral marker placed on the waveform">Tracks with markers <b>${marks}/${rated.length}</b></li>
        <li title="Share of all possible same-tier matchups you've actually battled — 100% = fully ranked">Ranking settled <b>${settled}%</b> <span class="ins-dim">(${comparedPairs}/${possible} same-tier pairs compared)</span></li>
      </ul></div>
      <div class="ins-section"><h3 title="Whether your verdicts form one coherent order or contradict each other">🎯 Consistency</h3><ul class="ins-kv">
        <li title="Share of verdicts where the winner also ranks higher overall — high = consistent taste, low = cyclic/noisy">Verdicts agree with the fitted order: <b>${orderC == null ? "—" : orderC + "%"}</b> ${orderC == null ? "" : orderC >= 90 ? "✓ strong" : orderC >= 70 ? "ok" : "⚠ noisy/cyclic"}</li>
        <li title="Total head-to-head verdicts logged, and how many distinct songs they cover">${comps.length} comparisons across ${new Set(comps.flatMap((c) => [c.a, c.b])).size} songs</li>
      </ul></div>`;
  }
  if ($("btn-insights")) $("btn-insights").addEventListener("click", openInsights);
  if ($("close-insights")) $("close-insights").addEventListener("click", () => closeModal("insights-modal"));

  // ---------------- queue map (jump anywhere; see rated vs unheard) ----------------
  function openQueueMap() {
    if (!(Player.getTracks && Player.getTracks().length)) { PWA.showToast("Load a queue first (🎚 Round 2)", 2600); return; }
    renderQueueMap(); openModal("queuemap-modal");
  }
  function renderQueueMap() {
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    const tracks = Player.getTracks ? Player.getTracks() : [];
    const curId = ((Player.currentTrack && Player.currentTrack()) || {}).youtube_id;
    let ratedN = 0;
    $("queuemap-grid").innerHTML = tracks.map((t, i) => {
      const r = Ratings.getRating(t.youtube_id);
      const cls = r && r.rating_3class ? r.rating_3class : "unrated";
      if (r && r.rating_3class) ratedN++;
      const cur = t.youtube_id === curId ? " cur" : "";
      const dot = { LOVE: "♥", MID: "~", SLOP: "✗", unrated: "·" }[cls];
      const name = `${t.artist ? esc(t.artist) + " — " : ""}${esc(t.title || t.video_title || t.youtube_id || "?")}`;
      const tip = cls === "unrated" ? "unheard" : `${r.rating_3class}${r.rating_5point ? " (" + r.rating_5point + ")" : ""}`;
      return `<button type="button" class="qm-row qm-${cls}${cur}" data-idx="${i}" title="${tip}"><span class="qm-i">${i + 1}</span><span class="qm-dot">${dot}</span><span class="qm-name">${name}</span></button>`;
    }).join("");
    $("queuemap-sub").textContent = `${ratedN}/${tracks.length} rated · tap a row to jump there`;
    const curEl = document.querySelector("#queuemap-grid .qm-cell.cur"); if (curEl) curEl.scrollIntoView({ block: "center" });
  }
  if ($("btn-queuemap")) $("btn-queuemap").addEventListener("click", openQueueMap);
  if ($("close-queuemap")) $("close-queuemap").addEventListener("click", () => closeModal("queuemap-modal"));
  if ($("queuemap-grid")) $("queuemap-grid").addEventListener("click", (e) => {
    const row = e.target.closest(".qm-row"); if (!row) return;
    closeModal("queuemap-modal");
    if (Player.playAt) Player.playAt(Number(row.dataset.idx));
  });

  if ($("menu-pairwise")) $("menu-pairwise").addEventListener("click", () => { closeModal("menu-modal"); pairOpen(); });
  if ($("btn-battle")) $("btn-battle").addEventListener("click", startBattle);
  if ($("close-pairwise")) $("close-pairwise").addEventListener("click", () => { pairStopAudio(); closeModal("pairwise-modal"); });
  if ($("pair-skip")) $("pair-skip").addEventListener("click", pairNext);
  document.querySelectorAll(".verdict-btn").forEach((b) => b.addEventListener("click", () => pairVerdict(b.dataset.verdict)));

  // Test mode toggle: flag actions as test so the real pass stays clean.
  if ($("btn-testmode")) $("btn-testmode").addEventListener("click", () => {
    testMode = !testMode;
    $("btn-testmode").textContent = `🧪 Test: ${testMode ? "ON" : "off"}`;
    $("btn-testmode").setAttribute("aria-pressed", String(testMode));
    document.body.classList.toggle("testing", testMode);
    const banner = $("test-banner"); if (banner) banner.classList.toggle("hidden", !testMode);
    PWA.showToast(testMode ? "🧪 Test mode ON — actions flagged as test" : "Test mode off — real data", 1800);
  });

  // Submit & Analyze: write the current labels to round2_trial.json (File System Access) for Claude to review.
  function trialDB() { return new Promise((res, rej) => { const r = indexedDB.open("sorter-trial", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  async function trialGet(k) { const d = await trialDB(); return new Promise((res) => { const t = d.transaction("kv").objectStore("kv").get(k); t.onsuccess = () => res(t.result); t.onerror = () => res(null); }); }
  async function trialPut(k, v) { const d = await trialDB(); d.transaction("kv", "readwrite").objectStore("kv").put(v, k); }
  async function submitForAnalysis() {
    if (!window.showSaveFilePicker) { PWA.showToast("Submit needs Chrome/Edge (File System Access)", 2800); return; }
    try {
      const payload = Exporter.buildPayload();
      let h = await trialGet("file");
      if (h && (await h.queryPermission({ mode: "readwrite" })) !== "granted") { if ((await h.requestPermission({ mode: "readwrite" })) !== "granted") h = null; }
      if (!h) { h = await window.showSaveFilePicker({ suggestedName: "round2_trial.json", types: [{ description: "JSON", accept: { "application/json": [".json"] } }] }); await trialPut("file", h); }
      const w = await h.createWritable(); await w.write(JSON.stringify(payload, null, 2)); await w.close();
      const n = (payload.tracks || []).filter((t) => t.annotation_pass).length;
      PWA.showToast(`Submitted ${n} labels + ${(payload.comparisons || []).length} comparisons → round2_trial.json. Now tell Claude: "analyze".`, 5000);
    } catch (e) { console.warn("submit failed", e); PWA.showToast("Submit cancelled / failed", 2500); }
  }
  if ($("btn-submit-analyze")) $("btn-submit-analyze").addEventListener("click", submitForAnalysis);

  // ----------------- header / menu / modals -----------------

  $("stats-toggle").addEventListener("click", () => {
    Stats.renderDetail($("stats-detail"));
    openModal("stats-modal");
  });
  $("open-queue").addEventListener("click", () => openModal("queue-modal"));
  $("open-menu").addEventListener("click",  () => openModal("menu-modal"));
  $("close-queue").addEventListener("click", () => closeModal("queue-modal"));
  $("close-stats").addEventListener("click", () => closeModal("stats-modal"));
  $("close-menu").addEventListener("click",  () => closeModal("menu-modal"));
  $("close-hint").addEventListener("click",  () => closeModal("hint-modal"));
  $("close-recent").addEventListener("click",() => closeModal("recent-modal"));

  $("menu-stats").addEventListener("click", () => {
    closeModal("menu-modal");
    Stats.renderDetail($("stats-detail"));
    openModal("stats-modal");
  });
  $("menu-sync").addEventListener("click", async () => {
    closeModal("menu-modal");
    if (Sync.isEnabled()) {
      const disable = confirm(
        "Live sync is currently ON.\n\nOK = disable sync.\nCancel = re-pick file."
      );
      if (disable) await Sync.disable();
      else        await Sync.pick();
    } else {
      await Sync.pick();
    }
    refreshSyncMenuLabel();
  });
  $("menu-queue").addEventListener("click", () => { closeModal("menu-modal"); openModal("queue-modal"); });
  $("menu-install").addEventListener("click", () => { closeModal("menu-modal"); PWA.promptInstall(); });
  $("menu-keyhint").addEventListener("click", () => { closeModal("menu-modal"); openModal("hint-modal"); });
  $("menu-recent").addEventListener("click", () => {
    closeModal("menu-modal");
    renderRecent();
    openModal("recent-modal");
  });
  $("menu-kappa").addEventListener("click", () => {
    closeModal("menu-modal");
    const existing = Ratings.getKappaTest();
    if (existing && existing.responses.length && existing.responses.length < existing.plan.length) {
      if (confirm(`Resume the κ-test in progress (${existing.responses.length}/${existing.plan.length})?\n\nCancel = start a fresh one.`)) {
        kappaMode = true;
        prevActivePlaylistId = active?.playlistId || null;
        resumeChecked = true;
        const remaining = existing.plan.map((p) => p.youtube_id)
          .filter((id) => !existing.responses.some((r) => r.youtube_id === id));
        Player.onReady(() => Player.loadVideoIds(remaining));
        updateKappaBanner();
        showOverlayIfMobile();
        return;
      }
    }
    startKappa();
  });
  $("kappa-end").addEventListener("click", finishKappa);
  $("kappa-restart").addEventListener("click", () => { closeModal("kappa-modal"); Ratings.clearKappaTest(); startKappa(); });
  $("close-kappa").addEventListener("click", () => closeModal("kappa-modal"));
  $("menu-clear-session").addEventListener("click", () => {
    if (confirm("Clear ratings from the CURRENT session only?")) {
      Ratings.clearSession(); Stats.refreshCompact(); updateRatedCountNote();
    }
    closeModal("menu-modal");
  });
  $("menu-clear-all").addEventListener("click", () => {
    if (confirm("Clear ALL ratings? This cannot be undone (export first!)")) {
      Ratings.clearAll(); Stats.refreshCompact(); updateRatedCountNote();
    }
    closeModal("menu-modal");
  });

  $("export-download").addEventListener("click", () => { Exporter.download(); PWA.showToast("Downloaded"); });
  $("export-clipboard").addEventListener("click", async () => {
    PWA.showToast((await Exporter.clipboard()) ? "Copied to clipboard" : "Clipboard not available", 1800);
  });
  $("export-share").addEventListener("click", async () => {
    try { (await Exporter.share()) ? PWA.showToast("Shared", 1500) : PWA.showToast("Share not available", 2000); }
    catch (e) { PWA.showToast("Share cancelled", 1500); }
  });

  async function refreshSyncMenuLabel() {
    const el = $("menu-sync-state");
    if (!el) return;
    if (Sync.isEnabled()) {
      const name = await Sync.getFileName();
      el.textContent = name ? `— on (${name})` : "— on";
    } else {
      el.textContent = "— off";
    }
  }
  $("open-menu").addEventListener("click", refreshSyncMenuLabel);

  // ----------------- settings + nudge -----------------

  function syncAll() {
    try { Sync.flush(); } catch (_) {}
    try { GithubSync.flush(); } catch (_) {}
  }

  function applySettings() {
    settings = Ratings.getSettings();
    Player.setStartOffset(settings.startOffsetSeconds);
    document.querySelectorAll(".nudge-n").forEach((el) => { el.textContent = settings.nudgeSeconds; });
  }

  $("nudge-back").addEventListener("click", () => Player.seekBy(-settings.nudgeSeconds));
  $("nudge-fwd").addEventListener("click", () => Player.seekBy(settings.nudgeSeconds));

  $("menu-settings").addEventListener("click", () => {
    closeModal("menu-modal");
    $("set-nudge").value = settings.nudgeSeconds;
    $("set-start").value = settings.startOffsetSeconds;
    $("set-doubletap").value = settings.doubleTapMs;
    const gh = GithubSync.getConfig();
    $("set-gh-enabled").checked = gh.enabled;
    $("set-gh-repo").value = `${gh.owner}/${gh.repo}`;
    $("set-gh-token").value = gh.token;
    $("set-yt-key").value = YTMeta.getKey();
    renderGhStatus();
    openModal("settings-modal");
  });
  $("save-settings").addEventListener("click", () => {
    Ratings.saveSettings({
      nudgeSeconds: Math.max(1, Number($("set-nudge").value) || 3),
      startOffsetSeconds: Math.max(0, Number($("set-start").value) || 0),
      doubleTapMs: Math.min(1500, Math.max(200, Number($("set-doubletap").value) || 500)),
    });
    const [owner, repo] = ($("set-gh-repo").value || "").split("/").map((s) => s.trim());
    GithubSync.setConfig({
      enabled: $("set-gh-enabled").checked,
      owner: owner || "major-scale",
      repo: repo || "music-sorter-data",
      token: $("set-gh-token").value.trim(),
    });
    YTMeta.setKey($("set-yt-key").value);
    applySettings();
    closeModal("settings-modal");
    PWA.showToast("Settings saved", 1200);
    // If cloud backup was just enabled, immediately pull + merge the full history
    // (incl. the seed) so the user doesn't have to reload.
    if (GithubSync.isEnabled()) {
      GithubSync.pullMerge()
        .then((n) => { Stats.refreshCompact(); updateRatedCountNote(); updateQueueProgress(); PWA.showToast(`Synced ${n} ratings from cloud`, 2800); recheckCurrentForSkip(); })
        .catch((err) => PWA.showToast("Cloud pull failed: " + err.message, 3500));
    }
  });
  $("close-settings").addEventListener("click", () => closeModal("settings-modal"));

  $("yt-test").addEventListener("click", async () => {
    YTMeta.setKey($("set-yt-key").value);
    try { await YTMeta.test(); $("yt-status").textContent = "✓ Key works."; PWA.showToast("✓ YouTube API key works", 2200); }
    catch (e) { $("yt-status").textContent = "✗ " + e.message; PWA.showToast("✗ " + e.message, 4500); }
  });

  $("yt-enrich-all").addEventListener("click", async () => {
    YTMeta.setKey($("set-yt-key").value);
    if (!YTMeta.isEnabled()) { PWA.showToast("Enter an API key first", 2500); return; }
    const ids = Ratings.unenrichedIds();
    if (!ids.length) { $("yt-status").textContent = "Everything already enriched."; return; }
    $("yt-status").textContent = `Backfilling ${ids.length} tracks…`;
    try {
      const map = await YTMeta.lookupBatch(ids);
      let n = 0;
      for (const [id, meta] of map) if (Ratings.enrich(id, meta)) n++;
      Stats.refreshCompact();
      syncAll();
      $("yt-status").textContent = `Enriched ${n} of ${ids.length} tracks.`;
      PWA.showToast(`Enriched ${n} tracks`, 2800);
    } catch (e) {
      $("yt-status").textContent = "✗ " + e.message;
      PWA.showToast("Backfill failed: " + e.message, 4500);
    }
  });

  $("import-file").addEventListener("change", async (e) => {
    const files = Array.from(e.target.files || []);
    let added = 0, updated = 0, failed = 0;
    for (const f of files) {
      try {
        const payload = JSON.parse(await f.text());
        const r = Ratings.importPayload(payload);
        added += r.added; updated += r.updated;
      } catch (err) { failed++; }
    }
    Stats.refreshCompact();
    updateRatedCountNote();
    syncAll();
    const msg = `Imported: +${added} new, ${updated} updated${failed ? `, ${failed} failed` : ""}. Total now ${Ratings.counts().total}.`;
    $("import-status").textContent = msg;
    PWA.showToast(msg, 3500);
    e.target.value = "";
  });

  function renderGhStatus() {
    const c = GithubSync.getConfig();
    const el = $("gh-status");
    const bits = [];
    bits.push(`device id: ${GithubSync.getDeviceId()}`);
    if (c.lastSync) bits.push(`last backup: ${new Date(c.lastSync).toLocaleString()}`);
    if (c.lastError) bits.push(`last error: ${c.lastError}`);
    bits.push("token stored only on this device");
    el.textContent = bits.join(" · ");
  }

  $("gh-test").addEventListener("click", async () => {
    // persist current field values first so test uses them
    const [owner, repo] = ($("set-gh-repo").value || "").split("/").map((s) => s.trim());
    GithubSync.setConfig({ owner: owner || "major-scale", repo: repo || "music-sorter-data", token: $("set-gh-token").value.trim() });
    try {
      await GithubSync.test();
      PWA.showToast("✓ Connected — repo is reachable", 2200);
    } catch (e) {
      PWA.showToast("✗ " + e.message, 4000);
    }
    renderGhStatus();
  });
  $("gh-pushnow").addEventListener("click", async () => {
    const [owner, repo] = ($("set-gh-repo").value || "").split("/").map((s) => s.trim());
    GithubSync.setConfig({
      enabled: $("set-gh-enabled").checked,
      owner: owner || "major-scale", repo: repo || "music-sorter-data",
      token: $("set-gh-token").value.trim(),
    });
    try {
      await GithubSync.pushNow();
      PWA.showToast("✓ Backed up to GitHub", 2200);
    } catch (e) {
      PWA.showToast("✗ Backup failed: " + e.message, 4000);
    }
    renderGhStatus();
  });

  // ----------------- batches / history -----------------

  $("menu-batches").addEventListener("click", () => {
    closeModal("menu-modal");
    renderBatches();
    openModal("batches-modal");
  });
  $("close-batches").addEventListener("click", () => closeModal("batches-modal"));

  function renderBatches() {
    const list = $("batches-list");
    list.innerHTML = "";
    const summaries = Ratings.batchSummaries();
    const activeId = Ratings.getActiveBatch()?.batch_id;
    if (!summaries.length) {
      list.innerHTML = "<li class='modal-note'>No batches yet — load a playlist to start one.</li>";
      return;
    }
    for (const b of summaries) {
      const li = document.createElement("li");
      li.className = "batch-row" + (b.batch_id === activeId ? " active" : "");
      const dateRange = `${(b.first || "").slice(0, 10)}${b.first !== b.last ? "→" + (b.last || "").slice(0, 10) : ""}`;
      li.innerHTML = `
        <div class="batch-name"></div>
        <div class="batch-actions">
          <button type="button" class="ghost-btn small" data-rename="${b.batch_id}">Rename</button>
          <button type="button" class="ghost-btn small" data-export="${b.batch_id}">Export</button>
        </div>
        <div class="batch-meta">
          ${b.count} rated · <span class="love">${b.LOVE || 0} love</span> ·
          ${b.MID || 0} mid · <span class="slop">${b.SLOP || 0} slop</span> · ${dateRange}
          ${b.batch_id === activeId ? " · <strong>active</strong>" : ""}
        </div>`;
      li.querySelector(".batch-name").textContent = b.name;
      list.appendChild(li);
    }
  }

  $("batches-list").addEventListener("click", (e) => {
    const renameId = e.target.dataset.rename;
    const exportId = e.target.dataset.export;
    if (renameId) {
      const cur = Ratings.batchSummaries().find((x) => x.batch_id === renameId);
      const name = prompt("Rename batch:", cur ? cur.name : "");
      if (name) { Ratings.renameBatch(renameId, name); renderBatches(); Sync.flush(); }
    } else if (exportId) {
      Exporter.downloadBatch(exportId);
      PWA.showToast("Exported batch JSON", 1500);
    }
  });

  function renderRecent() {
    const list = $("recent-list");
    list.innerHTML = "";
    const recent = Ratings.getAll().sort((a, b) => (a.rated_at < b.rated_at ? 1 : -1)).slice(0, 20);
    if (!recent.length) { list.innerHTML = "<li>No ratings yet.</li>"; return; }
    for (const r of recent) {
      const li = document.createElement("li");
      li.className = r.rating_3class;
      const label = document.createElement("span");
      const extra = [r.yt_release_date || (r.year || ""), r.yt_label].filter(Boolean).join(" · ");
      label.textContent = `${r.rating_3class} — ${r.artist || "?"} — ${r.title || r.video_title || "?"}${extra ? "  ·  " + extra : ""}`;
      const edit = document.createElement("span");
      edit.className = "recent-edit";
      edit.innerHTML =
        `<button class="s" data-rerate="SLOP" data-yt="${r.youtube_id}">S</button>` +
        `<button class="m" data-rerate="MID" data-yt="${r.youtube_id}">M</button>` +
        `<button class="l" data-rerate="LOVE" data-yt="${r.youtube_id}">L</button>`;
      li.appendChild(label);
      li.appendChild(edit);
      list.appendChild(li);
    }
  }

  $("recent-list").addEventListener("click", (e) => {
    const label = e.target.dataset.rerate;
    const yt = e.target.dataset.yt;
    if (!label || !yt) return;
    Ratings.reRate(yt, label);
    Stats.refreshCompact();
    syncAll();
    renderRecent();
    if (trackInfo && trackInfo.videoId === yt) showExistingRating(yt);
    PWA.showToast(`Re-rated ${label}`, 1200);
  });

  function openModal(id) {
    const dlg = $(id);
    if (!dlg) return;
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
  }
  function closeModal(id) {
    const dlg = $(id);
    if (!dlg) return;
    if (typeof dlg.close === "function" && dlg.open) dlg.close(); else dlg.removeAttribute("open");
  }

  // ----------------- keyboard -----------------

  function handleDoubleTapKey(label, keyName) {
    if (pendingKey === label) {
      clearTimeout(pendingKeyTimer);
      pendingKey = null;
      recordRating(label);
    } else {
      pendingKey = label;
      PWA.showToast(`Press ${keyName} again to confirm ${label}`, settings.doubleTapMs);
      clearTimeout(pendingKeyTimer);
      pendingKeyTimer = setTimeout(() => { pendingKey = null; }, settings.doubleTapMs);
    }
  }

  window.addEventListener("keydown", (e) => {
    // Ignore when typing in inputs
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (document.querySelector(".modal[open]")) return;
    switch (e.key) {
      // single-press number keys (fast power-user)
      case "1": recordRating("SLOP"); break;
      case "2": recordRating("MID"); break;
      case "3": recordRating("LOVE"); break;
      // double-tap letter keys (intentional)
      case "s": case "S": handleDoubleTapKey("SLOP", "S"); break;
      case "m": case "M": handleDoubleTapKey("MID", "M"); break;
      case "l": case "L": handleDoubleTapKey("LOVE", "L"); break;
      case " ": e.preventDefault(); toggleStop(); break;
      case "ArrowLeft":  e.preventDefault(); Player.seekBy(-settings.nudgeSeconds); break;
      case "ArrowRight": e.preventDefault(); Player.seekBy(settings.nudgeSeconds); break;
      case "n": case "N": Player.next(); break;
      case "p": case "P": goPrev(); break;
      case "u": case "U": undoLastRating(); break;
    }
  });

  // ----------------- swipe (mobile) -----------------
  // Swipe within the player area: left=SLOP, right=LOVE, up=MID

  let touchStart = null;
  $("player-area").addEventListener("touchstart", (e) => {
    if (e.target.closest(".meta-input, .notes-input, .modal")) return;
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchStart = { x: t.clientX, y: t.clientY, time: Date.now() };
  }, { passive: true });

  $("player-area").addEventListener("touchend", (e) => {
    if (!touchStart) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touchStart.x;
    const dy = t.clientY - touchStart.y;
    const dt = Date.now() - touchStart.time;
    touchStart = null;
    if (dt > 600) return;
    const absX = Math.abs(dx), absY = Math.abs(dy);
    if (Math.max(absX, absY) < 70) return;
    if (absX > absY) {
      if (dx < 0) recordRating("SLOP"); else recordRating("LOVE");
    } else {
      if (dy < 0) recordRating("MID");
    }
  }, { passive: true });

  // ----------------- overlay (tap-to-start) -----------------

  function showOverlayIfMobile() {
    if (matchMedia("(pointer: coarse)").matches) {
      overlay.classList.remove("hidden");
    }
  }
  overlay.addEventListener("click", () => {
    Player.play();
    overlay.classList.add("hidden");
  });
})();
