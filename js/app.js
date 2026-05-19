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

  // ----------------- bootstrap -----------------

  PWA.register();
  PWA.captureInstallPrompt();
  Stats.refreshCompact();
  renderPresets();
  updateRatedCountNote();

  // Resume live-sync silently if a handle was previously stored
  Sync.tryRestore().then((on) => {
    refreshSyncMenuLabel();
    if (on) PWA.showToast("Live sync resumed", 1200);
  });

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

    // Already-rated handling: skip if user opted in and not a consistency check
    if (active && active.skipRated) {
      const rated = Ratings.getRating(info.videoId);
      const isConsistencyTarget = pendingConsistency && pendingConsistency.youtube_id === info.videoId;
      if (rated && !isConsistencyTarget) {
        PWA.showToast(`Already rated as ${rated.rating_3class} — skipping`, 1500);
        setTimeout(() => Player.next(), 500);
        return;
      }
    }

    // Apply consistency target if this is the inserted re-rate
    if (pendingConsistency && pendingConsistency.youtube_id === info.videoId) {
      Ratings.setConsistencyTarget(pendingConsistency);
      PWA.showToast("Consistency check — rate it fresh", 2200);
      pendingConsistency = null;
    }
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
    Sync.flush();
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

  $("btn-skip").addEventListener("click", () => Player.next());
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

  function renderRecent() {
    const list = $("recent-list");
    list.innerHTML = "";
    const recent = Ratings.getAll().sort((a, b) => (a.rated_at < b.rated_at ? 1 : -1)).slice(0, 20);
    if (!recent.length) { list.innerHTML = "<li>No ratings yet.</li>"; return; }
    for (const r of recent) {
      const li = document.createElement("li");
      li.className = r.rating_3class;
      li.textContent = `${r.rating_3class} — ${r.artist || "?"} — ${r.title || r.video_title || "?"}`;
      list.appendChild(li);
    }
  }

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

  window.addEventListener("keydown", (e) => {
    // Ignore when typing in inputs
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (document.querySelector(".modal[open]")) return;
    switch (e.key) {
      case "1": recordRating("SLOP"); break;
      case "2": recordRating("MID"); break;
      case "3": recordRating("LOVE"); break;
      case " ": e.preventDefault(); Player.togglePlay(); break;
      case "ArrowRight":
      case "n":
      case "N": Player.next(); break;
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
