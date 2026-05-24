// App-shell caching only. YouTube embeds + IFrame API are network-passthrough.
const VERSION = "v29-2026-05-24-marker-midline";
const SHELL = [
  "./",
  "./index.html",
  "./manifest.json",
  "./css/styles.css",
  "./js/app.js",
  "./js/youtube-player.js",
  "./js/local-player.js",
  "./js/player.js",
  "./js/rating-manager.js",
  "./js/queue-manager.js",
  "./js/ranking.js",
  "./js/segments.js",
  "./js/waveform.js",
  "./js/round2-health.js",
  "./js/stats.js",
  "./js/export.js",
  "./js/pwa.js",
  "./js/sync.js",
  "./js/github-sync.js",
  "./js/youtube-meta.js",
  "./js/vendor/wavesurfer.min.js",
  "./js/vendor/wavesurfer.regions.min.js",
  "./js/vendor/wavesurfer.minimap.min.js",
  "./icons/icon.svg",
  "./icons/icon-maskable.svg",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const u = new URL(e.request.url);
  if (/youtube\.com|ytimg\.com|googlevideo\.com|google\.com/.test(u.hostname)) return;
  if (e.request.method !== "GET") return;

  // Navigation requests (HTML page loads): network-first so users see the latest
  // <script>/<link> tags. Falls back to cache when offline.
  if (e.request.mode === "navigate" || e.request.destination === "document") {
    e.respondWith(
      fetch(e.request).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return resp;
      }).catch(() =>
        caches.match(e.request).then((c) => c || caches.match("./index.html"))
      )
    );
    return;
  }

  // Everything else (JS/CSS/SVG): stale-while-revalidate.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((resp) => {
        if (resp && resp.ok) {
          const copy = resp.clone();
          caches.open(VERSION).then((c) => c.put(e.request, copy));
        }
        return resp;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
