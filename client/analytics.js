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
// at rest. It is the one glyph a shopper already associates with Cue.
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

// ── The dashboard ───────────────────────────────────────────────────────────
// One idea per region, read top to bottom: what Cue noticed, the four numbers,
// what you look for, when you shop, how interest became intent, and what just
// happened. Colour follows the entity everywhere (validated palette, see
// analytics.css): searched = blue, added = orange, bought = ink. Text never
// wears a series colour; a dot or bar beside it carries the identity.

const KIND = {
  search: { verb: "Searched", tone: "search" },
  cart_add: { verb: "Added", tone: "add" },
  add_request: { verb: "Asked to add", tone: "add" },
  purchase: { verb: "Bought", tone: "buy" },
};

const cap = (text) => String(text || "").replace(/^\s*\w/, (c) => c.toUpperCase());
const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0);

function relativeDay(iso, now = new Date()) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const mins = Math.round((now - t) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24 && t.getDate() === now.getDate()) return `${hours} hr ago`;
  const y = new Date(now); y.setDate(y.getDate() - 1);
  if (t.toDateString() === y.toDateString()) return "Yesterday";
  return t.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// A 7-point trend line for a figure. Drawn in the series colour, 2px, with the
// last value marked; purely a shape cue, so it is hidden from screen readers.
function spark(values, tone) {
  const max = Math.max(1, ...values);
  const w = 96, h = 28, step = w / Math.max(1, values.length - 1);
  const pts = values.map((v, i) => [i * step, h - 3 - (v / max) * (h - 8)]);
  const d = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  const [lx, ly] = pts.at(-1) ?? [0, h - 3];
  return `<svg class="ci-spark ci-${tone}" viewBox="0 0 ${w} ${h}" aria-hidden="true" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    <circle cx="${lx.toFixed(1)}" cy="${ly.toFixed(1)}" r="3" fill="currentColor"/></svg>`;
}

