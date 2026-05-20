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
  let trackInfo = null;
  let advancePending = false;
  let pendingConsistency = null;
  let settings = Ratings.getSettings();

  // double-tap rating state
  let pendingKey = null;
  let pendingKeyTimer = null;

  // navigation / undo state
  let suppressAutoSkipOnce = false;
  let undoState = null;        // { youtubeId, prevRecord|null }
  let resumeChecked = false;   // jump-to-first-unrated only once per load

  // ----------------- bootstrap -----------------

  PWA.register();
  PWA.captureInstallPrompt();
  Stats.refreshCompact();
  renderPresets();
  updateRatedCountNote();
  applySettings();

  // Resume live-sync silently if a handle was previously stored
  Sync.tryRestore().then((on) => {
    refreshSyncMenuLabel();
    if (on) PWA.showToast("Live sync resumed", 1200);
  });

  // Pull + merge cloud history on load so this instance converges to the full
  // cross-device, cross-origin history (only if a token is configured here).
  if (GithubSync.isEnabled()) {
    GithubSync.pullMerge()
      .then((n) => { if (n) { Stats.refreshCompact(); updateRatedCountNote(); PWA.showToast(`Synced ${n} ratings from cloud`, 2500); } })
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
    maybeResume();

    const skipSuppressed = suppressAutoSkipOnce;
    suppressAutoSkipOnce = false;

    // Already-rated handling (cross-batch): skip if user opted in, not a consistency
    // check, and not currently navigating backward to review/re-rate. Jumps over a
    // whole run of already-rated tracks in one hop rather than stepping through them.
    if (active && active.skipRated && !skipSuppressed) {
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
    if (!active || !active.skipRated) return;
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
    const parsed = Ratings.parseTitle(info.videoTitle);
    metaArtist.value = parsed.artist;
    metaTitle.value  = parsed.title;
    metaVideoTitle.textContent = info.videoTitle || "(unknown)";
    notesInput.value = "";
    selected5pt = null;
    document.querySelectorAll(".fp-btn").forEach((b) => b.classList.remove("selected"));
  }

  // ----------------- rating -----------------

  function recordRating(label) {
    if (!trackInfo) { PWA.showToast("No track loaded yet"); return; }
    if (advancePending) return;
    advancePending = true;

    const btn = label === "LOVE" ? loveBtn : (label === "MID" ? midBtn : slopBtn);
    btn.classList.add("flash");
    haptic();

    // capture state for undo (before overwrite)
    undoState = { youtubeId: trackInfo.videoId, prevRecord: Ratings.getRating(trackInfo.videoId) };

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
      notes: notesInput.value || "",
      subgenreTags: [],
    });
    Stats.refreshCompact();
    syncAll();
    PWA.showToast(`Rated ${label}${record.is_consistency_check ? " (consistency check)" : ""}`, 1200);

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
  $("btn-next").addEventListener("click", () => { suppressAutoSkipOnce = true; Player.next(); });
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
  document.querySelectorAll(".fp-btn").forEach((b) => {
    b.addEventListener("click", () => {
      document.querySelectorAll(".fp-btn").forEach((x) => x.classList.remove("selected"));
      b.classList.add("selected");
      selected5pt = Number(b.dataset.fp);
    });
  });

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
    applySettings();
    closeModal("settings-modal");
    PWA.showToast("Settings saved", 1200);
  });
  $("close-settings").addEventListener("click", () => closeModal("settings-modal"));

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
      label.textContent = `${r.rating_3class} — ${r.artist || "?"} — ${r.title || r.video_title || "?"}`;
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
      case " ": e.preventDefault(); Player.togglePlay(); break;
      case "ArrowLeft":  e.preventDefault(); Player.seekBy(-settings.nudgeSeconds); break;
      case "ArrowRight": e.preventDefault(); Player.seekBy(settings.nudgeSeconds); break;
      case "n": case "N": suppressAutoSkipOnce = true; Player.next(); break;
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
