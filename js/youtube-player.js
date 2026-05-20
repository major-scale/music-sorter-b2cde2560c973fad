// Thin YouTube IFrame API wrapper.
//
// Exposes a global `Player` with:
//   Player.load(playlistId)          start playing a playlist
//   Player.next()                    advance to next track
//   Player.togglePlay()              play/pause
//   Player.getCurrent()              { videoId, videoTitle, author, durationSec }
//   Player.listenSeconds()           accumulated play time on current track
//   Player.onTrackChange(fn)         callback when current videoId changes
//   Player.onPlayingStarted(fn)      first time playback begins after a track load
//
// The YouTube IFrame API calls window.onYouTubeIframeAPIReady() once loaded.

window.Player = (() => {
  let yt = null;
  let ready = false;
  const readyQueue = [];
  let listenAccumulatedMs = 0;
  let lastPlayingStartedAt = null;
  let currentVideoId = null;
  let pendingPlaylistId = null;
  const trackChangeCbs = [];
  const playingStartedCbs = [];
  let firstPlayingFired = false;
  let startOffsetSec = 0;       // auto-seek to this position on each new track
  let seekedThisTrack = false;

  function onReady(cb) { if (ready) cb(); else readyQueue.push(cb); }

  function init() {
    yt = new YT.Player("player", {
      width: "100%",
      height: "100%",
      playerVars: {
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        autoplay: 0,
      },
      events: {
        onReady: () => {
          ready = true;
          readyQueue.splice(0).forEach((cb) => cb());
          if (pendingPlaylistId) {
            yt.loadPlaylist({ list: pendingPlaylistId, listType: "playlist" });
            pendingPlaylistId = null;
          }
        },
        onStateChange: handleState,
        onError: (e) => console.warn("YT error", e?.data),
      },
    });
  }

  function handleState(e) {
    // PLAYING=1, PAUSED=2, ENDED=0, BUFFERING=3, CUED=5, UNSTARTED=-1
    const data = yt.getVideoData ? yt.getVideoData() : null;
    const videoId = data?.video_id || null;

    if (videoId && videoId !== currentVideoId) {
      currentVideoId = videoId;
      listenAccumulatedMs = 0;
      lastPlayingStartedAt = null;
      firstPlayingFired = false;
      seekedThisTrack = false;
      trackChangeCbs.forEach((cb) => cb(currentInfo()));
    }

    if (e.data === YT.PlayerState.PLAYING) {
      if (startOffsetSec > 0 && !seekedThisTrack) {
        seekedThisTrack = true;
        let dur = 0;
        try { dur = yt.getDuration() || 0; } catch (_) {}
        // Only skip the intro if the track is comfortably longer than the offset.
        if (dur === 0 || dur > startOffsetSec + 5) {
          try { yt.seekTo(startOffsetSec, true); } catch (_) {}
        }
      }
      if (lastPlayingStartedAt == null) lastPlayingStartedAt = performance.now();
      if (!firstPlayingFired) {
        firstPlayingFired = true;
        playingStartedCbs.forEach((cb) => cb(currentInfo()));
      }
    } else {
      // Pause / buffer / end / cued — accumulate up to now
      if (lastPlayingStartedAt != null) {
        listenAccumulatedMs += performance.now() - lastPlayingStartedAt;
        lastPlayingStartedAt = null;
      }
    }
  }

  function currentInfo() {
    const data = yt && yt.getVideoData ? yt.getVideoData() : null;
    if (!data) return null;
    let duration = 0;
    try { duration = yt.getDuration() || 0; } catch (_) {}
    return {
      videoId: data.video_id,
      videoTitle: data.title,
      author: data.author,
      durationSec: duration,
    };
  }

  return {
    init,
    onReady,
    load(playlistId) {
      onReady(() => yt.loadPlaylist({ list: playlistId, listType: "playlist" }));
      if (!ready) pendingPlaylistId = playlistId;
    },
    next() {
      onReady(() => yt.nextVideo());
    },
    previous() {
      onReady(() => yt.previousVideo());
    },
    playAt(index) {
      onReady(() => { try { yt.playVideoAt(index); } catch (_) {} });
    },
    getPlaylist() {
      try { return yt.getPlaylist() || []; } catch (_) { return []; }
    },
    getPlaylistIndex() {
      try { return yt.getPlaylistIndex(); } catch (_) { return -1; }
    },
    // Move the currently-playing track to the end of the queue and advance.
    // Used by "Skip" so hard cases come back around later.
    moveCurrentToEnd() {
      onReady(() => {
        try {
          const list = yt.getPlaylist();
          const idx = yt.getPlaylistIndex();
          if (!Array.isArray(list) || list.length < 2 || idx < 0) { yt.nextVideo(); return; }
          const reordered = list.slice();
          const [cur] = reordered.splice(idx, 1);
          reordered.push(cur);
          // After removal, the track that was "next" now sits at `idx`.
          yt.loadPlaylist({ playlist: reordered, index: idx % reordered.length });
        } catch (_) { yt.nextVideo(); }
      });
    },
    play() {
      onReady(() => yt.playVideo());
    },
    pause() {
      onReady(() => yt.pauseVideo());
    },
    togglePlay() {
      onReady(() => {
        const s = yt.getPlayerState();
        if (s === YT.PlayerState.PLAYING) yt.pauseVideo(); else yt.playVideo();
      });
    },
    seek(seconds) { onReady(() => yt.seekTo(seconds, true)); },
    seekBy(delta) {
      onReady(() => {
        try {
          const t = yt.getCurrentTime() || 0;
          yt.seekTo(Math.max(0, t + delta), true);
        } catch (_) {}
      });
    },
    currentTime() {
      try { return yt.getCurrentTime() || 0; } catch (_) { return 0; }
    },
    setStartOffset(sec) { startOffsetSec = Math.max(0, Number(sec) || 0); },
    getCurrent: currentInfo,
    listenSeconds() {
      let ms = listenAccumulatedMs;
      if (lastPlayingStartedAt != null) ms += performance.now() - lastPlayingStartedAt;
      return ms / 1000;
    },
    onTrackChange(fn)     { trackChangeCbs.push(fn); },
    onPlayingStarted(fn)  { playingStartedCbs.push(fn); },
  };
})();

window.onYouTubeIframeAPIReady = function () {
  window.Player.init();
};
