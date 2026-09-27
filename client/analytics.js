// Cue's local shopping journal, shared by the live overlay and full-page view.
const escapeHTML = value => String(value ?? "").replace(/[&<>"']/g, ch =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
const number = value => new Intl.NumberFormat().format(Number(value) || 0);
const money = cents => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" })
  .format((Number(cents) || 0) / 100);

export function analyticsCommand(text, isOpen) {
  if (isOpen && /\bclose\b/i.test(text)) return "close";
  if (/\banalytics\b/i.test(text)) return "open";
  return null;
}

// The Cue mark, static: same geometry as the live avatar in client/avatar.js,
// at rest. Brand continuity — this is the one glyph a shopper already
// associates with Cue, not a generic chart icon invented for this page. The
// dot carries a class so the hero's larger mark can give it a single glance
// on load (client/analytics.css); the small wordmark instance ignores it.
const MARK = `<svg viewBox="0 0 120 120" role="img" aria-label="Cue">
  <defs><linearGradient id="cue-ia-tile" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2a2a2a"/><stop offset="1" stop-color="#1a1a1a"/>
  </linearGradient></defs>
  <rect x="6" y="6" width="108" height="108" rx="30" fill="url(#cue-ia-tile)"/>
  <rect x="6.5" y="6.5" width="107" height="107" rx="29.5" fill="none" stroke="#fff" stroke-opacity=".07"/>
  <path d="M88.37 37.83 A36 36 0 1 0 88.37 82.17" fill="none" stroke="#f4f3ef" stroke-width="6"/>
  <path d="M60.32 47.14 A20 20 0 1 0 60.32 72.86" fill="none" stroke="#f4f3ef" stroke-width="5.4"/>
  <circle class="cue-analytics-eye" cx="72" cy="60" r="6.8" fill="#5c8dff"/>
</svg>`;

const DOT_KIND = { search: "search", cart_add: "add", add_request: "add", purchase: "purchase" };

export function dashboardHTML(data, { hasExport = false } = {}) {
  const totals = data.totals || {};
  const searches = data.top_searches || [];
  const added = data.top_added || [];
  const purchased = data.top_purchased || [];
  const daily = data.daily || [];
  const recent = data.recent || [];
  const insight = data.insight || {};
  const dayPeak = Math.max(1, ...daily.map(day => (day.searches || 0) + (day.adds || 0)));
  const searchPeak = Math.max(1, ...searches.map(row => row.count));

  const interestRows = searches.length
    ? searches.map((item, index) => `<li class="cue-analytics-interest">
        <span class="cue-analytics-interest-rank">${String(index + 1).padStart(2, "0")}</span>
        <span class="cue-analytics-interest-name" style="--share:${Math.max(8, item.count / searchPeak * 100)}%">${escapeHTML(item.label)}</span>
        <span class="cue-analytics-interest-count">${number(item.count)}</span>
      </li>`).join("")
    : `<li class="cue-analytics-empty">Your search themes will appear here as you shop with Cue.</li>`;

  const weekCells = daily.map(day => {
    const total = (day.searches || 0) + (day.adds || 0);
    const ratio = total / dayPeak;
    const weekday = new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "narrow" });
    return `<div class="cue-analytics-week-day" title="${escapeHTML(day.date)}: ${number(total)} actions">
      <span class="cue-analytics-week-track"><i style="height:${total ? Math.max(14, ratio * 100) : 4}%;opacity:${total ? Math.max(.4, ratio) : .18}"></i></span>
      <span class="cue-analytics-week-label">${escapeHTML(weekday)}</span></div>`;
  }).join("");

  const recentRows = recent.length ? recent.map(item => {
    const kind = DOT_KIND[item.kind] || "add";
    const verb = item.kind === "search" ? "Searched" : item.kind === "purchase" ? "Purchased"
      : item.kind === "cart_add" ? "Added" : "Asked to add";
    const time = new Date(item.at);
    const stamp = Number.isNaN(time.getTime()) ? "" : time.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return `<li><i class="cue-analytics-dot cue-analytics-dot-${kind}"></i>
      <span class="cue-analytics-verb">${escapeHTML(verb)}</span>
      <span class="cue-analytics-noun">${escapeHTML(item.label || "Item")}</span>
      <time>${escapeHTML(stamp)}</time></li>`;
  }).join("") : `<li class="cue-analytics-empty">No activity yet. Ask Cue to find something you like.</li>`;

  const itemRows = (items, empty) => items.length
    ? items.map(item => `<li><span>${escapeHTML(item.label)}</span><b>&times;${number(item.count)}</b></li>`).join("")
    : `<li class="cue-analytics-empty">${escapeHTML(empty)}</li>`;

  const orderWord = totals.orders === 1 ? "order" : "orders";
  const spendNote = totals.orders
    ? ` ${money(totals.demo_spend_cents)} across ${number(totals.orders)} demo ${escapeHTML(orderWord)} — no real charges.`
    : "";

  return `<div class="cue-analytics-shell">
    <header class="cue-analytics-top"><div class="cue-analytics-top-inner">
      <div class="cue-analytics-brand"><span class="cue-analytics-mark" aria-hidden="true">${MARK}</span>
        <div class="cue-analytics-word"><b>Cue</b><span>Insights</span></div></div>
      <div class="cue-analytics-top-actions">
        <span class="cue-analytics-local"><i></i>Stored in your browser</span>
        <button class="cue-analytics-close" type="button" aria-label="Close analytics">Done</button>
      </div>
    </div></header>
    <main class="cue-analytics-main">

      <section class="cue-analytics-hero">
        <span class="cue-analytics-hero-mark" aria-hidden="true">${MARK}</span>
        <div class="cue-analytics-hero-text">
          <p class="cue-analytics-hero-tag">Cue noticed</p>
          <h1>${escapeHTML(insight.title || "Your patterns will appear here")}</h1>
          <p class="cue-analytics-hero-body">${escapeHTML(insight.body || "Search and shop with Cue to see the interests you return to.")}</p>
          <p class="cue-analytics-stat"><strong>${number(totals.searches)}</strong> searches,
            <strong>${number(totals.confirmed_adds)}</strong> added to your bag, and
            <strong>${number(totals.orders)}</strong> ${escapeHTML(orderWord)} placed.</p>
        </div>
      </section>

      <div class="cue-analytics-sections">
        <section class="cue-analytics-section">
          <div class="cue-analytics-section-head"><h2>What you look for</h2><span>Most searched</span></div>
          <ol class="cue-analytics-group cue-analytics-interests">${interestRows}</ol>
        </section>

        <section class="cue-analytics-section">
          <div class="cue-analytics-section-head"><h2>Your rhythm this week</h2></div>
          <div class="cue-analytics-group cue-analytics-week" role="img" aria-label="Shopping activity over the last seven days">${weekCells}</div>
        </section>

        <section class="cue-analytics-section">
          <div class="cue-analytics-section-head"><h2>Added to bag</h2></div>
          <ol class="cue-analytics-group cue-analytics-items">${itemRows(added, "Items you add to the demo store bag will appear here.")}</ol>
        </section>

        <section class="cue-analytics-section">
          <div class="cue-analytics-section-head"><h2>Checked out</h2></div>
          <ol class="cue-analytics-group cue-analytics-items">${itemRows(purchased, "Items from approved demo checkouts will appear here.")}</ol>
        </section>

        <section class="cue-analytics-section">
          <div class="cue-analytics-section-head"><h2>Recent activity</h2><span>Latest first</span></div>
          <ol class="cue-analytics-group cue-analytics-activity">${recentRows}</ol>
        </section>
      </div>

      <footer class="cue-analytics-footer">
        <span>Nothing here leaves your browser.${spendNote}</span>
        ${hasExport ? `<button class="cue-analytics-export" type="button">Download CSV</button>` : ""}
      </footer>
    </main>
  </div>`;
}

