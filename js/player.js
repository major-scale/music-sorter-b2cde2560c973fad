// Player router. window.Player delegates every call to the active backend
// (YTBackend = YouTube, default; LocalBackend = local mp3s for the Round 2 pilot).
// App code keeps calling Player.* unchanged; Player.use("local"|"youtube") swaps engines.
//
// Callback handling: each backend gets ONE dispatcher per event (registered once) that
// re-emits to the router's live callback lists — so callbacks added at any time fire on
// whichever backend is active, with no double-registration when toggling back and forth.
//
// Load order (index.html): youtube-player.js, local-player.js, THEN player.js, THEN app.js.

window.Player = (() => {
  let active = window.YTBackend || null;     // default = YouTube (original behavior)
  let name = active ? "youtube" : null;
  const cbs = { track: [], playing: [], state: [] };
  const registered = new Set();

  function ensureDispatchers(b) {
    if (!b || registered.has(b)) return;
    registered.add(b);
    b.onTrackChange     && b.onTrackChange((i) => cbs.track.forEach((fn) => fn(i)));
    b.onPlayingStarted  && b.onPlayingStarted((i) => cbs.playing.forEach((fn) => fn(i)));
    b.onPlayStateChange && b.onPlayStateChange((s) => cbs.state.forEach((fn) => fn(s)));
  }
  ensureDispatchers(active);

  const FORWARD = ["init", "onReady", "load", "loadVideoIds", "setManifest", "pickFolder", "forgetFolder", "hasFolder",
    "next", "previous", "playAt", "getPlaylist", "getPlaylistIndex", "moveCurrentToEnd",
    "play", "pause", "togglePlay", "seek", "seekBy", "currentTime", "setStartOffset",
    "getCurrent", "currentTrack", "getTracks", "urlFor", "listenSeconds"];

  const api = {
    use(which) {
      const b = which === "local" ? window.LocalBackend : window.YTBackend;
      if (!b) return api;
      if (b !== active) {
        try { active && active.pause && active.pause(); } catch (_) {}
        active = b; name = which;
      }
      ensureDispatchers(active);
      return api;
    },
    backendName() { return name; },
    backend() { return active; },
    onTrackChange(fn) { cbs.track.push(fn); },
    onPlayingStarted(fn) { cbs.playing.push(fn); },
    onPlayStateChange(fn) { cbs.state.push(fn); },
  };
  FORWARD.forEach((m) => {
    api[m] = (...args) => (active && typeof active[m] === "function" ? active[m](...args) : undefined);
  });
  return api;
})();
