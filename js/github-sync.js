// GitHub-as-store backup. Commits the full export payload to a PRIVATE repo via the
// GitHub Contents API using a fine-grained PAT (stored only in this browser's
// localStorage). Each device writes its own file (data/ratings-<deviceId>.json) so
// concurrent devices never clobber each other — merge by youtube_id (latest rated_at
// wins) at read time. Version history on every push = restore points = no data loss.
//
// CORS: api.github.com sends permissive CORS headers, so this works directly from the
// browser (incl. the HTTPS GitHub Pages page) with no backend server.

window.GithubSync = (() => {
  const CFG_KEY = "sorter.github.v1";
  const DEVICE_KEY = "sorter.deviceId.v1";
  const DEFAULTS = {
    token: "", owner: "major-scale", repo: "music-sorter-data",
    branch: "main", enabled: false, lastSync: null, lastError: null,
  };
  let timer = null;
  let chain = Promise.resolve();  // serializes pushes so they never overlap

  const _log = (...a) => console.info("%c[GithubSync]", "color:#7c4dff", ...a);
  const _warn = (...a) => console.warn("[GithubSync]", ...a);

  function getDeviceId() {
    let id = localStorage.getItem(DEVICE_KEY);
    if (!id) {
      const kind = matchMedia("(pointer: coarse)").matches ? "mobile" : "desktop";
      id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
      localStorage.setItem(DEVICE_KEY, id);
    }
    return id;
  }

  function getConfig() {
    try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(CFG_KEY) || "{}") }; }
    catch (_) { return { ...DEFAULTS }; }
  }
  function setConfig(patch) {
    const c = { ...getConfig(), ...patch };
    localStorage.setItem(CFG_KEY, JSON.stringify(c));
    return c;
  }
  function isEnabled() {
    const c = getConfig();
    return !!(c.enabled && c.token && c.owner && c.repo);
  }

  function b64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
  }

  function filePath() { return `data/ratings-${getDeviceId()}.json`; }

  function headers(c) {
    return { Authorization: `Bearer ${c.token}`, Accept: "application/vnd.github+json" };
  }

  async function getSha(c) {
    const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${filePath()}?ref=${c.branch}`;
    const resp = await fetch(url, { headers: headers(c) });
    if (resp.status === 404) { _log("getSha → new file (404)"); return null; }
    if (!resp.ok) {
      const msg = await errMessage(resp);
      _warn("getSha failed:", msg);
      throw new Error(`GET sha ${msg}`);
    }
    const sha = (await resp.json()).sha;
    _log("getSha →", sha.slice(0, 7));
    return sha;
  }

  // Pull GitHub's actual error message out of the JSON body (e.g.
  // "Resource not accessible by personal access token", or sha-conflict detail).
  async function errMessage(resp) {
    let detail = "";
    try { detail = (await resp.clone().json()).message || ""; }
    catch (_) { try { detail = (await resp.text()).slice(0, 140); } catch (__) {} }
    return `${resp.status}${detail ? " " + detail : ""}`;
  }

  // One GET-sha + PUT attempt; retries once on a 409 sha-conflict.
  async function doPush(c, attempt = 0) {
    const payload = window.Exporter.buildPayload();
    payload.metadata.device_id = getDeviceId();
    const content = b64(JSON.stringify(payload, null, 2));
    _log(`push: ${payload.metadata.total_tracks} tracks → ${filePath()} (attempt ${attempt + 1})`);

    const sha = await getSha(c);
    const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${filePath()}`;
    const body = { message: `sync ${payload.metadata.total_tracks} tracks from ${getDeviceId()}`, content, branch: c.branch };
    if (sha) body.sha = sha;

    const resp = await fetch(url, {
      method: "PUT",
      headers: { ...headers(c), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (resp.status === 409 && attempt < 2) {
      _warn("409 sha-conflict — refetching and retrying");
      return doPush(c, attempt + 1);
    }
    if (!resp.ok) {
      const msg = await errMessage(resp);
      setConfig({ lastError: msg });
      _warn("PUT failed:", msg, "(see Settings → status for the saved error)");
      throw new Error(msg);
    }
    _log(`PUT → ${resp.status} OK`);
    setConfig({ lastSync: new Date().toISOString(), lastError: null });
    return true;
  }

  // All pushes go through one promise chain → never overlap → no self-conflicts.
  function enqueuePush() {
    const c = getConfig();
    if (!isEnabled()) { _warn("push skipped: cloud backup not enabled / no token"); return Promise.resolve(false); }
    const run = () => doPush(c, 0);
    chain = chain.then(run, run);
    return chain;
  }

  async function pushNow() {
    return enqueuePush();
  }

  function flush() {
    if (!isEnabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      enqueuePush().catch((e) => {
        window.PWA && PWA.showToast("Cloud backup failed: " + e.message, 4500);
      });
    }, 1500);
  }

  function decodeB64(b64) {
    const bin = atob((b64 || "").replace(/\n/g, ""));
    const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  // Pull every device's file from the repo and merge into this instance via
  // Ratings.importPayload (newest rated_at wins). Makes any instance converge to
  // the full cross-device history.
  async function pullMerge() {
    const c = getConfig();
    if (!isEnabled()) return 0;
    const listResp = await fetch(
      `https://api.github.com/repos/${c.owner}/${c.repo}/contents/data?ref=${c.branch}`,
      { headers: headers(c) }
    );
    if (listResp.status === 404) return 0;
    if (!listResp.ok) throw new Error(`list ${listResp.status}`);
    const files = await listResp.json();
    const ratingFiles = files.filter((f) => f.type === "file" && /^ratings-.*\.json$/.test(f.name));
    _log(`pullMerge: found ${ratingFiles.length} rating file(s):`, ratingFiles.map((f) => f.name).join(", "));
    let merged = 0;
    for (const f of ratingFiles) {
      const fr = await fetch(
        `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${f.path}?ref=${c.branch}`,
        { headers: headers(c) }
      );
      if (!fr.ok) { _warn(`pullMerge: skip ${f.name} (${fr.status})`); continue; }
      const j = await fr.json();
      try {
        const payload = JSON.parse(decodeB64(j.content));
        const r = window.Ratings.importPayload(payload);
        _log(`pullMerge: ${f.name} → +${r.added} new, ${r.updated} updated`);
        merged += r.added + r.updated;
      } catch (e) { _warn(`pullMerge: parse failed for ${f.name}`, e); }
    }
    _log(`pullMerge: total ${merged} merged; local total now ${window.Ratings.counts().total}`);
    return merged;
  }

  async function test() {
    const c = getConfig();
    if (!c.token) throw new Error("no token set");
    _log(`test: GET repos/${c.owner}/${c.repo}`);
    const resp = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}`, { headers: headers(c) });
    if (!resp.ok) {
      const msg = await errMessage(resp);
      _warn("test failed:", msg, "— 404 usually = token can't see the repo (resource owner / repo selection)");
      throw new Error(`repo access failed (${msg})`);
    }
    _log("test: OK, repo reachable");
    return true;
  }

  return { getConfig, setConfig, isEnabled, flush, pushNow, pullMerge, test, getDeviceId, filePath };
})();
