// Queue source management.
//
// MVP supports YouTube playlist URLs only (per Phase 1 scope). A playlist URL is
// parsed into a playlist ID; the active playlist + its metadata are stored in
// `sorter.activeQueue.v1`. Already-rated filtering happens at playback time via
// onTrackChange — when the current videoId is in Ratings.getRatedIds() AND the
// user opted into skip-rated, we auto-advance.

window.Queue = (() => {
  const ACTIVE_KEY = "sorter.activeQueue.v1";

  function parsePlaylistId(input) {
    if (!input) return null;
    const trimmed = input.trim();
    // Bare ID?
    if (/^[A-Za-z0-9_-]{13,}$/.test(trimmed) && /^(PL|OL|RD|UU|FL|LL)/.test(trimmed)) {
      return trimmed;
    }
    try {
      const url = new URL(trimmed);
      const list = url.searchParams.get("list");
      if (list) return list;
    } catch (_) { /* not a URL */ }
    return null;
  }

  function loadActive() {
    try {
      const raw = localStorage.getItem(ACTIVE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function saveActive(active) {
    if (active) localStorage.setItem(ACTIVE_KEY, JSON.stringify(active));
    else localStorage.removeItem(ACTIVE_KEY);
  }

  function setActive({ playlistId, title, skipRated }) {
    const active = {
      playlistId,
      title: title || "",
      skipRated: skipRated !== false,
      startedAt: new Date().toISOString(),
    };
    saveActive(active);
    return active;
  }

  function getActive() { return loadActive(); }
  function clearActive() { saveActive(null); }

  return { parsePlaylistId, setActive, getActive, clearActive };
})();