export function dashboardHTML(data, { hasExport = false } = {}) {
  const totals = data.totals || {};
  const searches = data.top_searches || [];
  const added = data.top_added || [];
  const purchased = data.top_purchased || [];
  const daily = data.daily || [];
  const recent = data.recent || [];
  const insight = data.insight || {};
  const now = new Date();

  // Headline: say the pattern in a sentence, from the data, not a label.
  const lead = searches[0];
  const headline = lead?.count >= 2 ? `${cap(lead.label)} keeps coming up.`
    : added[0] ? `${cap(added[0].label)} made it to your bag.`
    : "Shop with Cue and your patterns show up here.";
  const lede = insight.body || "Search, ask about things and add to your bag by voice. Cue keeps the journal; you keep the data.";

  // ── The four numbers ───────────────────────────────────────────────────
  const orderWord = totals.orders === 1 ? "order" : "orders";
  const itemsWord = totals.items_purchased === 1 ? "item" : "items";
  const figures = [
    { label: "Searches", value: number(totals.searches), note: "this week",
      trend: spark(daily.map((d) => d.searches || 0), "search") },
    { label: "Added to bag", value: number(totals.confirmed_adds),
      note: totals.add_requests ? `${number(totals.add_requests)} more asked about` : "confirmed by voice",
      trend: spark(daily.map((d) => d.adds || 0), "add") },
    { label: "Orders", value: number(totals.orders), note: `${number(totals.items_purchased)} ${itemsWord} checked out`, trend: "" },
    { label: "Demo spend", value: money(totals.demo_spend_cents), note: "no real charges", trend: "" },
  ].map((f) => `<div class="ci-figure">
      <span class="ci-figure-label">${escapeHTML(f.label)}</span>
      <span class="ci-figure-value">${escapeHTML(f.value)}</span>
      <span class="ci-figure-foot"><span>${escapeHTML(f.note)}</span>${f.trend}</span>
    </div>`).join("");

  // ── What you look for: ranked bars, one series ─────────────────────────
  const searchPeak = Math.max(1, ...searches.map((row) => row.count));
  const interest = searches.length ? searches.map((row) => {
    const w = Math.max(3, (row.count / searchPeak) * 100);
    const times = row.count === 1 ? "once" : `${number(row.count)} times`;
    return `<li class="ci-rank" data-tip="${escapeHTML(row.label)}: searched ${times}">
        <span class="ci-rank-label">${escapeHTML(row.label)}</span>
        <span class="ci-rank-track"><i class="ci-search" style="--w:${w.toFixed(1)}%"></i></span>
        <span class="ci-rank-value">${number(row.count)}</span>
      </li>`;
  }).join("") : `<li class="ci-empty">Your search themes will appear here as you shop with Cue.</li>`;

  // ── This week: stacked columns, searched under added ───────────────────
  const dayPeak = Math.max(1, ...daily.map((d) => (d.searches || 0) + (d.adds || 0)));
  const todayKey = daily.at(-1)?.date;
  const week = daily.map((d) => {
    const s = d.searches || 0, a = d.adds || 0, date = new Date(`${d.date}T12:00:00`);
    const long = date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
    const tip = `${long}: ${number(s)} ${s === 1 ? "search" : "searches"}, ${number(a)} added`;
    return `<div class="ci-day${d.date === todayKey ? " ci-today" : ""}" data-tip="${escapeHTML(tip)}">
        <span class="ci-col">
          ${a ? `<i class="ci-add" style="--h:${((a / dayPeak) * 100).toFixed(1)}%"></i>` : ""}
          ${s ? `<i class="ci-search" style="--h:${((s / dayPeak) * 100).toFixed(1)}%"></i>` : ""}
        </span>
        <span class="ci-day-label">${escapeHTML(date.toLocaleDateString("en-US", { weekday: "short" }))}</span>
      </div>`;
  }).join("");
  const weekTotal = daily.reduce((n, d) => n + (d.searches || 0) + (d.adds || 0), 0);

  // ── From interest to intent: a three-step funnel ────────────────────────
  const steps = [
    { label: "Searched", value: totals.searches || 0, tone: "search" },
    { label: "Added to bag", value: totals.confirmed_adds || 0, tone: "add" },
    { label: "Bought", value: totals.items_purchased || 0, tone: "buy" },
  ];
  const funnelTop = Math.max(1, steps[0].value);
  const funnel = steps.map((st, i) => {
    const rate = i === 0 ? "" : `<span class="ci-rate">${pct(st.value, steps[i - 1].value)}% of ${escapeHTML(steps[i - 1].label.toLowerCase())}</span>`;
    return `<li class="ci-step">
        <span class="ci-step-head"><span class="ci-step-label"><i class="ci-key ci-${st.tone}"></i>${escapeHTML(st.label)}</span>
          <b>${number(st.value)}</b></span>
        <span class="ci-step-track"><i class="ci-${st.tone}" style="--w:${Math.max(st.value ? 2 : 0, (st.value / funnelTop) * 100).toFixed(1)}%"></i></span>
        ${rate}
      </li>`;
  }).join("");

  // ── Items ───────────────────────────────────────────────────────────────
  const items = (rows, empty) => rows.length ? rows.map((row) => `<li>
      <span>${escapeHTML(row.label)}</span><b>${row.count > 1 ? `&times;${number(row.count)}` : "1"}</b></li>`).join("")
    : `<li class="ci-empty">${escapeHTML(empty)}</li>`;

  // ── Recent activity ─────────────────────────────────────────────────────
  const activity = recent.length ? recent.map((row) => {
    const k = KIND[row.kind] || KIND.cart_add;
    return `<li class="ci-event">
        <i class="ci-key ci-${k.tone}"></i>
        <span class="ci-event-text"><span class="ci-verb">${escapeHTML(k.verb)}</span> ${escapeHTML(row.label || "an item")}</span>
        <time datetime="${escapeHTML(row.at || "")}">${escapeHTML(relativeDay(row.at, now))}</time>
      </li>`;
  }).join("") : `<li class="ci-empty">No activity yet. Ask Cue to find something you like.</li>`;

  const spendNote = totals.orders
    ? ` ${money(totals.demo_spend_cents)} across ${number(totals.orders)} demo ${escapeHTML(orderWord)}, no real charges.`
    : "";

  return `<div class="cue-analytics-shell ci">
    <header class="ci-top"><div class="ci-top-inner">
      <div class="ci-brand"><span class="ci-mark" aria-hidden="true">${MARK}</span>
        <span class="ci-word"><b>Cue</b><span>Insights</span></span></div>
      <div class="ci-top-actions">
        <span class="ci-local"><i aria-hidden="true"></i>Stored in your browser</span>
        <button class="cue-analytics-close ci-done" type="button" aria-label="Close analytics">Done</button>
      </div>
    </div></header>

    <main class="ci-main">
      <section class="ci-hero">
        <p class="ci-period">Your last seven days with Cue</p>
        <h1>${escapeHTML(headline)}</h1>
        <p class="ci-lede">${escapeHTML(lede)}</p>
      </section>

      <section class="ci-figures" aria-label="Totals">${figures}</section>

      <div class="ci-grid">
        <section class="ci-card ci-span-7">
          <header class="ci-card-head"><h2>What you look for</h2><span>Most searched</span></header>
          <ol class="ci-ranks">${interest}</ol>
        </section>

        <section class="ci-card ci-span-5">
          <header class="ci-card-head"><h2>This week</h2>
            <span class="ci-legend"><span><i class="ci-key ci-search"></i>Searched</span><span><i class="ci-key ci-add"></i>Added</span></span>
          </header>
          <div class="ci-week" role="img" aria-label="Activity over the last seven days: ${number(weekTotal)} actions">${week}</div>
        </section>

        <section class="ci-card ci-span-5">
          <header class="ci-card-head"><h2>From interest to intent</h2></header>
          <ol class="ci-funnel">${funnel}</ol>
        </section>

        <section class="ci-card ci-span-7 ci-pair">
          <div>
            <header class="ci-card-head"><h2>Added to bag</h2></header>
            <ol class="ci-items">${items(added, "Items you add to the demo store bag will appear here.")}</ol>
          </div>
          <div>
            <header class="ci-card-head"><h2>Checked out</h2></header>
            <ol class="ci-items">${items(purchased, "Items from approved demo checkouts will appear here.")}</ol>
          </div>
        </section>

        <section class="ci-card ci-span-12">
          <header class="ci-card-head"><h2>Recent activity</h2><span>Latest first</span></header>
          <ol class="ci-activity">${activity}</ol>
        </section>
      </div>

      <footer class="ci-foot">
        <span>Nothing here leaves your browser.${spendNote}</span>
        ${hasExport ? `<button class="cue-analytics-export ci-export" type="button">Download CSV</button>` : ""}
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
