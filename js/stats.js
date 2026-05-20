// Stats: compact bar updates + detailed modal rendering.

window.Stats = (() => {
  function $(id) { return document.getElementById(id); }

  function refreshCompact() {
    const c = Ratings.counts();
    $("stat-total").textContent = c.total;
    $("stat-love").textContent = c.LOVE || 0;
    $("stat-mid").textContent  = c.MID  || 0;
    $("stat-slop").textContent = c.SLOP || 0;
    const k = Ratings.kappa();
    $("stat-kappa").textContent = (k == null) ? "—" : k.toFixed(2);
  }

  function bucketByHour(records) {
    const buckets = Array.from({ length: 24 }, () => ({ LOVE: 0, MID: 0, SLOP: 0 }));
    for (const r of records) {
      const h = new Date(r.rated_at).getHours();
      if (r.rating_3class in buckets[h]) buckets[h][r.rating_3class]++;
    }
    return buckets;
  }

  function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null; }
  function median(xs) {
    if (!xs.length) return null;
    const s = xs.slice().sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  function ratingSpeed(all) {
    const byClass = { LOVE: [], MID: [], SLOP: [] };
    const overall = [];
    for (const r of all) {
      if (r.time_to_rate_seconds == null) continue;
      if (!(r.rating_3class in byClass)) continue;
      byClass[r.rating_3class].push(r.time_to_rate_seconds);
      overall.push(r.time_to_rate_seconds);
    }
    const fmt = (xs) => xs.length
      ? `${mean(xs).toFixed(1)}s avg · ${median(xs).toFixed(1)}s median · n=${xs.length}`
      : "—";
    return {
      overall: fmt(overall),
      LOVE: fmt(byClass.LOVE),
      MID: fmt(byClass.MID),
      SLOP: fmt(byClass.SLOP),
      hasData: overall.length > 0,
    };
  }

  function renderDetail(container) {
    const c = Ratings.counts();
    const all = Ratings.getAll();
    const k = Ratings.kappa();
    const session = Ratings.getSession();
    const speed = ratingSpeed(all);

    const pct = (n) => c.total ? `${((n / c.total) * 100).toFixed(0)}%` : "—";
    const tagCounts = {};
    for (const r of all) for (const t of (r.subgenre_tags || [])) tagCounts[t] = (tagCounts[t] || 0) + 1;
    const tagRows = Object.entries(tagCounts).sort((a, b) => b[1] - a[1])
      .map(([t, n]) => `<li><code>${t}</code>: ${n}</li>`).join("");

    const hour = bucketByHour(all);
    const maxPerHour = Math.max(1, ...hour.map((b) => b.LOVE + b.MID + b.SLOP));
    const hourBars = hour.map((b, i) => {
      const total = b.LOVE + b.MID + b.SLOP;
      const h = Math.round((total / maxPerHour) * 40);
      return `<div class="hour-col" title="${i}:00 — ${total} rated">
        <div class="hour-bar" style="height:${h}px"></div>
        <div class="hour-label">${i.toString().padStart(2, "0")}</div>
      </div>`;
    }).join("");

    container.innerHTML = `
      <div class="stats-grid">
        <div><strong>${c.total}</strong><br><span class="dim">total</span></div>
        <div class="love-text"><strong>${c.LOVE || 0}</strong><br><span class="dim">love (${pct(c.LOVE)})</span></div>
        <div class="dim-text"><strong>${c.MID || 0}</strong><br><span class="dim">mid (${pct(c.MID)})</span></div>
        <div class="slop-text"><strong>${c.SLOP || 0}</strong><br><span class="dim">slop (${pct(c.SLOP)})</span></div>
        <div><strong>${c.session}</strong><br><span class="dim">this session</span></div>
        <div><strong>${k == null ? "—" : k.toFixed(2)}</strong><br><span class="dim">κ consistency</span></div>
      </div>

      <h3 class="modal-section-title">Rating speed (seconds played before rating)</h3>
      <ul class="dim-list">
        ${speed.hasData ? `
        <li>overall: <strong>${speed.overall}</strong></li>
        <li class="love-text">LOVE: ${speed.LOVE}</li>
        <li class="dim-text">MID: ${speed.MID}</li>
        <li class="slop-text">SLOP: ${speed.SLOP}</li>
        ` : "<li class='dim'>(no timed ratings yet — rate a few and check back)</li>"}
      </ul>

      <h3 class="modal-section-title">By sub-genre</h3>
      <ul class="dim-list">${tagRows || "<li class='dim'>(no tags yet)</li>"}</ul>

      <h3 class="modal-section-title">By hour of day</h3>
      <div class="hour-chart">${hourBars}</div>

      <h3 class="modal-section-title">Session</h3>
      <ul class="dim-list">
        <li>id: <code>${session.sessionId}</code></li>
        <li>started: ${session.startedAt}</li>
        <li>device: ${session.device}</li>
        <li>rated this session: ${session.ratedCount}</li>
      </ul>
    `;
    injectStatsStyles();
  }

  function injectStatsStyles() {
    if (document.getElementById("stats-extra-css")) return;
    const s = document.createElement("style");
    s.id = "stats-extra-css";
    s.textContent = `
      .stats-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; font-family: var(--mono); }
      .stats-grid div { background: var(--bg); border: 1px solid var(--border); border-radius: 10px; padding: 10px; text-align: center; }
      .stats-grid strong { font-size: 20px; }
      .stats-grid .dim { font-size: 11px; color: var(--text-dim); }
      .love-text strong { color: var(--love); }
      .slop-text strong { color: var(--slop); }
      .dim-text strong { color: var(--text-dim); }
      .dim-list { list-style: none; padding: 0; margin: 0; display: grid; gap: 4px; font-size: 13px; }
      .dim-list code { font-family: var(--mono); color: var(--text-dim); }
      .hour-chart { display: grid; grid-template-columns: repeat(24, 1fr); gap: 2px; align-items: end; height: 60px; }
      .hour-col { display: flex; flex-direction: column; align-items: center; }
      .hour-bar { width: 100%; background: var(--accent); border-radius: 2px 2px 0 0; min-height: 1px; }
      .hour-label { font-size: 8px; color: var(--text-dim); font-family: var(--mono); margin-top: 2px; }
    `;
    document.head.appendChild(s);
  }

  return { refreshCompact, renderDetail };
})();
