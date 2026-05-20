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
    if (resp.status === 404) return null;
    if (!resp.ok) throw new Error(`GET ${resp.status}`);
    return (await resp.json()).sha;
  }

  async function pushNow() {
    const c = getConfig();
    if (!isEnabled()) return false;
    const payload = window.Exporter.buildPayload();
    payload.metadata.device_id = getDeviceId();
    const content = b64(JSON.stringify(payload, null, 2));
    const sha = await getSha(c);
    const url = `https://api.github.com/repos/${c.owner}/${c.repo}/contents/${filePath()}`;
    const body = {
      message: `sync ${payload.metadata.total_tracks} tracks from ${getDeviceId()}`,
      content, branch: c.branch,
    };
    if (sha) body.sha = sha;
    const resp = await fetch(url, {
      method: "PUT",
      headers: { ...headers(c), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text();
      setConfig({ lastError: `${resp.status}: ${t.slice(0, 120)}` });
      throw new Error(`PUT ${resp.status}`);
    }
    setConfig({ lastSync: new Date().toISOString(), lastError: null });
    return true;
  }

  function flush() {
    if (!isEnabled()) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      pushNow().catch((e) => {
        console.warn("github sync failed", e);
        window.PWA && PWA.showToast("Cloud backup failed: " + e.message, 3500);
      });
    }, 1500);
  }

  async function test() {
    const c = getConfig();
    if (!c.token) throw new Error("no token set");
    const resp = await fetch(`https://api.github.com/repos/${c.owner}/${c.repo}`, { headers: headers(c) });
    if (!resp.ok) throw new Error(`repo access failed (${resp.status}) — check token scope & repo name`);
    return true;
  }

  return { getConfig, setConfig, isEnabled, flush, pushNow, test, getDeviceId, filePath };
})();
