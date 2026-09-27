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

export function dashboardHTML(data, { hasExport = false } = {}) {
  const totals = data.totals || {};
  const searches = data.top_searches || [];
  const added = data.top_added || [];
  const purchased = data.top_purchased || [];
  const daily = data.daily || [];
  const recent = data.recent || [];
  const peak = Math.max(1, ...daily.map(day => (day.searches || 0) + (day.adds || 0)));
  const searchPeak = Math.max(1, ...searches.map(row => row.count));
  const row = (label, value, detail) => `<div class="cue-analytics-metric"><span>${escapeHTML(label)}</span><strong>${escapeHTML(value)}</strong><small>${escapeHTML(detail)}</small></div>`;
  const searchRows = searches.length ? searches.map((item, index) => `<div class="cue-analytics-term"><span class="cue-analytics-rank">${String(index + 1).padStart(2, "0")}</span><span class="cue-analytics-term-name">${escapeHTML(item.label)}</span><span class="cue-analytics-term-bar"><i style="width:${Math.max(6, item.count / searchPeak * 100)}%"></i></span><b>${number(item.count)}</b></div>`).join("")
    : `<p class="cue-analytics-empty">Your search themes will appear here as you shop with Cue.</p>`;
  const days = daily.map(day => {
    const total = (day.searches || 0) + (day.adds || 0);
    const height = total ? Math.max(8, total / peak * 100) : 2;
    return `<div class="cue-analytics-day" title="${escapeHTML(day.date)}: ${number(total)} actions"><div class="cue-analytics-column"><i style="height:${height}%"></i></div><span>${escapeHTML(new Date(`${day.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short" }))}</span></div>`;
  }).join("");
  const events = recent.length ? recent.map(item => {
    const label = item.kind === "search" ? "Searched" : item.kind === "cart_add" ? "Added" : item.kind === "purchase" ? "Purchased" : "Requested add";
    const time = new Date(item.at);
    return `<li><span class="cue-analytics-event-icon" aria-hidden="true">${item.kind === "search" ? "⌕" : item.kind === "purchase" ? "✓" : "+"}</span><div><b>${escapeHTML(label)}</b><span>${escapeHTML(item.label || "Item")}</span><small>${escapeHTML(item.site || "")}</small></div><time>${escapeHTML(Number.isNaN(time.getTime()) ? "" : time.toLocaleDateString("en-US", { month: "short", day: "numeric" }))}</time></li>`;
  }).join("") : `<li class="cue-analytics-empty">No activity yet. Ask Cue to find something you like.</li>`;
  const itemList = (items, empty) => items.length ? `<ol class="cue-analytics-items">${items.map(item =>
    `<li><span>${escapeHTML(item.label)}</span><b>× ${number(item.count)}</b></li>`).join("")}</ol>`
    : `<p class="cue-analytics-empty">${escapeHTML(empty)}</p>`;
  return `<div class="cue-analytics-shell">
    <header class="cue-analytics-top"><div class="cue-analytics-brand"><span class="cue-analytics-symbol" aria-hidden="true"><svg viewBox="0 0 40 40" fill="none"><path d="M28.2 9.1A15 15 0 1 0 28.2 30.9M24.1 15.6A8 8 0 1 0 24.1 24.4" stroke="currentColor" stroke-width="2.8" stroke-linecap="square"/><circle cx="25" cy="20" r="2.5" fill="currentColor"/></svg></span><span>Cue <i>/</i> Insights</span></div><div class="cue-analytics-top-actions"><span class="cue-analytics-local"><i></i> Stored in your browser</span><button class="cue-analytics-close" type="button" aria-label="Close analytics">Close <span>×</span></button></div></header>
    <main class="cue-analytics-main"><div class="cue-analytics-intro"><div><p class="cue-analytics-eyebrow">YOUR SHOPPING, IN FOCUS</p><h1>What catches<br><em>your eye.</em></h1><p>A quieter look at the things you return to, add, and choose.</p></div><span class="cue-analytics-index">01 — Personal insights</span></div>
    <section class="cue-analytics-metrics" aria-label="Shopping totals">${row("Searches", number(totals.searches), "Ideas explored")}${row("Added to bag", number(totals.confirmed_adds), "Confirmed additions")}${row("Demo orders", number(totals.orders), "Approved checkouts")}${row("Demo spend", money(totals.demo_spend_cents), "No real charges")}</section>
    <div class="cue-analytics-grid"><section class="cue-analytics-card cue-analytics-searches"><div class="cue-analytics-card-head"><div><p>01 / INTEREST</p><h2>What you look for</h2></div><span>Most searched</span></div>${searchRows}</section>
    <section class="cue-analytics-card cue-analytics-week"><div class="cue-analytics-card-head"><div><p>02 / RHYTHM</p><h2>Last seven days</h2></div><span>Searches + adds</span></div><div class="cue-analytics-bars" role="img" aria-label="Shopping activity over the last seven days">${days}</div></section>
    <section class="cue-analytics-card cue-analytics-insight"><p>03 / CUE NOTICED</p><span class="cue-analytics-spark" aria-hidden="true">✳</span><h2>${escapeHTML(data.insight?.title || "Your patterns will appear here")}</h2><p>${escapeHTML(data.insight?.body || "Search and shop with Cue to see your interests.")}</p></section>
    <section class="cue-analytics-card cue-analytics-activity"><div class="cue-analytics-card-head"><div><p>04 / ACTIVITY</p><h2>Recent moments</h2></div><span>Latest first</span></div><ol>${events}</ol></section>
    <section class="cue-analytics-card cue-analytics-items-card"><div class="cue-analytics-card-head"><div><p>05 / CONSIDERED</p><h2>Added to bag</h2></div><span>Confirmed · demo store</span></div>${itemList(added, "Items you add to the demo store bag will appear here.")}</section>
    <section class="cue-analytics-card cue-analytics-items-card"><div class="cue-analytics-card-head"><div><p>06 / CHOSEN</p><h2>Checked out</h2></div><span>Approved demo orders</span></div>${itemList(purchased, "Items from approved demo checkouts will appear here.")}</section></div>
    <footer class="cue-analytics-footer"><span>Your activity stays in this browser. Download a CSV whenever you want a file.</span>${hasExport ? `<button class="cue-analytics-export" type="button">Download CSV <span>↗</span></button>` : ""}</footer></main></div>`;
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
    panel.innerHTML = `<div class="cue-analytics-loading" role="status">Gathering your insights…</div>`;
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
