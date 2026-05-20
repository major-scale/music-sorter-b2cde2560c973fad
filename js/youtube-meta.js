// YouTube Data API enrichment. Keyed by the video IDs we already store, so no fuzzy
// matching. Returns channel, upload date, duration, tags, and — for official-label
// and "– Topic" music uploads — label / release date / canonical artist+title parsed
// from the auto-generated description.
//
// The API key lives only in this browser's localStorage. Create a free key at
// console.cloud.google.com (enable "YouTube Data API v3"), and restrict it to your
// Pages origin (HTTP referrer) + the YouTube Data API.

window.YTMeta = (() => {
  const KEY = "sorter.ytApiKey.v1";
  const _log = (...a) => console.info("%c[YTMeta]", "color:#1db954", ...a);
  const _err = (...a) => console.error("[YTMeta]", ...a);

  function getKey() { try { return localStorage.getItem(KEY) || ""; } catch (_) { return ""; } }
  function setKey(k) { localStorage.setItem(KEY, (k || "").trim()); }
  function isEnabled() { return !!getKey(); }

  // ISO-8601 duration (PT4M13S) → seconds
  function parseDuration(iso) {
    const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || "");
    if (!m) return null;
    return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
  }

  // Auto-generated music description, e.g.:
  //   Provided to YouTube by <distributor>
  //   <Title> · <Artist 1> · <Artist 2>
  //   <Album>
  //   ℗ 2020 <Label>
  //   Released on: 2020-05-01
  function parseMusicDescription(desc) {
    const out = {};
    if (!desc) return out;
    const released = /Released on:\s*(\d{4}-\d{2}-\d{2})/.exec(desc);
    if (released) out.release_date = released[1];
    const phono = /℗\s*(\d{4})?\s*(.+)/.exec(desc);
    if (phono) { out.label = phono[2].trim(); if (phono[1]) out.release_year = phono[1]; }
    const dist = /Provided to YouTube by\s*(.+)/.exec(desc);
    if (dist) out.distributor = dist[1].trim();
    const lines = desc.split("\n").map((s) => s.trim()).filter(Boolean);
    const dot = lines.find((l) => l.includes(" · "));
    if (dot) {
      const parts = dot.split(" · ");
      out.title = parts[0].trim();
      out.artist = parts.slice(1).join(", ").trim();
      // line after the title·artist line is usually the album
      const i = lines.indexOf(dot);
      if (i >= 0 && lines[i + 1] && !/℗|Released on|Provided to/.test(lines[i + 1])) {
        out.album = lines[i + 1];
      }
    }
    return out;
  }

  // topicCategories are Wikipedia URLs, e.g. .../wiki/Electronic_music → "Electronic music"
  function parseTopics(topicDetails) {
    const urls = (topicDetails && topicDetails.topicCategories) || [];
    return urls.map((u) => {
      try { return decodeURIComponent(u.split("/").pop().replace(/_/g, " ")); }
      catch (_) { return null; }
    }).filter(Boolean);
  }

  function snippetToMeta(item) {
    const s = item.snippet || {};
    const c = item.contentDetails || {};
    const st = item.statistics || {};
    const music = parseMusicDescription(s.description);
    return {
      channel_title: s.channelTitle || null,
      published_at: s.publishedAt || null,
      duration_seconds: parseDuration(c.duration),
      tags: Array.isArray(s.tags) ? s.tags.slice(0, 15) : [],
      yt_title: music.title || null,
      yt_artist: music.artist || null,
      yt_album: music.album || null,
      yt_label: music.label || null,
      yt_release_date: music.release_date || (music.release_year ? `${music.release_year}` : null),
      view_count: st.viewCount != null ? +st.viewCount : null,
      like_count: st.likeCount != null ? +st.likeCount : null,
      is_music_category: s.categoryId === "10",
      topics: parseTopics(item.topicDetails),
      default_language: s.defaultAudioLanguage || null,
      enriched_at: new Date().toISOString(),
    };
  }

  async function call(ids) {
    const key = getKey();
    if (!key) throw new Error("no API key set");
    const url = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails,statistics,topicDetails&id=${ids.join(",")}&key=${key}`;
    const resp = await fetch(url);
    if (!resp.ok) {
      let msg = `${resp.status}`;
      try { msg = `${resp.status} ${(await resp.json()).error.message}`; } catch (_) {}
      _err("API error:", msg);
      throw new Error(msg);
    }
    return (await resp.json()).items || [];
  }

  async function lookup(videoId) {
    const items = await call([videoId]);
    if (!items.length) { _log(`${videoId}: no item returned`); return null; }
    const meta = snippetToMeta(items[0]);
    _log(`${videoId} →`, meta.yt_artist || meta.channel_title, meta.yt_release_date || "", meta.yt_label || "");
    return meta;
  }

  // Batch (up to 50 ids per call). Returns Map(id → meta).
  async function lookupBatch(videoIds) {
    const out = new Map();
    for (let i = 0; i < videoIds.length; i += 50) {
      const chunk = videoIds.slice(i, i + 50);
      const items = await call(chunk);
      for (const it of items) out.set(it.id, snippetToMeta(it));
      _log(`batch ${i / 50 + 1}: ${items.length}/${chunk.length} enriched`);
    }
    return out;
  }

  async function test() {
    // dQw4w9WgXcQ is always available; confirms the key + referrer restriction work.
    const items = await call(["dQw4w9WgXcQ"]);
    if (!items.length) throw new Error("key works but no item (unexpected)");
    _log("test OK");
    return true;
  }

  return { getKey, setKey, isEnabled, lookup, lookupBatch, test };
})();
