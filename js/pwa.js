// Service worker registration + install-prompt handling.

window.PWA = (() => {
  let deferredPrompt = null;
  let installShown = false;

  function register() {
    if (!("serviceWorker" in navigator)) return;
    // Use relative URL so this works at any GH Pages subpath
    navigator.serviceWorker.register("service-worker.js").then((reg) => {
      // Force an update check on every load (default browser cooldown can be 24h)
      if (reg) reg.update().catch(() => {});
      // When a new SW activates, reload once so users see fresh assets without manual hard-refresh
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (PWA._reloaded) return;
        PWA._reloaded = true;
        location.reload();
      });
    }).catch((err) => {
      console.warn("SW register failed:", err);
    });
  }

  function captureInstallPrompt() {
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      deferredPrompt = e;
      // Show our own install hint when the user has earned the right to one (3+ ratings)
      const total = Ratings.counts().total;
      if (total >= 3 && !installShown) {
        installShown = true;
        showToast("Install as an app — open ☰ menu", 4000);
      }
    });
    window.addEventListener("appinstalled", () => {
      deferredPrompt = null;
      showToast("Installed — open from your home screen", 2500);
    });
  }

  async function promptInstall() {
    if (!deferredPrompt) {
      showToast("Install isn't available yet (use Chrome / Edge / Android). " +
                "On iOS use Share → Add to Home Screen.", 5000);
      return;
    }
    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    deferredPrompt = null;
    showToast(outcome === "accepted" ? "Installing…" : "Install dismissed", 2000);
  }

  function showToast(text, ms = 1800) {
    const t = document.getElementById("toast");
    if (!t) return;
    t.textContent = text;
    t.classList.remove("hidden");
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.add("hidden"), ms);
  }

  return { register, captureInstallPrompt, promptInstall, showToast };
})();