export function createAnalytics({ request, onExport }) {
  let panel = null;
  let previousFocus = null;
  let opening = 0;
  function close() {
    opening++;
    panel?.remove();
    panel = null;
    previousFocus?.focus?.();
    previousFocus = null;
  }
  async function open() {
    if (panel) { panel.querySelector(".cue-analytics-close")?.focus(); return; }
    const root = document.getElementById("aura-root");
    if (!root) return;
    const token = ++opening;
    previousFocus = document.activeElement;
    panel = document.createElement("div");
    panel.className = "cue-analytics";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-modal", "true");
    panel.setAttribute("aria-label", "Cue shopping analytics");
    panel.innerHTML = `<div class="cue-analytics-loading" role="status"><span class="cue-analytics-spinner" aria-hidden="true"></span>Gathering your insights&hellip;</div>`;
    root.append(panel);
    panel.addEventListener("click", event => {
      if (event.target.closest(".cue-analytics-close")) close();
      if (event.target.closest(".cue-analytics-export")) {
        void onExport().catch(error => console.warn("[cue] Could not export analytics:", error));
      }
    });
    panel.addEventListener("keydown", event => {
      if (event.key !== "Tab") return;
      const focusable = [...panel.querySelectorAll('button:not([disabled]),a[href]')];
      if (!focusable.length) { event.preventDefault(); return; }
      if (event.shiftKey && document.activeElement === focusable[0]) {
        event.preventDefault(); focusable.at(-1).focus();
      } else if (!event.shiftKey && document.activeElement === focusable.at(-1)) {
        event.preventDefault(); focusable[0].focus();
      }
    });
    try {
      const data = await request("summary");
      if (token !== opening || !panel) return;
      panel.innerHTML = dashboardHTML(data, { hasExport: Boolean(onExport) });
      panel.querySelector(".cue-analytics-close")?.focus();
    } catch (error) {
      if (token !== opening || !panel) return;
      panel.innerHTML = `<div class="cue-analytics-loading" role="alert">Could not open your browser's shopping journal. <button class="cue-analytics-close" type="button">Close</button></div>`;
    }
  }
  return { open, close, get isOpen() { return Boolean(panel); } };
}
