// Live sync via File System Access API.
//
// One-time setup: user clicks "Live sync to file" in the menu → native save-file
// picker → grants write access to a file (recommended: a path Claude can read,
// e.g. ~/myMusic/personalPreference/data/sorter_live.json).
//
// The file handle is persisted in IndexedDB so subsequent page loads silently
// resume sync (the permission grant survives reloads as long as the user doesn't
// revoke site permissions in browser settings).
//
// After every rating, a debounced flush writes the full Exporter.buildPayload()
// to the file (overwrites — same format as the manual "Download JSON" export).
//
// Browser support: Chrome / Edge desktop. Firefox / Safari fall through with a
// toast; the manual export remains available.

window.Sync = (() => {
  const STORE_KEY = "fileHandle";

  let handle = null;
  let flushTimer = null;

  // ---- IndexedDB handle storage (shares "sorter-db"/"kv" with rating-manager) ----

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open("sorter-db", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("kv");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async function getStoredHandle() {
    try {
      const db = await openDB();
      return await new Promise((res) => {
        const tx = db.transaction("kv", "readonly");
        const r = tx.objectStore("kv").get(STORE_KEY);
        r.onsuccess = () => res(r.result || null);
        r.onerror = () => res(null);
      });
    } catch (_) { return null; }
  }

  async function setStoredHandle(h) {
    try {
      const db = await openDB();
      await new Promise((res) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").put(h, STORE_KEY);
        tx.oncomplete = () => res();
      });
    } catch (e) { console.warn("storing handle failed", e); }
  }

  async function clearStoredHandle() {
    try {
      const db = await openDB();
      await new Promise((res) => {
        const tx = db.transaction("kv", "readwrite");
        tx.objectStore("kv").delete(STORE_KEY);
        tx.oncomplete = () => res();
      });
    } catch (_) {}
  }

  // ---- permission helpers ----

  async function hasPermission(h) {
    if (!h || !h.queryPermission) return false;
    try {
      return (await h.queryPermission({ mode: "readwrite" })) === "granted";
    } catch (_) { return false; }
  }

  async function requestPermission(h) {
    if (!h || !h.requestPermission) return false;
    try {
      return (await h.requestPermission({ mode: "readwrite" })) === "granted";
    } catch (_) { return false; }
  }

  // ---- public API ----

  async function tryRestore() {
    if (!window.showSaveFilePicker) return false;
    const stored = await getStoredHandle();
    if (!stored) return false;
    if (await hasPermission(stored)) {
      handle = stored;
      return true;
    }
    // Permission was revoked / TTL'd; keep handle in IDB but require re-pick.
    return false;
  }

  async function pick() {
    if (!window.showSaveFilePicker) {
      window.PWA && PWA.showToast(
        "Live sync needs Chrome / Edge (uses File System Access API)", 3500
      );
      return false;
    }
    try {
      const h = await window.showSaveFilePicker({
        suggestedName: "sorter_live.json",
        types: [{
          description: "Sorter ratings JSON",
          accept: { "application/json": [".json"] },
        }],
      });
      handle = h;
      await setStoredHandle(h);
      await flush(true);
      window.PWA && PWA.showToast(
        "Live sync ON — file updates after every rating", 3000
      );
      return true;
    } catch (e) {
      if (e.name !== "AbortError") {
        window.PWA && PWA.showToast("Sync setup failed: " + e.message, 3500);
        console.warn(e);
      }
      return false;
    }
  }

  async function disable() {
    handle = null;
    await clearStoredHandle();
    window.PWA && PWA.showToast("Live sync OFF", 1500);
  }

  function isEnabled() { return !!handle; }

  async function getFileName() {
    if (!handle) return null;
    try { return handle.name; } catch (_) { return null; }
  }

  async function flush(immediate = false) {
    if (!handle) return;
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    const write = async () => {
      flushTimer = null;
      try {
        if (!(await hasPermission(handle))) {
          const ok = await requestPermission(handle);
          if (!ok) {
            handle = null;
            window.PWA && PWA.showToast("Sync paused — re-enable from ☰", 3500);
            return;
          }
        }
        const payload = window.Exporter.buildPayload();
        const writable = await handle.createWritable();
        await writable.write(JSON.stringify(payload, null, 2));
        await writable.close();
      } catch (e) {
        console.warn("sync flush failed", e);
        if (e.name === "NotAllowedError" || e.name === "NotFoundError") {
          handle = null;
          window.PWA && PWA.showToast(
            "Sync stopped (" + e.name + ") — re-pick from ☰", 4000
          );
        }
      }
    };
    if (immediate) await write(); else flushTimer = setTimeout(write, 300);
  }

  return { tryRestore, pick, disable, isEnabled, getFileName, flush };
})();
