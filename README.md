# Music Sorter PWA

Rate tracks fast for personal recommender training. Streams via YouTube embeds; ratings stay on-device until you export JSON.

## Phase status

- **Phase 1 + 2 implemented** in this build:
  - YouTube IFrame playlist queue (paste URL or pick a preset)
  - 3-button SLOP / MID / LOVE rating with 20-second listen gate (visual ring)
  - "I know this track" skip-gate, Skip, Unavailable
  - Optional 5-point + notes (collapsible)
  - localStorage persistence, IndexedDB fallback for overflow
  - Already-rated dedupe (auto-skip when toggled on)
  - Consistency check every 50 ratings → weighted Cohen's κ in the header
  - Stats dashboard: totals, sub-genre breakdown, hour-of-day chart, session info
  - JSON export: download / clipboard / Web Share
  - Service worker app-shell caching (offline browsing of UI; playback needs network)
  - PWA manifest + install prompt; "Install as app" item in menu
  - Keyboard shortcuts (1/2/3, space, →, K)
  - Swipe gestures on mobile (← SLOP, → LOVE, ↑ MID)
  - Vibration haptic on rating
- **Deferred**: sub-genre tag chips, stratified shuffle, curated JSON queues (Phase 3); GitHub/Drive sync (Phase 4).

## Run locally

```bash
cd music-sorter-pwa
python3 -m http.server 8000
# open http://localhost:8000
```

Use a real YouTube playlist URL in the "Custom" box, e.g.
`https://www.youtube.com/playlist?list=PLxxxxxxxxxxx`.

> **Mobile autoplay note**: YouTube embeds need a user gesture before they'll start. The "Tap to start" overlay handles this on first load.

## Updating the deployed app

The service worker uses a VERSION constant (`service-worker.js` top line). **Bump it whenever you change CSS or JS** — that's the signal for installed PWAs to invalidate their cache. On the next page load: the SW updates, activates, and the page auto-reloads once so the user sees the new code. HTML is network-first regardless, so `index.html` changes propagate immediately.

## Deploy to GitHub Pages

```bash
cd music-sorter-pwa
git init && git add . && git commit -m "init music sorter pwa"
gh repo create music-sorter-pwa --public --source=. --remote=origin --push
# Then in repo Settings → Pages → Deploy from branch: main, /(root)
```

All asset paths are relative, so the app works at both `https://you.github.io/music-sorter-pwa/` and a custom root.

## Export format

`{ metadata, tracks: [...], consistency_checks: [...], sessions: [...] }`
where each `tracks[i]` matches the data model in the spec (`track_id` = `yt:<youtube_id>`).
This is the format consumed by the `personalPreference/` training pipeline.

## Notes for the user

- Open ☰ → **Install as app** on Android Chrome / Edge / Desktop Chrome. iOS Safari uses Share → Add to Home Screen.
- Open ☰ → **Stats & export** to see counts, κ, hour distribution, and download JSON.
- Open the Queue chip in the header to swap playlists mid-session.
- κ shows `—` until you've completed ≥ 5 consistency checks (every 50th rating triggers one; previously-rated track surfaces silently).
- Clear-all is in ☰ — **export first**.

## File map

```
index.html                # all UI shells (header, player, rating row, modals)
manifest.json             # PWA manifest
service-worker.js         # app-shell cache, YouTube passthrough
css/styles.css            # dark theme, mobile-first, 2-col desktop
js/youtube-player.js      # YT IFrame wrapper + listen-time accumulator
js/rating-manager.js      # storage, consistency picks, weighted κ
js/queue-manager.js       # playlist URL → ID, active-queue state
js/stats.js               # compact bar + detail modal renderer
js/export.js              # JSON export / clipboard / Web Share
js/pwa.js                 # SW register, install prompt, toast
js/app.js                 # event wiring, gate ticker, swipe, keyboard
icons/icon.svg            # manifest icon (gradient play-glyph)
icons/icon-maskable.svg   # manifest maskable variant
```
