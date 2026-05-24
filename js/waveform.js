// Waveform + region-marker GUI for Round 2, built on WaveSurfer v6 (vendored).
// Bound to LocalBackend's existing <audio> element (backend: MediaElement) so PLAYBACK
// is unchanged — WaveSurfer only draws the waveform + manages regions on top.
//
// Markers: drag on the waveform = a RANGE with the active label; tapping a label button
// drops a ±2.5s POINT at the playhead and sets the active label; double-click a region to
// delete; ⚓ neutral drops a fixed anchor. window.Segments delegates here.

window.Waveform = (() => {
  let ws = null, regions = null, activeLabel = "love", anchorSec = null, wsReady = false, pendingRestore = null;
  const SOLID = { love: "#3ad29f", mid: "#d8b13a", slop: "#d9534f", neutral: "#ffffff" };
  const ICON = { love: "♥", mid: "~", slop: "✗", neutral: "⚓" };
  const colorFor = (l) => (SOLID[l] || "#8a8a8a") + "59";          // ~35% alpha fill
  const audioEl = () => document.getElementById("local-audio");

  function styleRegion(r, label) {                                 // make regions clearly color-coded + tagged
    if (!r || !r.element) return;
    const c = SOLID[label] || "#8a8a8a";
    r.element.style.background = c + "40";
    r.element.style.borderLeft = "2px solid " + c;
    r.element.style.borderRight = "2px solid " + c;
    r.element.setAttribute("data-seg", label);
    let tag = r.element.querySelector(".seg-tag");
    if (!tag) { tag = document.createElement("span"); tag.className = "seg-tag"; r.element.appendChild(tag); }
    tag.textContent = ICON[label] || label;
    r.element.style.cursor = "pointer";
    r.element.onclick = (e) => showRegionMenu(r, e);              // click a marker → local menu (topmost/innermost wins via z-index)
  }

  // ---- per-marker popover: edit/nest without the drag-moves-it problem ----
  let menuEl = null;
  function closeMenu() { if (menuEl) menuEl.style.display = "none"; }
  function showRegionMenu(r, ev) {
    if (ev) { ev.preventDefault(); ev.stopPropagation(); }
    if (!menuEl) {
      menuEl = document.createElement("div"); menuEl.className = "region-menu"; document.body.appendChild(menuEl);
      document.addEventListener("click", (e) => { if (menuEl && menuEl.style.display === "block" && !menuEl.contains(e.target)) closeMenu(); }, true);
    }
    const lab = (r.data && r.data.label) || "?";
    const span = fmt(r.start) + ((r.end - r.start) > 1 ? "–" + fmt(r.end) : "");
    menuEl.innerHTML = '<div class="rm-title">' + (ICON[lab] || "") + " " + lab + " " + span + '</div>' +
      '<button data-act="inner">⊕ add inner marker</button>' +
      '<button data-act="start">⟕ set start = ▶ playhead</button>' +
      '<button data-act="end">⟖ set end = ▶ playhead</button>' +
      '<button data-act="del">✕ delete</button>';
    menuEl.querySelectorAll("button").forEach((b) => { b.onclick = (e) => { e.stopPropagation(); regionAct(r, b.dataset.act); closeMenu(); }; });
    const x = Math.max(8, Math.min((ev && ev.clientX) || 40, window.innerWidth - 220));
    const y = Math.max(8, Math.min((ev && ev.clientY) || 40, window.innerHeight - 200));
    menuEl.style.left = x + "px"; menuEl.style.top = y + "px"; menuEl.style.display = "block";
  }
  function regionAct(r, act) {
    if (!r) return;
    if (act === "del") { r.remove(); return; }
    if (act === "inner") {
      const t = Math.max(r.start, Math.min(curT(), r.end - 0.5));
      const nr = ws.addRegion({ start: t, end: Math.min(r.end, t + 2), color: colorFor(activeLabel), drag: false, resize: false, data: { label: activeLabel } });
      styleRegion(nr, activeLabel); updateMarkers(); return;
    }
    if (act === "start") { const t = Math.max(0, Math.min(curT(), r.end - 0.1)); try { r.update({ start: t }); } catch (_) { r.start = t; r.updateRender && r.updateRender(); } }
    if (act === "end") { const t = Math.max(r.start + 0.1, curT()); try { r.update({ end: t }); } catch (_) { r.end = t; r.updateRender && r.updateRender(); } }
    updateMarkers();
  }

  const NESTABLE = (r) => r && r.data && r.data.label && r.data.label !== "neutral";
  function enclosingOf(r, all) {            // innermost OTHER content region strictly containing r = its nesting parent
    let best = null;
    for (const o of all) {
      if (o === r || !NESTABLE(o)) continue;
      if (o.start <= r.start + 1e-6 && o.end >= r.end - 1e-6 && (o.end - o.start) > (r.end - r.start) + 1e-6) {
        if (!best || (o.end - o.start) < (best.end - best.start)) best = o;
      }
    }
    return best;
  }
  function restyleAll() {                   // re-apply colors + flag nested (inner) regions so they render "inside" the parent
    if (!ws || !ws.regions || !ws.regions.list) return;
    const all = Object.values(ws.regions.list);
    all.forEach((r) => { if (!r.data || !r.data.label) return; styleRegion(r, r.data.label); if (r.element) r.element.classList.toggle("nested-region", NESTABLE(r) && !!enclosingOf(r, all)); });
  }
  function updateMarkers() { renderList(); restyleAll(); }

  const fmt = (s) => { s = Math.max(0, Math.round(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); };
  function renderList() {                                 // marker list under the waveform (delete here, not by dblclick)
    const el = document.getElementById("marker-list");
    if (!el) return;
    if (!ws || !ws.regions || !ws.regions.list) { el.innerHTML = ""; return; }
    const all = Object.values(ws.regions.list);
    const regs = all.slice().sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    if (!regs.length) { el.innerHTML = '<span class="ml-empty">no markers yet — pick a type, drag on the waveform to mark a range. Drag <em>inside</em> a marker to nest one; click a marker to edit/delete.</span>'; return; }
    el.innerHTML = regs.map((r) => {
      const lab = (r.data && r.data.label) || "?";
      const span = (r.end - r.start) > 1 ? (fmt(r.start) + "–" + fmt(r.end)) : fmt(r.start);
      const nested = NESTABLE(r) && !!enclosingOf(r, all);
      return '<span class="ml-chip ml-' + lab + (nested ? ' ml-nested' : '') + '" data-rid="' + r.id + '">' + (nested ? "↳ " : "") + (ICON[lab] || "") + " " + lab + " " + span +
        '<button class="ml-x" data-rid="' + r.id + '" title="delete marker">✕</button></span>';
    }).join("");
  }

  function init() {
    if (ws || !window.WaveSurfer) return;
    const container = document.getElementById("waveform");
    const a = audioEl();
    if (!container || !a) return;
    try {
      regions = WaveSurfer.regions.create({ dragSelection: { slop: 5, drag: false, resize: false } });   // created regions are NOT movable → click = menu, drag INSIDE one = a nested marker
      const plugins = [regions];
      const mapEl = document.getElementById("waveform-map");
      if (mapEl && WaveSurfer.minimap) {
        plugins.push(WaveSurfer.minimap.create({           // whole-track "map", synced + click/drag-to-jump
          container: mapEl, height: 48, waveColor: "#3a3a44", progressColor: "#6ab7ff",
          showOverview: true, overviewBorderColor: "#6ab7ff", overviewBorderSize: 2,
        }));
      }
      ws = WaveSurfer.create({
        container, backend: "WebAudio", height: 320,
        waveColor: "#4a4a55", progressColor: "#6ab7ff", cursorColor: "#ffffff",
        normalize: true, responsive: true, scrollParent: true, hideScrollbar: false,
        plugins,
      });
      // a drag-created region inherits the active label + color
      ws.on("region-created", (r) => {
        if (!r.data || !r.data.label) r.data = { label: activeLabel };
        styleRegion(r, r.data.label);
        setTimeout(updateMarkers, 0);              // region isn't in regions.list yet during this event — defer
      });
      ws.on("region-updated", renderList);
      ws.on("region-update-end", updateMarkers);   // nesting may have changed after a drag/resize
      ws.on("region-removed", updateMarkers);
      ws.on("ready", () => { wsReady = true; setZoom(100); if (pendingRestore) { const pr = pendingRestore; pendingRestore = null; applyRestore(pr); } });
      const ml = document.getElementById("marker-list");          // delete via the list (no waveform interference)
      if (ml) ml.addEventListener("click", (e) => { const b = e.target.closest(".ml-x"); if (b && ws.regions.list[b.dataset.rid]) ws.regions.list[b.dataset.rid].remove(); });
      const z = document.getElementById("seg-zoom");           // 0 = fit whole track … 100 = default detail
      if (z) z.addEventListener("input", () => setZoom(Number(z.value)));
      const zin = document.getElementById("seg-zoom-in"), zout = document.getElementById("seg-zoom-out"), zdef = document.getElementById("seg-zoom-default");
      if (zin) zin.addEventListener("click", () => setZoom((z ? Number(z.value) : 100) + 15));
      if (zout) zout.addEventListener("click", () => setZoom((z ? Number(z.value) : 100) - 15));
      if (zdef) zdef.addEventListener("click", () => setZoom(100));
      renderList();
      const a = audioEl();
      if (a) {
        a.addEventListener("loadeddata", refresh);             // redraw when a new track's audio is ready
        let syncing = false;                                   // keep the waveform cursor on the <audio> playhead
        a.addEventListener("timeupdate", () => {
          const d = ws.getDuration() || a.duration || 0;
          if (!d) return; syncing = true; try { ws.seekTo(Math.min(1, (a.currentTime || 0) / d)); } catch (_) {} syncing = false;
        });
        ws.on("seek", (p) => { if (syncing) return; const d = a.duration || ws.getDuration() || 0; if (d) a.currentTime = p * d; });  // click waveform = seek
      }
      refresh();
    } catch (e) { console.warn("Waveform init failed", e); ws = null; }
  }

  function refresh() {                       // decode the track URL just for drawing; does NOT capture the <audio>, so native playback keeps sound
    const a = audioEl();
    if (ws && a && a.src) { wsReady = false; try { ws.load(a.src); } catch (e) { console.warn("ws.load", e); } }
  }

  function applyRestore(pr) {                              // re-draw saved markers for a revisited track
    if (!ws) return;
    if (ws.clearRegions) ws.clearRegions();
    (pr.neutrals || []).forEach((t) => { const r = ws.addRegion({ start: t, end: t + 0.12, color: colorFor("neutral"), drag: false, resize: false, data: { label: "neutral" } }); styleRegion(r, "neutral"); });
    (pr.segments || []).forEach((s) => { const r = ws.addRegion({ start: s.start_s, end: s.end_s, color: colorFor(s.label), drag: false, resize: false, data: { label: s.label } }); styleRegion(r, s.label); });
    anchorSec = (pr.neutrals && pr.neutrals.length) ? pr.neutrals[0] : null;
    updateMarkers();
  }

  // zoom: pct 0 = fit whole track (drag big ranges) … 100 = default 20px/s (detail / max zoom-in)
  const DEFAULT_PX = 20;
  function setZoom(pct) {
    if (!ws || !ws.getDuration) return;
    const dur = ws.getDuration() || 0; if (!dur) return;
    const cont = (document.getElementById("waveform") || {}).clientWidth || 800;
    const fit = Math.max(1, cont / dur);
    const maxIn = Math.max(fit, DEFAULT_PX), minOut = Math.min(fit, DEFAULT_PX);
    pct = Math.max(0, Math.min(100, pct));
    const z = document.getElementById("seg-zoom"); if (z) z.value = String(Math.round(pct));
    try { ws.zoom(minOut + (pct / 100) * (maxIn - minOut)); } catch (_) {}
  }
  function curT() {
    const a = audioEl();                                  // TRUE playhead = the <audio> element (the playback engine)
    if (a && isFinite(a.currentTime)) return a.currentTime;
    return ws && ws.getCurrentTime ? ws.getCurrentTime() : 0;
  }
  function dur() {
    if (ws && ws.getDuration) return ws.getDuration() || 0;
    return audioEl() ? (audioEl().duration || 0) : 0;
  }

  return {
    init, refresh,
    setActive(l) { activeLabel = l; },
    addPoint(label) {                        // tap a label button → point at playhead
      if (!ws) return;
      activeLabel = label;
      const t = curT();
      const r = ws.addRegion({ start: t, end: t + 0.05,   // point at the playhead; widen / move via its click-menu
        color: colorFor(label), drag: false, resize: false, data: { label } });
      styleRegion(r, label); updateMarkers();
    },
    setAnchor() {
      if (!ws) return;
      anchorSec = curT();
      const r = ws.addRegion({ start: anchorSec, end: anchorSec + 0.12, color: colorFor("neutral"),
        drag: false, resize: false, data: { label: "neutral" } });
      styleRegion(r, "neutral"); renderList();
    },
    clear() { if (ws && ws.clearRegions) ws.clearRegions(); anchorSec = null; pendingRestore = null; renderList(); },
    restore(neutrals, segments) {                          // apply now if the waveform is ready, else once it decodes
      const pr = { neutrals: neutrals || [], segments: segments || [] };
      if (ws && ws.getDuration && ws.getDuration() > 0 && wsReady) applyRestore(pr); else pendingRestore = pr;
    },
    getAnchor() {                                       // earliest neutral-labeled region = the baseline anchor
      if (!ws || !ws.regions || !ws.regions.list) return anchorSec;
      const ns = Object.values(ws.regions.list)
        .filter((r) => r.data && r.data.label === "neutral").map((r) => +r.start).sort((a, b) => a - b);
      return ns.length ? +ns[0].toFixed(2) : null;
    },
    getNeutrals() {                                   // all neutral reference markers (sorted by time)
      if (!ws || !ws.regions || !ws.regions.list) return [];
      return Object.values(ws.regions.list).filter((r) => r.data && r.data.label === "neutral")
        .map((r) => +(+r.start).toFixed(2)).sort((x, y) => x - y);
    },
    getSegments() {                                   // love/mid/slop, each stamped with its nearest PRECEDING neutral (L→R)
      if (!ws || !ws.regions || !ws.regions.list) return [];
      const all = Object.values(ws.regions.list);
      const neutrals = all.filter((r) => r.data && r.data.label === "neutral").map((r) => +(+r.start).toFixed(2)).sort((x, y) => x - y);
      const refFor = (s) => { let ref = null; for (const n of neutrals) { if (n <= s + 1e-6) ref = n; else break; } return ref; };
      return all
        .filter(NESTABLE)
        .map((r) => { const start_s = +(+r.start).toFixed(2); const par = enclosingOf(r, all);
          return { id: r.id, start_s, end_s: +(+r.end).toFixed(2), label: r.data.label, strength: 2,
            ref_neutral_s: refFor(start_s), parent_id: par ? par.id : null, ts: new Date().toISOString() }; })
        .sort((a, b) => a.start_s - b.start_s);
    },
  };
})();
