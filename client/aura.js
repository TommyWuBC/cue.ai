import { bus } from "./bus.js";
import * as gaze from "./gaze.js";
import * as voice from "./voice.js";
import { scan, scanAll, nth, invalidate, controls, controlName, findControl, fields, findField, setText,
  findText, COMMITS_MONEY, findOption, searchBox, submitField, clickables } from "./resolver.js";
import { correctUtterance, isWakeOnly, norm } from "./speech.js";
import { CONFIG, url } from "./config.js";
import { productMemory } from "./product-memory.js";
import { playSplash } from "./splash.js";
import { matchCandidates, matchOptions, missingChoices, optionPrompt } from "./intent.js";
import { shopperStore } from "./shopper.js";
import { crawlNear, matchPage, pageText } from "./site.js";
import { createDetails } from "./details.js";
import { createKnowledge } from "./knowledge.js";
import { parseSearch, amazonSearchUrl, describeFilters } from "./search.js";
import { analyticsCommand, createAnalytics } from "./analytics.js";
import { createCompare } from "./compare.js";
import { analyticsRequest as browserAnalyticsRequest, downloadAnalyticsCSV } from "./analytics-transport.js";

const analyticsRequest = (kind, event = null) =>
  browserAnalyticsRequest(kind, event, { injected: CONFIG.injected });

const analytics = createAnalytics({ request: analyticsRequest,
  onExport: async () => downloadAnalyticsCSV(await analyticsRequest("export")) });
// Both products' own pages are read before the panel opens, so the comparison
// is made of page facts rather than listing titles.
const compare = createCompare({
  request: async (a, b) => {
    await details.ensure([a.url, b.url].filter(Boolean), 4000);
    const side = (p) => ({ title: p.title, price: p.price,
      facts: details.peek(p.url) || knowledge.factsFor(p.url) });
    const res = await fetch(url("/compare"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: side(a), b: side(b), owns: await recentPurchases() }),
    });
    if (!res.ok) throw new Error(`compare ${res.status}`);
    return res.json();
  },
  onAdd: (pick) => {
    const item = comparing[pick];
    if (!item) return;
    discussed = briefProduct(item) ?? discussed;
    persistShopper();
    pinDiscussed();
    perform("add_to_cart", {}, { narrated: false });
  },
});
let comparing = { a: null, b: null };

/**
 * Demo history. Call window.cue.seedDemo() from the console before a run: it
 * writes one clearly-marked purchase so the ecosystem line has something to
 * connect to. Nothing seeds itself — invented purchase history that appears
 * unbidden is indistinguishable from a real order in the same journal.
 */
async function seedDemo(title = "Apple iPhone 17 Pro", daysAgo = 7) {
  const when = new Date(Date.now() - daysAgo * 864e5).toISOString();
  await analyticsRequest("event", {
    event_id: crypto.randomUUID(), kind: "purchase", site: "demo.seed",
    product_title: title, order_id: `DEMO-SEED-${daysAgo}d`,
    order_total_cents: 129900, timestamp: when,
  });
  console.log(`[cue] seeded a demo purchase: ${title} (${daysAgo}d ago)`);
  return title;
}

/** What this browser already bought, for the line about staying in one ecosystem. */
async function recentPurchases() {
  try {
    const summary = await analyticsRequest("summary");
    // summarizeActivity's ranked() returns {label, count}. Reading .value here
    // meant owns was always empty, so the ecosystem line never had anything to
    // connect to and came back "" every time.
    const items = summary?.top_purchased ?? [];
    return items.map((p) => (typeof p === "string" ? p : p?.label))
      .filter(Boolean).slice(0, 6);
  } catch { return []; }
}

function recordActivity(kind, fields) {
  if (globalThis.__cueEnded) return Promise.resolve();
  return analyticsRequest("event", {
    event_id: crypto.randomUUID(), kind, site: location.hostname, ...fields,
  }).catch(error => console.warn("[cue] Could not save shopping activity:", error));
}

let pendingSearch = null;
function recordSearch(query, source = "route") {
  const clean = String(query || "").trim().slice(0, 120);
  if (!clean) return Promise.resolve();
  const now = Date.now();
  if (source !== "voice" && pendingSearch?.query === clean.toLowerCase() &&
      now - pendingSearch.at < 30000 &&
      (pendingSearch.source === "voice" || (pendingSearch.source === "submit" && source === "route"))) {
    if (source === "route") pendingSearch = null;
    return Promise.resolve();
  }
  pendingSearch = { query: clean.toLowerCase(), source, at: now };
  return recordActivity("search", { query: clean });
}

document.addEventListener("submit", event => {
  const field = event.target?.querySelector?.('input[type="search"],input[name="q"],input[name="k"]');
  if (field && !event.target.closest("#aura-root")) void recordSearch(field.value, "submit");
}, true);
document.addEventListener("routechange", () => {
  if (location.pathname === "/search") void recordSearch(new URLSearchParams(location.search).get("q"));
});
document.addEventListener("cue:cart-added", ({ detail }) => {
  if (!window.cue || globalThis.__cueEnded) return;
  void recordActivity("cart_add", {
    product_id: detail.id, product_title: detail.title, size: detail.size,
    color: detail.color, price_cents: detail.price_cents,
  });
});
document.addEventListener("cue:order-approved", ({ detail }) => {
  if (!window.cue || globalThis.__cueEnded) return;
  (detail.items || []).forEach((item, index) => {
    void recordActivity("purchase", {
      event_id: `purchase:${detail.order_id}:${index}`,
      product_id: item.id, product_title: item.title, size: item.size, color: item.color,
      price_cents: item.unit_price_cents, order_id: detail.order_id,
      order_total_cents: detail.total_cents,
    });
  });
});
document.addEventListener("click", event => {
  if (!CONFIG.injected || globalThis.__cueEnded) return;
  const button = event.target?.closest?.('button,input[type="submit"],[role="button"]');
  if (!button || button.closest("#aura-root") ||
      !/\badd\s+to\s+(?:cart|bag)\b/i.test(controlName(button))) return;
  const card = button.closest("[data-cue-product],[data-aura-product]");
  const product = productData(card) || discussed || {};
  void recordActivity("add_request", {
    product_id: product.id || "", product_title: product.title || "Item",
    size: stated.size || "", color: stated.color || "",
    price_cents: Number.isFinite(product.price) ? Math.round(product.price * 100) : null,
  });
}, true);
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && analytics.isOpen) { event.preventDefault(); analytics.close(); }
});

let memoryStorage;
try { memoryStorage = CONFIG.injected ? window.CUE_MEMORY_STORAGE : sessionStorage; } catch {}
const comparisons = productMemory({ storage: memoryStorage });
const shopper = shopperStore(memoryStorage);
const remembered = shopper.load();

// The product the shopper is talking about. Looking somewhere else does not
// change it, and size or add questions are about this card, not the gaze card.
let discussed = remembered.discussed;
let voiceNamed = false;
let lookedThisTurn = null;
// Size and color count only when the shopper says them. The card's default
// color is pressed already, and that is not a choice.
let stated = { id: remembered.discussed?.id ?? null, size: remembered.size, color: remembered.color };

function persistShopper() {
  shopper.save({ discussed, size: stated.size, color: stated.color });
}
let site = null;
const details = createDetails();
const knowledge = createKnowledge({ storage: memoryStorage });

// Everything said this visit, by either side, including lines only this page
// speaks ("Which one?"). Kept across page loads so the agent never starts a
// search results page with no idea what was just being discussed.
const CONVO_KEY = "cue.convo.v1";
let convo = [];
try { convo = JSON.parse(memoryStorage?.getItem(CONVO_KEY) || "[]").slice(-24); } catch { convo = []; }
function remember(role, content) {
  const line = String(content || "").trim().slice(0, 400);
  if (!line) return;
  if (convo.length && convo[convo.length - 1].role === role && convo[convo.length - 1].content === line) return;
  convo.push({ role, content: line });
  convo = convo.slice(-24);
  try { memoryStorage?.setItem(CONVO_KEY, JSON.stringify(convo)); } catch {}
}

function learnPage() {
  const items = scanAll();
  knowledge.observe(items.map((t) => ({ product: t.product, el: t.el })));
}
// Bumped by hand when the client changes, so the server log shows which build is running.
const CLIENT_BUILD = "2026-09-27 voices";

const PRODUCT_VERBS = new Set(["add_to_cart", "select_variant", "select_color"]);

function briefProduct(product) {
  if (!product?.id || !product.title) return null;
  return { id: product.id, title: product.title, price: product.price, url: product.url };
}

function productTarget(id) {
  return scan().find((t) => t.kind === "product" && t.id === id) ?? null;
}

// Prefer a visible search box. Northfield's header field still works when the
// layout has collapsed it, so a spoken search does not depend on the cursor.
function findSearchField() {
  const visible = (el) => {
    if (!el || el.disabled || el.closest?.("#aura-root")) return false;
    const r = el.getBoundingClientRect();
    return r.width > 8 && r.height > 8;
  };
  const nodes = document.querySelectorAll(
    'input[type="search"], form[role="search"] input:not([type="hidden"]), input[name="q"], input[name="k"], input[aria-label*="search" i], input[placeholder*="search" i]');
  for (const el of nodes) if (visible(el)) return el;
  return document.querySelector("#search, form[role='search'] input");
}

function searchOpener() {
  const list = controls();
  const name = (c) => c.name.toLowerCase();
  return list.find((c) => name(c) === "search")
      || list.find((c) => /^search\b/.test(name(c)) && name(c).length < 32)
      || null;
}

function waitForSearch(ms) {
  return new Promise((resolve) => {
    const start = performance.now();
    const tick = () => {
      const field = findSearchField();
      if (field) return resolve(field);
      if (performance.now() - start > ms) return resolve(null);
      setTimeout(tick, 120);
    };
    tick();
  });
}

function writeField(field, q) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter) setter.call(field, q);
  else field.value = q;
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.dispatchEvent(new Event("change", { bubbles: true }));
}

async function runSearch(q, narrated = false) {
  // Filters said out loud ("under a hundred dollars", "four stars", "cheapest
  // first") are applied by the shop itself where we know how; otherwise they
  // stay in the search words.
  if (CONFIG.injected) {
    const parsed = parseSearch(q);
    const target = amazonSearchUrl(parsed, location.href);
    if (target) {
      const applied = describeFilters(parsed);
      await recordSearch(parsed.q, "voice");
      discussed = null;
      stated = { id: null, size: null, color: null };
      persistShopper();
      const go = () => location.assign(target);
      if (narrated) go();
      else sayThen(`Searching for ${parsed.q}${applied ? `, ${applied}` : ""}.`, go);
      return;
    }
  }
  let field = findSearchField();
  if (!field) {
    const opener = searchOpener();
    if (!opener) {
      bus.emit("SAY", { text: "I don't see a search bar or a search button on this page." });
      return;
    }
    await sayAndWait("Opening search.");
    opener.el.click();
    field = await waitForSearch(1600);
  }
  if (!field) {
    bus.emit("SAY", { text: "I opened search, but I can't find a field to type in." });
    return;
  }
  field.focus();
  writeField(field, q);
  await recordSearch(q, "voice");
  discussed = null;
  stated = { id: null, size: null, color: null };
  invalidate();
  persistShopper();
  // Submitting reloads the page, so the sentence has to land first.
  await sayAndWait(`Searching for ${q}.`);
  if (globalThis.__cueEnded) return;
  const form = field.form;
  if (form?.requestSubmit) form.requestSubmit();
  else field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true }));
  setTimeout(() => {
    if (globalThis.__cueEnded) return;
    const found = scan().filter((t) => t.kind === "product");
    if (!found.length) return;
    const names = found.slice(0, 3).map((t) => String(t.label || "").slice(0, 60)).filter(Boolean).join(". ");
    bus.emit("SAY", { text: names ? `${found.length} results. ${names}.` : `${found.length} results.` });
  }, 700);
}


// ── Overlay chrome ──────────────────────────────────────────────────────────
const ui = {};
function mountUI() {
  const root = document.createElement("div");
  root.id = "aura-root";
  root.innerHTML = `
    <div class="aura-reticle"></div>
    <div class="aura-outline"><span class="aura-outline-label"></span></div>
    <div class="aura-hud">
      <div class="aura-hud-row"><b>Cue</b><span class="aura-status"><span class="aura-dot"></span><span class="aura-chip aura-mode"></span></span></div>
      <div class="aura-hud-heard"></div>
      <div class="aura-hud-said" role="status" aria-live="polite" tabindex="0"></div>
      <div class="aura-hud-drift">tracking has drifted · say &ldquo;recalibrate&rdquo;</div>
      <div class="aura-hud-foot">hold <kbd>space</kbd> to talk · say &ldquo;Cue, &hellip;&rdquo;</div>
    </div>
    <div class="aura-quality" role="status" aria-live="polite" hidden>
      <span>Gaze seems uncertain. Say &ldquo;Cue, recalibrate&rdquo; or use the button.</span>
      <button type="button">Recalibrate</button>
    </div>`;
  document.body.appendChild(root);
  ui.reticle = root.querySelector(".aura-reticle");
  ui.outline = root.querySelector(".aura-outline");
  ui.label   = root.querySelector(".aura-outline-label");
  ui.heard   = root.querySelector(".aura-hud-heard");
  ui.said    = root.querySelector(".aura-hud-said");
  ui.mode    = root.querySelector(".aura-mode");
  ui.dot     = root.querySelector(".aura-dot");
  ui.drift   = root.querySelector(".aura-hud-drift");
  ui.foot    = root.querySelector(".aura-hud-foot");
  ui.quality = root.querySelector(".aura-quality");
  ui.quality.querySelector("button").addEventListener("click", () => recalibrate());
}

// Tracking has gone bad enough that focus was dropped. Offer the way out.
bus.on("GAZE_QUALITY", ({ low }) => { if (ui.quality) ui.quality.hidden = !low; });
addEventListener("scroll", () => gaze.refreshFocus(), { passive: true });
addEventListener("resize", () => gaze.refreshFocus());

// ── Render loop ─────────────────────────────────────────────────────────────
// GAZE arrives at ~25Hz and in bursts. Writing transform straight from the
// event gave visible stair-stepping even once the signal itself was clean, so
// the event only ever moves a TARGET and a rAF loop eases the drawn position
// toward it. That loop also keeps the outline glued to its element while the
// page scrolls — a rect captured at FOCUS time goes stale instantly.
const render = {
  x: innerWidth / 2, y: innerHeight / 2,
  tx: innerWidth / 2, ty: innerHeight / 2,
  conf: 0, drawnConf: 0, el: null, kind: null,
};

bus.on("GAZE", ({ x, y, confidence }) => {
  render.tx = x; render.ty = y; render.conf = confidence;
});

const FOLLOW = 0.32;     // per-frame easing toward the target
const now = () => performance.now();
let exited = false;

function frame() {
  if (exited || globalThis.__cueEnded) return;
  render.x += (render.tx - render.x) * FOLLOW;
  render.y += (render.ty - render.y) * FOLLOW;
  render.drawnConf += (render.conf - render.drawnConf) * 0.12;

  if (ui.reticle) {
    ui.reticle.style.transform = `translate3d(${render.x.toFixed(1)}px, ${render.y.toFixed(1)}px, 0)`;
    ui.reticle.style.opacity = (0.25 + render.drawnConf * 0.55).toFixed(3);
    // A wide, soft reticle when the signal is poor reads as honest rather than
    // broken: it shows the user how sure Cue is instead of faking precision.
    const s = 1 + (1 - render.drawnConf) * 0.9;
    ui.reticle.style.setProperty("--aura-reticle-scale", s.toFixed(2));
  }

  if (render.el && ui.outline) {
    const r = render.el.getBoundingClientRect();
    ui.outline.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    ui.outline.style.width  = r.width + "px";
    ui.outline.style.height = r.height + "px";
  }

  edgeScrollTick();
  requestAnimationFrame(frame);
}

// When gaze is too coarse to be trusted, a bold outline on one card is a lie:
// measured at 242px error it highlights the WRONG card two times in three. Below
// the precision bar it is drawn as a guess, and the words carry the interaction.
let precise = true;

bus.on("FOCUS", ({ target }) => {
  if (!target) { render.el = null; ui.outline.classList.remove("on"); return; }
  render.el = target.el;
  ui.outline.classList.add("on");
  ui.outline.dataset.kind = target.kind;
  ui.outline.dataset.guess = String(!precise);
  ui.label.textContent = target.kind === "product"
    ? `${target.product.title} · $${target.product.price}`
    : target.label;
});

// The chip is the one place you can tell, mid-demo, what is actually running.
const chip = { mode: null, stt: null };
function paintChip() {
  const m = { mouse: "mouse", sim: `sim ±${CONFIG.sigma}px`, webgazer: "gaze" }[chip.mode] ?? chip.mode;
  ui.mode.textContent = [m, chip.stt].filter(Boolean).join(" · ");
}

bus.on("STATE", (s) => {
  if (s.mode) { chip.mode = s.mode; paintChip(); }
  if (s.sttProvider) { chip.stt = s.sttProvider; paintChip(); }
  if (s.ptt !== undefined) ui.dot.classList.toggle("hot", s.ptt);
  if (s.listening) ui.dot.classList.add("live");
  if (s.listening === false) ui.dot.classList.remove("live");
  if (s.accuracy) {
    console.log("[cue] gaze accuracy", s.accuracy);
  }
  if (s.precise !== undefined) {
    precise = s.precise;
    ui.outline.dataset.guess = String(!precise);
    ui.foot.innerHTML = precise
      ? 'hold <kbd>space</kbd> to talk · say &ldquo;Cue, &hellip;&rdquo;'
      : 'say what you want · hold <kbd>space</kbd> to talk';
  }
});

bus.on("SAY", ({ text }) => { void sayAndWait(text); });

// Speaking and acting in the wrong order truncates the sentence: a click or a
// navigation tears down the page mid-word. Everything that changes the page
// waits for this to resolve first.
async function sayAndWait(text) {
  if (!text) return;
  if (ui.said) {
    ui.said.textContent = text;
    // The response area is intentionally compact. When an answer grows beyond
    // it, keep the newest words in view instead of leaving the shopper looking
    // at the beginning of a clipped answer.
    requestAnimationFrame(() => { ui.said.scrollTop = ui.said.scrollHeight; });
  }
  remember("assistant", text);
  try { await voice.speak(text); } catch { /* a failed line must not block the action */ }
}

// Say it, finish saying it, then do the thing that replaces the page.
// Amazon puts a keyboard hint inside the accessible name itself ("Add to
// cart, shift, option, K"). It is matched on, but reading it aloud gives
// "Opening Cart, shift, option, c", which sounds like a malfunction to
// someone who cannot see the screen. Strip it for speech only: the name still
// has to match the page exactly, or the wrong control gets pressed.
function speakableName(name) {
  return String(name ?? "")
    .replace(/,\s*(?:(?:shift|ctrl|control|alt|option|cmd|command)\s*[,+]?\s*)+[a-z0-9]?\s*$/i, "")
    .trim() || String(name ?? "");
}

function sayThen(text, act) {
  void sayAndWait(text).then(() => { if (!globalThis.__cueEnded) act(); });
}

// Scrolling moves every rect. Drop the resolver's cache immediately rather
// than waiting for its own key check to notice.
addEventListener("scroll", invalidate, { passive: true });

// ── Look at the edge to scroll ──────────────────────────────────────────────
// Hands-free browsing needs a way down the page that is not a spoken command
// every screenful. Hold your gaze in the top or bottom band and the page
// moves, accelerating the closer to the edge you look. A brief slip out of
// the band does not restart the arm timer.
//
// The band has to be generous — at 220-350px of error a narrow strip would be
// unreachable — and it must not fire while calibrating, while a dialog is up,
// or while the pointer has been abandoned in mouse mode.
const EDGE_ENTER = 150;   // between the old 130px strip and the 180px one
const EDGE_KEEP = 190;    // a little slack once scrolling, not a wide band
const EDGE_ARM_MS = 330;  // between the old 500ms hold and the 160ms one
const EDGE_SLIP_MS = 180; // a frame or two of noise, not a long look away
const EDGE_MAX_PX = 13;   // per frame at the very edge

let edgeSince = 0, edgeDir = 0, edgeSeen = 0;

function edgeScrollTick() {
  // Gaze is too coarse to scroll by: the page drifted while people read.
  // Scrolling is a spoken, discrete action only.
  return;
  // eslint-disable-next-line no-unreachable
  const p = render;
  const gs = gaze.getState();
  if (gs.calibrating || !gs.point) {
    edgeSince = 0; edgeDir = 0; edgeSeen = 0;
    document.body.classList.remove("cue-edge-top", "cue-edge-bottom");
    return;
  }

  const band = edgeDir ? EDGE_KEEP : EDGE_ENTER;
  const top = p.y < band;
  const bottom = p.y > innerHeight - band;
  let dir = top ? -1 : bottom ? 1 : 0;
  // Gaze error kicks the point out of the band for a frame or two. Keep the
  // direction through that, or the arm timer restarts and scrolling never gets
  // going unless they stare at one spot.
  if (!dir && edgeDir && now() - edgeSeen < EDGE_SLIP_MS) dir = edgeDir;

  if (!dir) {
    edgeSince = 0; edgeDir = 0; edgeSeen = 0;
    document.body.classList.remove("cue-edge-top", "cue-edge-bottom");
    return;
  }
  if (dir !== edgeDir) { edgeDir = dir; edgeSince = now(); edgeSeen = now(); return; }
  if (top || bottom) edgeSeen = now();
  if (now() - edgeSince < EDGE_ARM_MS) return;

  const tightTop = p.y < EDGE_ENTER;
  const tightBottom = p.y > innerHeight - EDGE_ENTER;
  const depth = tightTop
    ? (EDGE_ENTER - p.y) / EDGE_ENTER
    : tightBottom
      ? (p.y - (innerHeight - EDGE_ENTER)) / EDGE_ENTER
      : 0.2;
  const step = dir * EDGE_MAX_PX * Math.min(1, Math.max(0.15, depth));

  scrollAmount(p.x, dir < 0 ? 8 : innerHeight - 8, step, false);
  document.body.classList.toggle("cue-edge-top", dir < 0);
  document.body.classList.toggle("cue-edge-bottom", dir > 0);
}

// ── The loop: utterance -> server -> speech + actions ───────────────────────
// The site's own cart, read from its cart page (same origin, shopper's cookies).
let siteCart = null;
async function readSiteCart() {
  const link = [...document.querySelectorAll("a[href]")].find((a) =>
    /\/(?:gp\/)?(?:cart|basket|bag)\b/i.test(new URL(a.href, location.href).pathname));
  const page = link?.href || new URL("/cart", location.href).href;
  try {
    const res = await fetch(page, { credentials: "include" });
    const doc = new DOMParser().parseFromString(await res.text(), "text/html");
    const rows = [...doc.querySelectorAll(
      "[data-name='Active Items'] .sc-list-item, .sc-list-item[data-asin], [data-cart-item], .cart-item, .cart__item")];
    const items = rows.map((r) => (r.querySelector(".sc-product-title, [class*='title'], a")?.textContent || "")
      .replace(/\s+/g, " ").trim()).filter(Boolean);
    siteCart = { items, at: Date.now() };
    const empty = /your (?:amazon )?(?:cart|basket|bag) is empty/i.test(doc.body?.textContent || "");
    if (items.length) {
      bus.emit("SAY", { text: `${items.length} item${items.length === 1 ? "" : "s"} in the site cart. ` +
        items.slice(0, 5).map((t, k) => `${k + 1}, ${t.slice(0, 70)}`).join(". ") + "." });
    } else if (empty) {
      bus.emit("SAY", { text: "The site says your cart is empty." });
    } else {
      bus.emit("SAY", { text: "I couldn't read the cart from here. Say open cart and I'll take you there." });
    }
  } catch {
    bus.emit("SAY", { text: "I couldn't reach the cart. Say open cart and I'll take you there." });
  }
}

// The name of something seen this visit, or "it" for what was last discussed.
// The agent names items by their full title, which rarely survives word-for-word
// ("the Beat Solo" for "Beats Solo 4 Wireless On-Ear"), so an exact single match
// is too strict — it refused items that were right there on the page.
function resolveKnown(target) {
  const t = String(target ?? "").trim();
  if (!t || /^(?:it|this|that|this one|that one)$/i.test(t)) {
    return discussed ? knowledge.get(discussed.id) : null;
  }
  // What is on this page as well as what was seen earlier, so "open its page"
  // works for something Cue has only just laid eyes on.
  const here = scanAll().map((p) => knowledge.get(p.product.id) ?? p.product);
  const pool = [...here, ...knowledge.recent(40)]
    .filter((p, i, all) => p?.title && all.findIndex((q) => q.id === p.id) === i);
  const hits = matchCandidates(t, pool);
  if (hits.length) return hits[0];
  // Last resort: the longest title that shares a distinctive run of words.
  const words = t.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
  if (!words.length) return null;
  let best = null, bestScore = 0;
  for (const p of pool) {
    const title = p.title.toLowerCase();
    const score = words.filter((w) => title.includes(w)).length;
    if (score > bestScore) { best = p; bestScore = score; }
  }
  return bestScore >= Math.min(2, words.length) ? best : null;
}

function bagBrief() {
  if (CONFIG.injected && !window.cueBag) return siteCart?.items?.length ? siteCart.items.slice(0, 5) : null;
  const items = window.cueBag?.items?.() || [];
  if (!items.length) return null;
  return items.slice(0, 5).map((i) => i.title);
}

function budgetBrief() {
  const b = window.cueBudget;
  if (!b || !Number.isFinite(b.remaining)) return null;
  return { remaining: b.remaining, order: b.order };
}

async function withDetails(text) {
  if (CONFIG.injected) {
    const f = gaze.getFocus();
    const focused = f?.kind === "product" ? f.product : null;
    await details.ensure(detailUrls(focused).slice(0, 3).map((p) => p.url));
  }
  const ctx = context(text);
  try {
    const summary = await analyticsRequest("summary");
    ctx.shopping_interests = {
      searched: (summary.top_searches || []).slice(0, 3).map(item => item.label),
      added: (summary.top_added || []).slice(0, 3).map(item => item.label),
      purchased: (summary.top_purchased || []).slice(0, 3).map(item => item.label),
    };
  } catch {}
  return ctx;
}

function detailUrls(focused) {
  const seen = new Set();
  const list = [focused, comparisons.remember(focused), discussed,
    ...scan().filter((t) => t.kind === "product").slice(0, 5).map((t) => t.product),
    ...knowledge.recent(8)];
  const known = (p) => knowledge.get(p?.id)?.url || p?.url;
  return list.map((p) => (p ? { ...p, url: known(p) } : p)).filter((p) => p?.url && !seen.has(p.url) && seen.add(p.url));
}

function detailsBrief(focused) {
  return detailUrls(focused).map((p) => ({ title: p.title, facts: details.peek(p.url) || knowledge.factsFor(p.url) }))
    .filter((d) => d.facts).slice(0, 6);
}

// What page the shopper is actually on. `looking_at` is a 250px guess; this is
// not, and it is what "this product" and "this page" mean.
function pageBrief() {
  const products = scanAll();
  const here = location.href.split("?")[0].slice(0, 140);
  const cart = /\/(?:cart|basket|gp\/cart)\b/i.test(location.pathname);
  const detailUrl = /\/(?:dp|gp\/product|product|products|item|ip)\//i.test(location.pathname);
  // A detail page is still a detail page when carousels below it are real
  // products too. Requiring exactly one made every Amazon item page look like
  // a results page: `page.product` was never set, so the model could not
  // answer "the reviews of the product we're on" and kept re-identifying the
  // item by name. The one that owns the buy control is the page's own.
  const owning = detailUrl ? products.filter((p) => addButtonIn(p.el)) : [];
  const only = detailUrl && products.length === 1 ? products[0].product
    : owning.length === 1 ? owning[0].product
    : null;
  const brief = {
    kind: cart ? "cart" : only ? "product" : products.length > 1 ? "results" : "page",
    title: String(document.title || "").replace(/\s+/g, " ").trim().slice(0, 140),
    url: here,
    // Always sent. Gating this on question-shaped wording meant "I thought we
    // added the sunscreen" arrived with no page at all, and Cue guessed.
    // Measured: an Amazon results page is ~44k characters of text and has all 60
    // results in the DOM before any scrolling. The structured list is the high
    // signal half, so it carries every item and the raw text stays a summary.
    text: pageText(document, 6000),
    products: products.slice(0, 60).map((t) => ({
      title: t.product.title, price: t.product.price,
      onScreen: t.rect.bottom > 0 && t.rect.top < innerHeight,
    })),
  };
  if (only) {
    const facts = details.peek(only.url) || knowledge.factsFor(only.url);
    brief.product = { title: only.title, ...(facts || {}),
      ...(Number.isFinite(only.price) ? { price: `$${only.price}` } : {}) };
  }
  return brief;
}

function context(utterance = "") {
  const f = gaze.getFocus();
  const focused = f?.kind === "product" ? f.product : null;
  const asking = /^(?:what|why|how|is|are|do|does|can|tell|describe|compare|which)\b/i.test(utterance);
  const nearby = (site?.nearby || []).slice(0, 4);
  return {
    focused,
    previous: comparisons.remember(focused),
    focusedAction: f?.kind === "action" ? { verb: f.verb, label: f.label } : null,
    visible: scan().filter((t) => t.kind === "product").slice(0, 6).map((t) => t.product),
    discussed: discussed ? { id: discussed.id, title: discussed.title } : null,
    known: knowledge.brief(10),
    convo: convo.slice(-14),
    chosen: stated.size || stated.color ? { size: stated.size, color: stated.color } : null,
    bag: bagBrief(),
    budget: budgetBrief(),
    controls: controls().slice(0, 12).map((c) => c.name),
    // Facts read from each product's own page, so questions about an item can be
    // answered without opening it. Extension only; the demo store carries its own.
    product_details: CONFIG.injected ? detailsBrief(focused) : [],
    client_build: CLIENT_BUILD,
    details_stats: CONFIG.injected ? { ...details.stats(), products: detailUrls(focused).length,
      injected: true } : { injected: false },
    fields: fields().slice(0, 8).map((f) => f.name).filter(Boolean),
    site: site ? { title: site.title, pages: (site.pages || []).slice(0, 6).map((p) => p.title).filter(Boolean) } : null,
    page: pageBrief(),
    nearby: asking ? nearby.map((p) => ({ title: p.title, text: (p.text || "").slice(0, 180) }))
      : nearby.map((p) => ({ title: p.title })),
    // What Cue has open over the page. Without this the model was asked to
    // "close the comparison" with no way to know one was open: it either said
    // "I don't see what's open to close" or narrated closing it and proposed
    // nothing.
    panel: compare.isOpen() ? "comparison" : null,
    // What Cue has open over the page. Without this the model was asked to
    // "close the comparison" with no way to know one was open: it either said
    // "I don't see what's open to close" or narrated closing it and proposed
    // nothing at all.
    panel: compare.isOpen() ? "comparison" : null,
    pending: pendingConfirm?.kind ?? null,
    session: sessionId(),
    url: location.href,
  };
}

function sessionId() {
  const key = "cue.session";
  try {
    const existing = memoryStorage?.getItem(key);
    if (existing) return existing;
    const id = (globalThis.crypto?.randomUUID?.() || String(Date.now()));
    memoryStorage?.setItem(key, id);
    return id;
  } catch { return "visit"; }
}

let inflight = false;
let turnId = 0;
let pendingSay = "";
let settleTimer = 0;
let lastTyped = null;
let actionSayTimer = 0;
// Typing and submitting announce themselves after the dispatch loop, so
// "type X and press enter" is one line, and a reply from the model replaces it.
function actionSay(text) {
  clearTimeout(actionSayTimer);
  actionSayTimer = setTimeout(() => bus.emit("SAY", { text }), 0);
}
const QUICK = /^(?:yes|yeah|no|nope|cancel|end|cue end|[1-9]|one|two|three|four|five|six|seven|eight|nine)$/i;
// Ending Cue takes a word that means only that. "Stop" is what people say to a
// scroll that has gone too far, and it used to shut Cue down instead — the one
// command you cannot undo by saying it again.
const HALT = /^(?:exit|quit|go away|shut down|turn(?: yourself)? off|disable|end|cue end|stop cue|quit cue|pause cue)(?: cue)?$/i;

// "scroll down" keeps going, slowly, until they say stop. Reading pace, not a
// jump: someone who cannot scroll themselves needs to see the page pass by.
// Each reading pace is 1.8x the original speed. The steps remain far enough
// apart for "slower" and "faster" to make an obvious, predictable change.
const SCROLL_SPEEDS = [39.6, 68.4, 108, 171, 270];   // px per second
const STOP_SCROLL = /\b(?:stop|pause|wait|hold on|hold it|halt|freeze|enough|that's good|right there|okay stop)\b/i;
const autoScroll = { dir: 0, speed: 3, raf: 0, last: 0, carry: 0, stuck: 0 };

function scrollTick(t) {
  if (!autoScroll.dir || globalThis.__cueEnded) return stopAutoScroll(false);
  const dt = Math.min(0.1, (t - (autoScroll.last || t)) / 1000);
  autoScroll.last = t;
  autoScroll.carry += autoScroll.dir * SCROLL_SPEEDS[autoScroll.speed] * dt;
  const whole = Math.trunc(autoScroll.carry);
  if (whole) {
    autoScroll.carry -= whole;
    const box = scrollerAt(innerWidth / 2, innerHeight / 2, false);
    const el = box || document.scrollingElement || document.documentElement;
    const before = el.scrollTop;
    if (box) box.scrollBy({ top: whole, behavior: "instant" });
    else window.scrollBy({ top: whole, behavior: "instant" });
    // Lazy-loading pages grow as we go; only give up after a real stall.
    autoScroll.stuck = el.scrollTop === before ? autoScroll.stuck + 1 : 0;
    if (autoScroll.stuck > 90) {
      const dir = autoScroll.dir;
      stopAutoScroll(false);
      bus.emit("SAY", { text: dir > 0 ? "That's the bottom." : "That's the top." });
      return;
    }
  }
  voice.keepAwake?.(15000);
  autoScroll.raf = requestAnimationFrame(scrollTick);
}

function startAutoScroll(dir, speed) {
  autoScroll.dir = dir;
  if (Number.isInteger(speed)) autoScroll.speed = Math.max(0, Math.min(SCROLL_SPEEDS.length - 1, speed));
  autoScroll.last = 0; autoScroll.carry = 0; autoScroll.stuck = 0;
  cancelAnimationFrame(autoScroll.raf);
  autoScroll.raf = requestAnimationFrame(scrollTick);
  document.body.classList.toggle("cue-edge-top", dir < 0);
  document.body.classList.toggle("cue-edge-bottom", dir > 0);
}

function stopAutoScroll(announce = true) {
  const was = autoScroll.dir;
  autoScroll.dir = 0;
  cancelAnimationFrame(autoScroll.raf);
  document.body.classList.remove("cue-edge-top", "cue-edge-bottom");
  invalidate();
  if (announce && was) bus.emit("SAY", { text: "Stopped." });
  return Boolean(was);
}

bus.on("UTTERANCE", ({ text, final }) => {
  // While the page is moving, "stop" means stop scrolling, not stop Cue. Acted
  // on from the partial transcript so the page halts the moment it is said.
  if (autoScroll.dir && STOP_SCROLL.test(text)) {
    stopAutoScroll(false);
    // The final transcript of this same "stop" follows; swallow it so it does
    // not reach the exit handler and switch Cue off.
    autoScroll.swallowUntil = final ? 0 : Date.now() + 2500;
    ui.heard.textContent = text;
    return;
  }
  if (final && autoScroll.swallowUntil > Date.now() && STOP_SCROLL.test(text)) {
    autoScroll.swallowUntil = 0;
    ui.heard.textContent = text;
    return;
  }
  if (autoScroll.dir && final) {
    const speedUp = /\b(?:faster|speed up|quicker)\b/i.test(text);
    const slowDown = /\b(?:slower|slow down)\b/i.test(text);
    if (speedUp || slowDown) {
      startAutoScroll(autoScroll.dir, autoScroll.speed + (speedUp ? 1 : -1));
      bus.emit("SAY", { text: speedUp ? "Faster." : "Slower." });
      return;
    }
  }
  if (final && HALT.test(text.trim().toLowerCase().replace(/[.!?,]+/g, "").replace(/\s+/g, " "))) {
    void exitCue();
    return;
  }
  if (voice.isPrivateMode?.()) return;
  if (gaze.getState().calibrating) return;
  ui.heard.textContent = (final ? "" : "… ") + text;
  if (!final) return;
  clearTimeout(settleTimer);
  try { voice.stopSpeaking(); } catch {}
  const said = text.trim();
  if (QUICK.test(said)) {
    pendingSay = "";
    beginTurn(said);
    return;
  }
  pendingSay = (pendingSay ? pendingSay + " " : "") + said;
  ui.heard.textContent = pendingSay;
  settleTimer = setTimeout(() => {
    const full = pendingSay.trim();
    pendingSay = "";
    if (!full || isWakeOnly(full) || /^(?:hey |hi |ok |okay )?(?:cue|q|queue|kew|cu|coo|aura|ora|aurora)[.?!]?$/i.test(full)) return;
    beginTurn(full);
  }, 900);
});

async function beginTurn(text) {
  if (voice.isPrivateMode?.()) return;
  // Calibration owns the microphone for "Cue, next". Nothing said there is a
  // shopping command, and echoing it into the HUD just looks like a bug.
  if (gaze.getState().calibrating) return;
  const mine = ++turnId;
  // Correct the transcript against what is on this page before anything reads
  // it: "clique the cart" is "click the cart" only if there is a Cart to click.
  const heard = text;
  const fixed = correctUtterance(text, {
    controls: controls().map((c) => c.name),
    fields: fields().map((f) => f.name).filter(Boolean),
  });
  if (fixed.changed) {
    text = fixed.text;
    console.log(`[cue] heard "${heard}" -> "${text}"`);
  }
  const analyticsAction = analyticsCommand(text, analytics.isOpen);
  if (analyticsAction) {
    if (analyticsAction === "close") { analytics.close(); bus.emit("SAY", { text: "Closed analytics." }); }
    else { void analytics.open(); bus.emit("SAY", { text: "Opening your analytics." }); }
    return;
  }
  remember("user", text);
  // Naming an item and then talking about it must not let gaze quietly take
  // the focus back. The lock used to expire on a 3.5s timer, so "two" ... two
  // questions ... "add it" added whatever the eyes had drifted onto — and at
  // 242px of error that is effectively random. While the conversation
  // continues, what you named stays what you meant.
  gaze.holdFocus();
  voiceNamed = false;
  lookedThisTurn = gazedProduct();
  const aboutGaze = /\bthis one\b|\bthe one i(?:'?m|m| am) looking at\b/i.test(text);
  let hits = aboutGaze ? [] : matchCandidates(text, visibleProducts());
  // "tell me more about it" after naming something is about that thing, not a
  // fresh question of which of several cards they meant.
  if (hits.length > 1 && discussed && /\b(?:it|its|that one|that|them)\b/i.test(text)) hits = [];
  if (hits.length > 1) {
    const line = hits.slice(0, 3).map((p) => String(p.title || p.product?.title || "").slice(0, 60))
      .filter(Boolean).join(", or the ");
    bus.emit("SAY", { text: `Which one — the ${line}?` });
    return;
  }
  const named = hits[0];
  if (aboutGaze && lookedThisTurn) {
    discussed = lookedThisTurn;
  } else if (named?.id || named?.product?.id) {
    discussed = briefProduct(named.product || named);
    voiceNamed = true;
    const target = productTarget(discussed.id);
    if (target) { gaze.setFocus(target); gaze.holdFocus(); }
  }
  persistShopper();
  rememberSpokenOptions(text);
  if (pendingConfirm?.kind === "options") {
    if (/\b(?:never mind|cancel|stop)\b/i.test(text)) {
      pendingConfirm = null;
      bus.emit("SAY", { text: "Okay, left it." });
      return;
    }
    finishOptions();
    return;
  }
  if (discussed && !/^(?:please |can you |could you )?(?:scroll|go back|back|go forward|forward|page |search|find|look )\b/i.test(text)) {
    pinDiscussed();
  }
  inflight = true;
  try {
    const res = await fetch(url("/utterance"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, context: { ...(await withDetails(text)), heard: heard !== text ? heard : null } }),
    });
    const out = await res.json();
    // They kept talking, or entered private payment, while this request was out.
    if (mine !== turnId || voice.isPrivateMode?.() || globalThis.__cueEnded) return;
    window.cue.lastActionUtterance = text;
    let completed = true;
    // The router is the only deterministic path — it fires on the shopper's own
    // words. Everything else is a model and may not commit. Keyed on "not the
    // router" rather than a model name, so renaming the model cannot open this.
    const fromModel = out.source !== "router";
    const staged = Array.isArray(out.ask) ? out.ask : (out.ask?.verb ? [out.ask] : null);
    const plan = (out.do?.length ? out.do : staged) ?? [];
    const namesItem = plan.some((a) => a.verb === "focus_nth");
    const touchesProduct = plan.some((a) => PRODUCT_VERBS.has(a.verb));
    if (completed && !namesItem && touchesProduct && discussed && !pinDiscussed()) {
      bus.emit("SAY", { text: `I can't see the ${discussed.title} on screen any more.` });
      completed = false;
    }
    // Say it first. Actions used to run here, so "Opening the reviews" was cut
    // off by the navigation it was announcing.
    if (completed && out.say) await sayAndWait(out.say);
    if (mine !== turnId || globalThis.__cueEnded) return;
    for (const a of completed ? (out.do ?? []) : []) {
      // Second lock. The server's allowlist already refuses these from the
      // model; this is the one that survives a jailbreak, because it is the
      // page and not the prompt.
      if (fromModel && COMMIT_VERBS.has(a.verb)) {
        console.warn("[cue] refused a commit verb proposed by the model:", a.verb);
        bus.emit("SAY", { text: "I need to hear you say that yourself." });
        completed = false;
        break;
      }
      if (perform(a.verb, a.args ?? {}, { narrated: Boolean(out.say) }) === false) {
        completed = false; break;
      }
    }
    // The agent proposed something and asked first. Hold it: the shopper's
    // "yes" is what performs it. This is how Cue is allowed to buy — it never
    // commits on its own, it states exactly what it will do and waits.
    if (completed && staged?.length) {
      pendingConfirm = { kind: "action", actions: staged, said: out.say ?? "" };
    }
    // Adopt the gazed card only when nothing has been named yet. A later look
    // does not replace the item the words already picked.
    if (!voiceNamed && !discussed && lookedThisTurn
        && (out.source !== "router" || touchesProduct)) {
      discussed = lookedThisTurn;
      rememberSpokenOptions(text);
    }
    window.cue.lastActionUtterance = null;
  } catch (e) {
    bus.emit("SAY", { text: "Sorry, I lost my connection." });
    console.error(e);
  } finally { window.cue.lastActionUtterance = null; inflight = false; }
}

// ── Confirmation ────────────────────────────────────────────────────────────
// Nothing that spends money happens on one utterance. Checkout stages an
// intent, Cue reads it back, and only "yes" completes it. This is the whole
// trust story, so it lives in the client where the readback is visible.
let pendingConfirm = null;

function stageCheckout() {
  // Their passkey flow is the real one where it exists: it reprices
  // server-side, enforces the cap inside the write transaction and writes the
  // intent record. Only fall back to the local staged readback without it.
  if (window.cueCheckout?.prepare) { window.cueCheckout.prepare(); return; }
  const store = window.cueStore;
  if (!store) {
    // Both globals above are the demo store's. On a real site this used to be
    // the only branch left, so Cue said "There's no cart on this page" while
    // the shopper was looking at seven items on Amazon's own cart. The shop's
    // own control is the real rail; it goes through the money confirmation.
    const money = clickables().find((c) => COMMITS_MONEY.test(c.name || ""))
      || findControl("proceed to checkout") || findControl("checkout");
    if (money) { confirmMoney(money.el, money.name); return; }
    bus.emit("SAY", { text: "I don't see a checkout button on this page." });
    return;
  }
  const s = store.summary();
  if (!s.count) { bus.emit("SAY", { text: "Your cart is empty." }); return; }
  pendingConfirm = { kind: "checkout", at: Date.now() };
  bus.emit("SAY", { text: s.readback });
}

function resolveConfirm(ok) {
  if (!pendingConfirm) return false;
  const p = pendingConfirm;
  pendingConfirm = null;
  if (p.kind === "remove") {
    if (!ok) { bus.emit("SAY", { text: "Okay, left it in." }); return true; }
    // Re-find it by identity. If it is no longer there, say so rather than
    // removing whatever now occupies that slot.
    const now = window.cueBag?.items() ?? [];
    const it = p.item;
    const match = now.find((x) => x.title === it.title && x.size === it.size && x.color === it.color);
    if (!match) {
      bus.emit("SAY", { text: `The ${it.title} isn't in your bag any more.` });
      return true;
    }
    window.cueBag.remove(match.idx);
    bus.emit("SAY", { text: `Removed the ${it.title}.` });
    return true;
  }
  if (p.kind === "add") {
    if (!ok) { bus.emit("SAY", { text: "Okay, left it." }); return true; }
    perform("add_to_cart", {}, { confirmed: true });
    return true;
  }
  if (p.kind === "action") {
    if (!ok) { bus.emit("SAY", { text: "Okay, left it." }); return true; }
    // Run everything that was read back, in order, stopping if a step is
    // refused — the confirmation covered the whole sequence, not just the end.
    for (const a of p.actions) {
      // Already read back as a whole — do not ask again for the add inside it.
      // The readback already said what this does, so do not say it again.
      if (perform(a.verb, a.args ?? {},
                  { confirmed: true, narrated: Boolean(p.said) }) === false) break;
    }
    return true;
  }
  // The second utterance, and the only thing that presses a money control on
  // a real site. Re-check the element is still on the page: the readback took
  // seconds, and pressing whatever now sits at that reference is exactly the
  // mistake this whole path exists to prevent.
  if (p.kind === "money") {
    if (!ok) { bus.emit("SAY", { text: "Okay, not buying." }); return true; }
    if (!p.el?.isConnected) {
      bus.emit("SAY", { text: `The ${p.name} button isn't on the page any more.` });
      return true;
    }
    const r = p.el.getBoundingClientRect();
    if (r.bottom <= 0 || r.top >= innerHeight) {
      p.el.scrollIntoView({ block: "center", behavior: "instant" });
    }
    sayThen(`Pressing ${p.name}.`, () => pressControl(p.el));
    return true;
  }
  if (p.kind !== "checkout") return false;
  if (ok) { window.cueStore?.approve(); bus.emit("SAY", { text: "Order approved." }); }
  else    { bus.emit("SAY", { text: "Cancelled. Nothing was charged." }); }
  return true;
}

// ── Actions the page can perform ────────────────────────────────────────────

// Size and add use the item that was said. Gaze fills in only when nothing
// has been discussed, or that card is no longer on screen.
function scope() {
  const pinned = discussed && productTarget(discussed.id);
  if (pinned) return pinned.el;
  const f = gaze.getFocus();
  if (!f) return null;
  return f.kind === "product" ? f.el : f.el.closest("[data-cue-product],[data-aura-product]");
}

function productOn(card) {
  if (!card) return null;
  try {
    return briefProduct(JSON.parse(card.dataset.cueProduct ?? card.dataset.auraProduct ?? "{}"));
  } catch { return null; }
}

const OPTION_WORDS = /\b(?:extra small|extra large|xxl|xs|xl|small|medium|large|s|m|l|size|colou?r|in|the)\b/g;

/** True when a phrase names nothing but a size and/or color. */
function onlyOptions(phrase, color) {
  let rest = norm(phrase).replace(OPTION_WORDS, " ");
  if (color) rest = rest.replace(norm(color), " ");
  return !rest.trim();
}

function productData(card) {
  if (!card) return null;
  try { return JSON.parse(card.dataset.cueProduct ?? card.dataset.auraProduct ?? "null"); }
  catch { return null; }
}

/**
 * Press a control the way a person does, not with a bare `.click()`.
 *
 * `.click()` fires exactly one `click` event. Real presses also produce
 * pointer and mouse down/up, and delegated frameworks routinely bind to those
 * instead. Amazon's add-to-cart is the case that proved it: an
 * `<input type="button" name="submit.add-to-cart">` inside a POST form, with
 * no inline onclick, so `type="button"` submits nothing by itself and the
 * whole add depends on a handler a lone click event never reached. The final
 * `.click()` stays, because that is what triggers native behaviour for a real
 * submit button.
 */
// Phrases that mean "make this go away". Kept narrow on purpose: a loose
// match on "close" or "skip" finds Amazon's hidden "Skip to main content" link
// long before it finds the popup in front of you.
const DECLINE = ["no thanks", "no thank you", "not now", "not interested",
  "remind me later", "maybe later", "don't need it", "no warranty",
  "don't need the warranty", "don't want the warranty", "skip this", "dismiss"];

const OVERLAY_SEL = '[role=dialog],[role=alertdialog],.a-popover,[class*=modal i],[class*=overlay i]';

/** The dialog, popover or sheet currently covering the page, if any. */
function topOverlay() {
  const seen = [...document.querySelectorAll(OVERLAY_SEL)].filter((el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) return false;
    const st = getComputedStyle(el);
    return st.visibility !== "hidden" && st.display !== "none" && +st.opacity > .1;
  });
  return seen.sort((a, b) => (+getComputedStyle(b).zIndex || 0) - (+getComputedStyle(a).zIndex || 0))[0] ?? null;
}

/** Close the thing on top. Returns how it went, so the reply can be honest. */
function dismissOverlay() {
  const box = topOverlay();
  if (box) {
    const close = box.querySelector('[aria-label*="close" i],[title*="close" i],' +
      '[data-action="a-popover-close"],[data-hook*="close" i],button[class*="close" i]');
    if (close) { pressControl(close); return "closed"; }
  }
  for (const phrase of DECLINE) {
    const c = findControl(phrase);
    // Only accept a decline control inside the overlay, or anywhere when there
    // is no overlay to scope to.
    if (c?.el && (!box || box.contains(c.el))) { pressControl(c.el); return "declined"; }
  }
  for (const target of [document.activeElement, document.body]) {
    for (const type of ["keydown", "keyup"]) {
      target?.dispatchEvent(new KeyboardEvent(type, { key: "Escape", code: "Escape", keyCode: 27, bubbles: true }));
    }
  }
  return box ? "escaped" : "nothing";
}

function pressControl(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.bottom <= 0 || r.top >= innerHeight) {
    el.scrollIntoView({ block: "center", behavior: "instant" });
  }
  const box = el.getBoundingClientRect();
  const base = {
    bubbles: true, cancelable: true, composed: true, button: 0, buttons: 1,
    clientX: Math.round(box.left + box.width / 2),
    clientY: Math.round(box.top + box.height / 2),
  };
  const pointer = { ...base, pointerType: "mouse", isPrimary: true, pointerId: 1 };
  try { el.focus?.({ preventScroll: true }); } catch {}
  try {
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerdown", pointer));
    }
    el.dispatchEvent(new MouseEvent("mousedown", base));
    if (typeof PointerEvent === "function") {
      el.dispatchEvent(new PointerEvent("pointerup", { ...pointer, buttons: 0 }));
    }
    el.dispatchEvent(new MouseEvent("mouseup", { ...base, buttons: 0 }));
  } catch {}
  el.click();
  return true;
}

function addButtonIn(root) {
  if (!root) return null;
  // input[type=button] matters: Amazon renders add-to-cart as a submit on one
  // listing and a plain button on the next, so omitting it misses the control
  // on half the pages.
  const named = [...root.querySelectorAll(
    "button, [role=button], input[type=submit], input[type=button]")]
    .map((el) => ({ el, name: controlName(el) }))
    .filter((c) => c.name && !/address/i.test(c.name));
  // Taking the first /\badd\b/ match is not good enough. An Amazon product
  // page offers "Add protection", "Add a gift receipt" and "Add to List"
  // above the real control, so the first match was the warranty upsell: Cue
  // pressed that on every add, said "Added.", and the cart never changed.
  // Insist on adding to a cart, bag or basket before falling back.
  const toCart = /\badd\b[^.]*\b(?:cart|bag|basket)\b/i;
  return named.find((c) => toCart.test(c.name))?.el
    ?? named.find((c) => /\badd\b/i.test(c.name))?.el
    ?? null;
}

function addControl(card) {
  const marked = card?.querySelector('[data-cue-action="add_to_cart"],[data-aura-action="add_to_cart"]');
  if (marked) return marked;
  const inside = addButtonIn(card);
  if (inside) return inside;
  const visible = scan().filter((t) => t.kind === "product");
  if (discussed && visible.length === 1 && visible[0].id === discussed.id) return addButtonIn(document.body);
  return null;
}

function visibleProducts() {
  return scan().filter((t) => t.kind === "product").map((t) => t.product);
}

// What the eyes are on, read before scope() pins the spoken item.
function gazedProduct() {
  const f = gaze.getFocus();
  if (!f?.el) return null;
  const el = f.kind === "product" ? f.el : f.el.closest?.("[data-cue-product],[data-aura-product]");
  return productOn(el);
}

function rememberSpokenOptions(text) {
  const data = productData(scope());
  if (!data?.id) return;
  if (stated.id !== data.id) stated = { id: data.id, size: null, color: null };
  const heard = matchOptions(text, data);
  if (heard.size) stated.size = heard.size;
  if (heard.color) stated.color = heard.color;
  persistShopper();
  if (data.variants?.length === 1) stated.size = data.variants[0];
  if (data.colors?.length === 1) stated.color = data.colors[0].name;
}

function applyStated(card) {
  if (!card || stated.id !== productOn(card)?.id) return;
  if (stated.size) {
    card.querySelector(`[data-aura-action="select_variant"][data-aura-value="${CSS.escape(stated.size)}"],` +
      `[data-cue-action="select_variant"][data-cue-value="${CSS.escape(stated.size)}"]`)?.click();
  }
  if (stated.color) {
    card.querySelector(`[data-aura-action="select_color"][data-aura-value="${CSS.escape(stated.color)}"]`)?.click();
  }
}

function finishOptions() {
  const data = productData(scope());
  if (!data) {
    pendingConfirm = null;
    bus.emit("SAY", { text: "I can't see that item any more." });
    return;
  }
  const missing = missingChoices(data, stated);
  if (missing.size || missing.color) {
    bus.emit("SAY", { text: optionPrompt(data.title, missing, data) });
    return;
  }
  pendingConfirm = null;
  pinDiscussed();
  perform("add_to_cart", {});
}

// Move focus onto the item being discussed, so a size or add that follows
// cannot land on whatever the eyes have drifted onto.
function pinDiscussed() {
  const target = productTarget(discussed?.id);
  if (!target) return false;
  gaze.setFocus(target);
  gaze.holdFocus();
  return true;
}

// Words that COMMIT: they complete a payment or enrol a credential. These may
// only come from the deterministic router — that is, from the shopper actually
// saying yes — never from the language model.
//
// Cue is allowed to shop. Only the human is allowed to commit. That is the
// whole trust argument, so it is enforced in two independent places: the
// server's allowlist (server/agent.py) and the dispatch loop below.
const COMMIT_VERBS = new Set(["confirm", "approve_checkout", "setup_passkey"]);

const checkoutOpen = () =>
  !!(document.getElementById("checkout-dialog")?.open && window.cueCheckout);

function canScroll(el, horizontal) {
  if (!el) return false;
  const st = getComputedStyle(el);
  const flow = horizontal ? st.overflowX : st.overflowY;
  const room = horizontal ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
  return room > 12 && /(auto|scroll|overlay)/.test(flow);
}

// Many shops leave the window still and scroll a panel instead. Walk from the
// point under the gaze, then the biggest panel on the page.
let hostScroller = null, hostAt = 0;
function pageScroller() {
  const t = performance.now();
  if (t - hostAt < 800) return hostScroller;
  hostAt = t;
  const root = document.scrollingElement || document.documentElement;
  if (root.scrollHeight - root.clientHeight > 40) { hostScroller = null; return null; }
  let best = null, room = 40;
  const nodes = document.querySelectorAll("main, [role='main'], body > div, body > div > div");
  for (const el of nodes) {
    if (el.id === "aura-root" || el.closest?.("#aura-root")) continue;
    if (el.clientHeight < innerHeight * 0.45) continue;
    const extra = el.scrollHeight - el.clientHeight;
    if (extra <= room) continue;
    if (!/(auto|scroll|overlay)/.test(getComputedStyle(el).overflowY)) continue;
    room = extra; best = el;
  }
  hostScroller = best;
  return best;
}

function scrollerAt(x, y, horizontal) {
  const stack = document.elementsFromPoint?.(x, y) || [document.elementFromPoint(x, y)].filter(Boolean);
  for (const hit of stack) {
    if (!hit || hit.id === "aura-root" || hit.closest?.("#aura-root")) continue;
    let el = hit;
    while (el && el !== document.documentElement) {
      if (canScroll(el, horizontal)) return el;
      el = el.parentElement;
    }
  }
  return pageScroller();
}

function scrollAmount(x, y, delta, horizontal) {
  const box = scrollerAt(x, y, horizontal);
  const key = horizontal ? "left" : "top";
  if (box) box.scrollBy({ [key]: delta, behavior: "instant" });
  else window.scrollBy({ [key]: delta, behavior: "instant" });
}

// What is about to go in the bag, in the words the shopper will hear. For some
// users this is the only description of the purchase they get, so it names the
// item, the chosen options and the price.
// Marketplace titles are keyword stuffed for search, not for a person: the
// real one behind this read out as "Hybrid Active Noise Cancelling Headphones
// 120H Playtime 6 ENC Clear Call Mic, Over Ear Headphones Wireless with Hi-Res
// Audio Comfort Earcup Low Latency ANC Bluetooth 6.0 Headphones for Travel
// Workout". Someone who cannot see the screen has to sit through all of it
// before the price, every single time. Keep the first clause, which is what a
// person would actually call the thing.
function shortTitle(title) {
  const t = String(title ?? "").trim();
  if (t.length <= 60) return t;
  const clause = t.split(/\s[-–—|,(]\s?|\s{2,}/)[0].trim();
  const base = clause.length >= 12 && clause.length <= 60 ? clause : t;
  if (base.length <= 60) return base;
  const cut = base.slice(0, 60);
  const space = cut.lastIndexOf(" ");
  return (space > 24 ? cut.slice(0, space) : cut).trim();
}

// Money is the one thing the page always says in its own words. The model's
// sentence is not evidence, and "Place your order places the order on this
// site" was the old template reading its own button name back at the shopper.
function confirmMoney(el, name) {
  const p = productData(scope()) ?? discussed;
  const total = pageTotal();
  const amount = total ?? (typeof p?.price === "number" ? `$${p.price.toFixed(2)}` : null);
  pendingConfirm = { kind: "money", el, name };
  bus.emit("SAY", { text: amount
    ? `${amount}, and this one actually buys it. Want me to press it?`
    : `This one actually buys it. Want me to press it?` });
}

// The order total as the page itself prints it, so the amount read back is the
// shop's number and not something inferred from a card. Most specific label
// first: Amazon's cart says "Subtotal (1 item): $44.99", which an \btotal\b
// pattern misses entirely — and a money readback with no amount in it is the
// one thing this sentence exists to carry.
function pageTotal() {
  const text = document.body?.innerText || "";
  for (const label of ["order total", "grand total", "total", "subtotal"]) {
    const m = text.match(new RegExp(`${label}[^$\n]{0,40}(\\$[\\d,]+\\.\\d{2})`, "i"));
    if (m) return m[1];
  }
  return null;
}

function describeAdd(card) {
  const p = productData(card) || {};
  const title = shortTitle(p.title) || "this one";
  const size = stated.id === p.id ? stated.size : null;
  const color = stated.id === p.id ? stated.color : null;
  const missing = missingChoices(p, { size, color });
  const bits = [title, color, size && size !== "One size" && `size ${size}`].filter(Boolean);
  const price = typeof p.price === "number" ? `, $${p.price.toFixed(2)}` : "";
  return { title, size, color, missing, line: `${bits.join(", ")}${price}.` };
}

function perform(verb, args, opts = {}) {
  if (voice.isPrivateMode?.() && !["approve_checkout", "cancel_checkout", "setup_passkey", "confirm", "cancel"].includes(verb)) return false;
  // The page announces what it is about to do so a navigation the shopper
  // cannot see is not silent. But the model has usually just said the same
  // thing, and the shopper hears both: "Opening your cart now." then
  // "Opening Cart."; "Switching it to 7 to 11 AM." then "Opening Tomorrow
  // 7 AM - 11 AM." Every turn. When the reply already narrated it, act
  // without repeating it. Money and outcome lines are never routed through
  // this — those are the page's own to say.
  const announce = (text, act) => (opts.narrated ? act() : sayThen(text, act));
  // While the passkey dialog is up, nothing else may act — but recalibrate
  // and confirm/cancel must still get through, or losing tracking mid-dialog
  // traps you in it with no way out.
  if (checkoutOpen() &&
      !["approve_checkout", "cancel_checkout", "setup_passkey",
        "confirm", "cancel", "recalibrate"].includes(verb)) {
    bus.emit("SAY", { text: "Finish or cancel this checkout first." });
    return false;
  }
  switch (verb) {
    case "scroll_start": {
      if (!["up", "down"].includes(args.dir)) return false;
      const speed = args.speed === "fast" ? 4 : args.speed === "slow" ? 2 : autoScroll.dir ? autoScroll.speed : 3;
      startAutoScroll(args.dir === "down" ? 1 : -1, speed);
      if (!opts.narrated) bus.emit("SAY", { text: `Scrolling ${args.dir}.` });
      break;
    }
    case "scroll_stop":
      if (!stopAutoScroll(!opts.narrated)) {
        // Nothing was moving, so "stop" was aimed at the talking.
        voice.stopSpeaking?.();
        return false;
      }
      break;
    case "scroll":
      stopAutoScroll(false);
      if (!["up", "down", "left", "right", "top", "bottom"].includes(args.dir)) return false;
      if (args.dir === "top" || args.dir === "bottom") {
        const box = pageScroller();
        const top = args.dir === "top" ? 0 : (box ? box.scrollHeight : document.documentElement.scrollHeight);
        (box || window).scrollTo({ top, behavior: "smooth" });
      } else {
        const horizontal = args.dir === "left" || args.dir === "right";
        const step = args.dir === "up" || args.dir === "left" ? -1 : 1;
        const box = scrollerAt(innerWidth / 2, innerHeight / 2, horizontal);
        const amount = step * ((box ? (horizontal ? box.clientWidth : box.clientHeight)
          : (horizontal ? innerWidth : innerHeight)) * 0.75);
        if (box) box.scrollBy({ [horizontal ? "left" : "top"]: amount, behavior: "smooth" });
        else window.scrollBy({ [horizontal ? "left" : "top"]: amount, behavior: "smooth" });
      }
      break;
    case "history":
      stopAutoScroll(false);
      if (args.dir === "back") history.back();
      else if (args.dir === "forward") history.forward();
      else return false;
      break;
    // "the second one" still counts products in reading order; nothing is
    // numbered on screen any more, so this is the agent's own ordinal.
    case "focus_nth": {
      const t = nth(args.n);
      if (!t) {
        bus.emit("SAY", { text: "I don't see that many items here." });
        return false;
      }
      if (t.kind === "control") {
        gaze.setFocus(t);
        if (/add to|checkout|check out|buy now|\bpay\b|place order/i.test(t.label)) {
          bus.emit("SAY", { text: `${t.label}. Say it if you want me to use it.` });
          break;
        }
        bus.emit("SAY", { text: `Opening ${t.label}.` });
        t.el.click();
        break;
      }
      // Naming an item tells us exactly where the eyes were. Hand that back to
      // the tracker as a true training pair — the one moment we have ground
      // truth, and it is free.
      if (gaze.learnFromSelection(t)) persistCalibration();
      gaze.setFocus(t);
      voiceNamed = true;
      if (t.kind === "product") {
        discussed = briefProduct(t.product);
        comparisons.remember(t.product);
        persistShopper();
      }
      break;
    }
    case "stop_cue":
      stopCue();
      break;
    case "click_focused": {
      const target = gaze.getFocus();
      if (target?.kind !== "action") {
        bus.emit("SAY", { text: "Tell me which button and I'll press it." });
        return false;
      }
      target.el.click();
      break;
    }
    case "select_variant": {
      const el = scope()?.querySelector(
        `[data-cue-action="select_variant"][data-cue-value="${CSS.escape(String(args.value).toUpperCase())}"],` +
        `[data-aura-action="select_variant"][data-aura-value="${CSS.escape(String(args.value).toUpperCase())}"]`);
      if (!el) { bus.emit("SAY", { text: `I don't see size ${args.value} on this one.` }); return false; }
      el.click();
      if (stated.id) stated.size = String(args.value).toUpperCase();
      break;
    }
    case "select_color": {
      const value = String(args.value);
      const el = scope()?.querySelector(
        `[data-aura-action="select_color"][data-aura-value="${CSS.escape(value)}"]`);
      if (!el) { bus.emit("SAY", { text: `I don't see ${value} on this one.` }); return false; }
      el.click();
      if (stated.id) stated.color = value;
      break;
    }
    case "add_to_cart": {
      // "Close the comparison and add the AirPods" names the item, and after
      // the panel closes there is nothing focused to scope by. Resolving the
      // name first is what makes a two-part command land on the right product.
      // Adding ends the comparison, the same way the panel's own Add button
      // does. The model does not reliably pair dismiss with the add when both
      // are asked for in one sentence, and it should not have to: once the
      // item is chosen the panel has done its job.
      compare.close();
      if (args.item) {
        const want = resolveKnown(args.item);
        if (want) {
          discussed = briefProduct(want) ?? discussed;
          persistShopper();
          pinDiscussed();
        }
      }
      // Nothing may be focused at all: gaze can be off and there are no badge
      // numbers any more, so on a detail page there is no signal to scope by.
      // The product that fills the page is the one meant — the same fallback
      // click_named uses. Carousel neighbours are small, so a single dominant
      // product is an unambiguous target rather than a guess. Without this,
      // every add on Amazon answered "Which one do you mean?" forever.
      if (!scope()) {
        const products = scan().filter((t) => t.kind === "product");
        // The product that owns the page's add control is the one meant.
        // Width is not a usable proxy: the same site renders this region at
        // 99% of the viewport on one listing and 45% on the next. On a
        // results page several cards own one, which stays ambiguous, and
        // asking is the right answer there.
        const owning = products.filter((t) => addButtonIn(t.el));
        const main = owning.length === 1
          ? owning
          : products.filter((t) => t.rect.width >= innerWidth * 0.5);
        if (main.length === 1) { gaze.setFocus(main[0]); gaze.holdFocus(); }
      }
      // MUST be scoped to what they were looking at. A global querySelector here
      // adds the first product on the page — i.e. charges for the wrong item.
      const card = scope();
      const named = discussed?.title;
      const el = addControl(card);
      if (!el) {
        bus.emit("SAY", { text: named
          ? `I heard ${named}, but I don't see an add button for it on this page.`
          : "Which one do you mean?" });
        return false;
      }

      // The bag is where a wrong item first gets in, and at 300px of gaze
      // error that is a live possibility on every add. So an add is read back
      // and waits, exactly like a charge. Done here rather than per-caller so
      // the spoken command and the agent are held to the same bar.
      if (!opts.confirmed) {
        applyStated(card);
        const d = describeAdd(card);
        if (d.missing.size || d.missing.color) {
          pendingConfirm = { kind: "options" };
          bus.emit("SAY", { text: optionPrompt(d.title, d.missing, productData(card)) });
          return false;
        }
        pendingConfirm = { kind: "add", el, said: d.line };
        // The reply has just said the item and the price better than this
        // template can. Repeating it in full is the second voice.
        bus.emit("SAY", { text: opts.narrated ? "Add it?" : `${d.line} Add it?` });
        break;
      }
      applyStated(card);

      const before = window.CART?.().length;
      pressControl(el);
      if (before !== undefined && window.CART().length === before) return false;
      // On a real site there is no bag to count, so nothing here could tell
      // the shopper whether the press landed. It said nothing at all, which
      // after "Add it?" / "Yes" is indistinguishable from being ignored —
      // and the only other voice in the room was the model claiming it was
      // already done. Say what we actually did.
      if (before === undefined) bus.emit("SAY", { text: "Added." });
      break;
    }
    // Taking something back out has to be as easy as putting it in, and is
    // confirmed the same way — removing the wrong thing is its own mistake.
    case "remove_item": {
      const bag = window.cueBag;
      if (!bag) { bus.emit("SAY", { text: "There's no bag on this page." }); return false; }
      const list = bag.items();
      if (!list.length) { bus.emit("SAY", { text: "Your bag is already empty." }); return false; }

      let target = null;
      if (args.name) {
        const q = String(args.name).toLowerCase();
        target = list.find((i) => i.title.toLowerCase().includes(q));
        if (!target) {
          bus.emit("SAY", { text: `I don't see ${args.name} in your bag.` });
          return false;
        }
      } else if (typeof args.n === "number") {
        target = list[args.n - 1];
        if (!target) { bus.emit("SAY", { text: `There are only ${list.length} things in your bag.` }); return false; }
      } else {
        target = list[list.length - 1];      // "take that back out" = the last one
      }

      if (!opts.confirmed) {
        // Hold an IDENTITY, not an array index. Between the question and the
        // yes the bag can change — the agent adds something, the user hits a
        // Remove button — and a stale index then deletes a different item.
        // On a confirmation whose only job is preventing wrong actions, that
        // is the worst possible bug.
        pendingConfirm = { kind: "remove", item: target };
        bus.emit("SAY", { text: `Take the ${target.title}${target.size ? `, size ${target.size}` : ""} back out?` });
        break;
      }
      bag.remove(target.idx);
      bus.emit("SAY", { text: `Removed the ${target.title}.` });
      break;
    }
    case "read_bag": {
      // On a real site the bag is the SITE's cart, not Cue's own. Read it from
      // the site's cart page with the shopper's own session; never say "empty"
      // when we simply could not see it.
      if (CONFIG.injected && !window.cueBag) { void readSiteCart(); break; }
      const list = window.cueBag?.items() ?? [];
      if (!list.length) { bus.emit("SAY", { text: "Your bag is empty." }); break; }
      const lines = list.map((i, k) => `${k + 1}, ${i.title}${i.size ? `, size ${i.size}` : ""}`);
      const total = list.reduce((sum, i) => sum + (i.price ?? 0), 0);
      bus.emit("SAY", { text: `${lines.join(". ")}. That's $${total.toFixed(2)}.` });
      break;
    }
    case "open_bag": window.cueBag?.open?.(); break;
    case "checkout": stageCheckout(); break;
    case "confirm":
      if (checkoutOpen()) window.cueCheckout.approve();
      else if (!resolveConfirm(true)) bus.emit("SAY", { text: "There's nothing waiting for approval." });
      break;
    case "cancel":
      if (checkoutOpen()) window.cueCheckout.cancel();
      else if (!resolveConfirm(false)) bus.emit("SAY", { text: "Okay." });
      break;
    // The router maps a bare "yes" to approve_checkout, since its anchored
    // checkout rules are tried first. But "yes" also has to work for the
    // staged-order readback when no passkey dialog is open — and only the
    // page knows which of those is true. Reconcile here.
    case "approve_checkout":
      if (checkoutOpen()) window.cueCheckout.approve();
      else if (!resolveConfirm(true)) bus.emit("SAY", { text: "There's nothing waiting for approval." });
      break;
    case "cancel_checkout":
      if (checkoutOpen()) {
        window.cueCheckout.cancel();
        bus.emit("SAY", { text: "Okay, checkout cancelled." });
      } else if (!resolveConfirm(false)) {
        // Nothing was waiting, so "no" was almost certainly aimed at whatever
        // popped up — the warranty upsell after an add. Saying "Okay." and
        // leaving it on screen is the least useful thing Cue can do.
        const how = dismissOverlay();
        bus.emit("SAY", { text: how === "nothing" ? "Okay."
          : how === "escaped" ? "Tried to close it — tell me if it's still there." : "Closed it." });
      }
      break;
    case "compare": {
      const a = resolveKnown(args.a), b = resolveKnown(args.b);
      if (!a || !b || a.id === b.id) {
        const seen = scanAll().slice(0, 2).map((p) => p.product.title.slice(0, 40));
        bus.emit("SAY", { text: seen.length
          ? `I need two things to compare. I can see the ${seen.join(", and the ")}.`
          : "Tell me the two you want compared." });
        return false;
      }
      comparing = { a, b };
      if (!opts.narrated) bus.emit("SAY", { text: `Putting them side by side.` });
      void compare.open(a, b);
      break;
    }
    case "dismiss": {
      // Cue's own panel is a dialog like any other, but closing it by guessing
      // at our own markup is silly when we hold the handle.
      if (compare.isOpen()) {
        compare.close();
        if (!opts.narrated) bus.emit("SAY", { text: "Closed it." });
        break;
      }
      const how = dismissOverlay();
      if (how === "nothing") { bus.emit("SAY", { text: "There's nothing open to close." }); return false; }
      bus.emit("SAY", { text: how === "escaped" ? "Tried to close it — tell me if it's still there." : "Closed it." });
      break;
    }
    case "setup_passkey":
      if (window.cueCheckout?.register) window.cueCheckout.register();
      else bus.emit("SAY", { text: "There's no passkey set-up on this page." });
      break;
    case "recalibrate": {
      const cameraUnavailable = gaze.getState().mode !== "webgazer" || !gaze.getState().running;
      if (gaze.getState().mode !== "webgazer") {
        bus.emit("SAY", { text: "Eye tracking is not running. I'll try the camera again." });
      }
      recalibrate().catch(e => {
        console.error("[cue] recalibration failed", e);
        bus.emit("SAY", { text: "I couldn't recalibrate. Please check the camera." });
      });
      // The server's stock "recalibrating" line must not claim success when
      // the camera is still in mouse fallback mode.
      if (cameraUnavailable) return false;
      break;
    }
    // "click the bag", "open women's coats", "go to checkout" — resolve a
    // spoken phrase against the page's own accessibility names and click it.
    // Works on a page nobody tagged for Cue, which is the whole point.
    case "search": {
      const q = String(args.query || "").trim().slice(0, 120);
      if (q.length < 2) {
        bus.emit("SAY", { text: "What should I search for?" });
        return false;
      }
      void runSearch(q, Boolean(opts.narrated));
      break;
    }
    case "open_link": {
      const item = resolveKnown(args.target);
      const link = item && knowledge.linkFor(item, args.part || "product");
      if (!link) {
        const near = scanAll().slice(0, 2).map((p) => p.product.title.slice(0, 40)).filter(Boolean);
        bus.emit("SAY", { text: item ? `I don't have its ${args.part || "page"} link.`
          : near.length ? `I can't place that one. I can see the ${near.join(", and the ")}.`
          : "I'm not sure which item you mean." });
        return false;
      }
      discussed = briefProduct({ ...item, url: item.url }) ?? discussed;
      persistShopper();
      announce(args.part === "reviews" ? `Opening the reviews for ${item.title.slice(0, 50)}.`
        : `Opening ${item.title.slice(0, 60)}.`, () => location.assign(link));
      break;
    }
    case "click_named":
    case "open_named": {
      const spoken = String(args.name ?? args.text ?? "");
      // "select medium" on a product is a size, not a button called Medium.
      // On a product page with nothing focused, the page's own product is meant.
      if (!scope()) {
        const main = scan().filter((t) => t.kind === "product" && t.rect.width >= innerWidth * 0.5);
        if (main.length === 1) { gaze.setFocus(main[0]); gaze.holdFocus(); }
      }
      const product = productData(scope());
      const opt = product ? matchOptions(spoken, product) : {};
      if ((opt.size || opt.color) && onlyOptions(spoken, opt.color)) {
        if (opt.size && perform("select_variant", { value: opt.size }, opts) === false) return false;
        if (opt.color && perform("select_color", { value: opt.color }, opts) === false) return false;
        rememberSpokenOptions(spoken);
        break;
      }
      // A native dropdown: "select price low to high". An exact option beats
      // a sound-alike button; otherwise buttons win.
      const choice = findOption(spoken);
      if (choice && (norm(choice.name) === norm(spoken) || !findControl(spoken))) {
        choice.select.value = choice.option.value;
        choice.select.dispatchEvent(new Event("input", { bubbles: true }));
        choice.select.dispatchEvent(new Event("change", { bubbles: true }));
        bus.emit("SAY", { text: `${choice.name}.` });
        break;
      }
      // Home is usually the logo, which is named after the shop, not "home".
      const home = /^(?:the )?home(?: ?page)?$/i.test(spoken.trim()) && !findControl(spoken)
        ? [...document.querySelectorAll("a[href]")].find((a) => !a.closest("#aura-root") &&
            new URL(a.href, location.href).origin === location.origin &&
            new URL(a.href, location.href).pathname === "/")
        : null;
      const c = home ? { name: "the home page", el: home } : findControl(spoken);
      const page = c ? null : matchPage(args.name ?? args.text ?? "", site);
      if (!c && page?.url) {
        const link = [...document.querySelectorAll("a[href]")].find((a) => a.href === page.url);
        announce(`Opening ${page.name || page.title}.`,
          () => (link ? link.click() : location.assign(page.url)));
        break;
      }
      if (!c) {
        const near = controls().slice(0, 6).map((x) => x.name).filter(Boolean);
        bus.emit("SAY", { text: near.length
          ? `I can't find ${args.name}. I can see ${near.slice(0, 3).join(", ")}.`
          : `I can't find ${args.name} on this page.` });
        return false;
      }
      // Money controls are allowed here. They are not a back door: the page
      // announces exactly what went into the bag and holds the budget, and the
      // checkout control only stages an order for readback. The charge still
      // needs a spoken yes and a passkey, which is the guarantee that matters.
      // On a real site inside the extension there is no passkey rail, so a
      // control that spends money is the shopper's to press, never Cue's.
      // A control that spends money is never pressed on the utterance that
      // named it. Cue says what it is about to do and waits for a separate
      // spoken yes — the same bar as an add, and for the same reason: speech
      // is misheard and gaze is broad, so one utterance must not buy.
      // `confirm` and `approve_checkout` are human-only (sanitize() strips
      // them from the model and the dispatch loop refuses them from "grok"),
      // so the agent cannot approve its own purchase here.
      if (COMMITS_MONEY.test(c.name) && CONFIG.injected) {
        confirmMoney(c.el, c.name);
        break;
      }
      // Say what is about to happen before it happens — on a page the user
      // cannot see well, a silent navigation is disorienting.
      announce(`Opening ${speakableName(c.name)}.`, () => pressControl(c.el));
      break;
    }
    // "type john into the name field" — fills a field, never touches
    // passwords or card numbers (resolver.fields() filters those out). With no
    // field named it types where a person would: a field the shopper put the
    // cursor in, then the search box. Focus Cue left behind from its own last
    // typing does not count, or "type desk top" lands in the email box.
    case "fill": {
      const named = String(args.field ?? "").trim();
      const active = document.activeElement;
      const focusedField = active !== lastTyped?.el ? fields().find((f) => f.el === active)?.el ?? null : null;
      const el = named ? findField(named) : (focusedField ?? searchBox() ?? findField(""));
      if (!el) {
        const names = fields().map((f) => f.name).filter(Boolean).slice(0, 3);
        bus.emit("SAY", { text: names.length
          ? `I can't find that field. I can see ${names.join(", ")}.`
          : "I don't see anything to type into here." });
        return false;
      }
      const typed = String(args.text ?? "").slice(0, 200);
      setText(el, typed);
      lastTyped = { el, text: typed };
      actionSay(`Typed ${typed}.`);
      break;
    }
    // "press enter" after typing, or "type X and search".
    case "submit": {
      const active = document.activeElement;
      const el = (lastTyped?.el?.isConnected ? lastTyped.el : null) ??
        (fields().find((f) => f.el === active)?.el ?? null) ?? searchBox();
      if (!el) {
        bus.emit("SAY", { text: "There's nothing typed to submit." });
        return false;
      }
      const text = lastTyped?.el === el ? lastTyped.text : el.value;
      actionSay(text ? `Entering ${text}.` : "Pressing enter.");
      submitField(el);
      invalidate();
      break;
    }
    case "find_on_page":
      if (!findText(args.text)) {
        bus.emit("SAY", { text: `I can't see ${String(args.text).slice(0, 40)} on this page.` });
        return false;
      }
      break;
    case "back": announce("Going back.", () => history.back()); break;
    case "forward": announce("Going forward.", () => history.forward()); break;
    case "history":
      if (args.dir === "back") history.back();
      else if (args.dir === "forward") history.forward();
      else return false;
      break;
    case "list_controls": {
      const names = controls().slice(0, 8).map((c) => c.name);
      bus.emit("SAY", { text: names.length
        ? `I can see ${names.slice(0, 6).join(", ")}.`
        : "I don't see anything clickable here." });
      break;
    }
    case "navigate": {
      let u;
      try { u = new URL(String(args.url), location.href); } catch { u = null; }
      if (!u || !/^https?:$/.test(u.protocol)) {
        console.warn("[cue] refused navigate to", args.url);
        return false;
      }
      location.href = u.href;
      break;
    }
    default: console.warn("[cue] unknown verb", verb, args); return false;
  }
  return true;
}

// Voice-reachable recalibration. Gaze drifts when you shift in your seat, and
// at a demo table the person in the chair changes every few minutes.
let recalibrating = false;
async function persistCalibration() {
  if (!CONFIG.injected || !globalThis.chrome?.runtime?.sendMessage) return;
  const value = gaze.exportCalibration();
  if (!value) return;
  try { await chrome.runtime.sendMessage({ type: "cue:calibration:write", value }); }
  catch (error) { console.warn("[cue] Could not retain calibration for navigation", error); }
}

async function clearCalibration() {
  if (!CONFIG.injected || !globalThis.chrome?.runtime?.sendMessage) return;
  try { await chrome.runtime.sendMessage({ type: "cue:calibration:clear" }); }
  catch (error) { console.warn("[cue] Could not clear old calibration", error); }
}

async function recalibrate() {
  if (recalibrating) return;
  recalibrating = true;
  try {
    await clearCalibration();
    if (gaze.getState().mode !== "webgazer") {
      const actual = await gaze.start({ mode: "webgazer", sigma: CONFIG.sigma,
        tune: CONFIG.tune, keepData: CONFIG.keepData });
      if (actual !== "webgazer") {
        const reason = gaze.getState().gazeError || "the camera is unavailable";
        bus.emit("SAY", { text: `Eye tracking still can't start: ${reason}. Check camera permission for this page, then try again.` });
        return false;
      }
    }
    if (!gaze.getState().running) {
      bus.emit("SAY", { text: "The camera is still starting. Please try again in a moment." });
      return false;
    }
    const result = await gaze.calibrate();
    if (result === false) {
      bus.emit("SAY", { text: "Eye tracking is not ready yet. Please try again." });
      return false;
    }
    gaze.hideCamera();
    await persistCalibration();
    return true;
  }
  finally { recalibrating = false; }
}

// ── Boot ────────────────────────────────────────────────────────────────────
export async function exitCue() {
  if (exited) return;
  exited = true;
  globalThis.__cueEnded = true;
  pendingConfirm = null;
  analytics.close();
  voice.exitPrivateMode?.();
  voice.stopListening();
  gaze.stop();
  document.querySelectorAll("#aura-root,.cue-splash,.aura-cal,.cue-modal").forEach((el) => el.remove());
  try { globalThis.__cueExternalCleanup?.(); } catch {}
  globalThis.__cueExternalActive = false;
  globalThis.__cueExited = true;
  if (CONFIG.injected && globalThis.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({ type: "cue:exit" }).catch(() => {});
  }
  try { await voice.speak("Cue is off."); } catch {}
}

export async function boot() {
  exited = false;
  mountUI();
  requestAnimationFrame(frame);
  const splash = CONFIG.injected && CONFIG.autoCal && !CONFIG.resuming
    ? playSplash(CONFIG.splashImage) : null;
  const fetched = new Map();
  const refreshSite = () => {
    const point = gaze.getState?.().point;
    crawlNear(document, location.href, (page) => {
      if (!fetched.has(page)) {
        fetched.set(page, fetch(page).then((res) => res.ok ? res.text() : "").catch(() => ""));
      }
      return fetched.get(page);
    }, point, { workers: 2, limit: 3 }).then((found) => { if (!globalThis.__cueEnded) site = found; }).catch(() => {});
  };
  document.addEventListener("routechange", refreshSite);
  if (CONFIG.injected) {
    // Read the products on screen in the background so answers are instant.
    const warm = () => {
      if (document.visibilityState !== "visible" || globalThis.__cueEnded) return;
      learnPage();
      const urls = detailUrls(null).map((p) => p.url);
      details.prefetch(urls, 12);
      for (const u of urls) {
        const facts = details.peek(u);
        if (facts && !knowledge.factsFor(u)) knowledge.setFacts(u, facts);
      }
    };
    setInterval(warm, 3000);
    warm();
  }
  bus.on("STATE", (s) => { if (s.calibrated) refreshSite(); });

  // Ask for the mic BEFORE the camera prompt and before calibration. Chrome
  // will not reliably prompt for it later once a video stream is live, which
  // is why speech looked "broken" rather than "not permitted".
  if (CONFIG.gazeMode === "webgazer") await voice.requestMic();
  if (exited) return;

  // start() reports the mode it ACTUALLY got, which may not be the one asked
  // for — no camera, or a browser blocking WebGL, degrades it to the mouse.
  const actual = await gaze.start({ mode: CONFIG.gazeMode, sigma: CONFIG.sigma,
                                    tune: CONFIG.tune, keepData: CONFIG.keepData,
                                    resume: CONFIG.calibration });
  if (exited) return;
  // Listening starts BEFORE calibration on purpose: "Cue, next" advances the
  // dots, and someone who cannot press space has no other way through the
  // very first screen they meet.
  await voice.startListening();
  if (exited) return;

  // Camera/model setup can run while the mark is on screen. Calibration
  // begins only after its dissolve has finished.
  if (splash) await splash;
  if (exited) return;

  let announced = false;
  if (actual === "webgazer" && gaze.getState().calibrated) {
    announced = true;
  } else if (actual === "webgazer" && CONFIG.autoCal) {
    await gaze.calibrate();
  }
  if (actual === "webgazer") {
    gaze.hideCamera();
    await persistCalibration();
    // calibrate() already said how it went and what to do next. Adding "Cue is
    // ready" on top of it is two spoken lines for one event, and they landed
    // close enough together to talk over each other.
    announced = true;
  }

  if (CONFIG.gazeMode === "webgazer" && actual !== "webgazer" && !CONFIG.resuming) {
    bus.emit("SAY", { text: "I couldn't use the camera, so I'm following the mouse instead. Everything else works." });
  } else if (!announced && !CONFIG.resuming) {
    bus.emit("SAY", { text: "Cue is ready. What are you after?" });
  }
}

// A silent failure in boot is the worst outcome: a blank page with no reason.
bus.on("STATE", (s) => {
  if (!s.gazeError) return;
  ui.said.textContent = `⚠ ${s.gazeError} — using the mouse`;
});

// ── Drift watch ─────────────────────────────────────────────────────────────
// Calibration decays: people shift in their seat, lean in, or a new person sits
// down without recalibrating. Rather than a modal that interrupts, nudge in the
// HUD once confidence has been poor for a sustained stretch.
const DRIFT_WINDOW_MS = 10000;
const DRIFT_CONF = 0.25;
let lowSince = null, nudgedAt = 0;

bus.on("GAZE", ({ confidence }) => {
  const gs = gaze.getState();
  // Low confidence during calibration is expected, not drift. Announcing it
  // there interrupts the very thing that would fix it.
  if (recalibrating || gs.calibrating || !gs.calibrated || gs.mode !== "webgazer") {
    lowSince = null;
    return;
  }
  const t = now();
  if (confidence >= DRIFT_CONF) { lowSince = null; ui.drift?.classList.remove("on"); return; }
  if (lowSince === null) { lowSince = t; return; }
  if (t - lowSince < DRIFT_WINDOW_MS || t - nudgedAt < 45000) return;
  nudgedAt = t;
  lowSince = null;

  // Name the actual cause. "Tracking has drifted" is useless; "you've moved
  // since we calibrated" tells someone what to do about it.
  const reason = gaze.driftReason();
  const msg = {
    face:  ["I can't see your face", "Move back into view of the camera."],
    head:  ["You've moved since we calibrated",
            "Sit back how you were, or say recalibrate."],
    far:   ["You've moved further from the camera",
            "Come back in a bit, or say recalibrate."],
    close: ["You've leaned in since we calibrated",
            "Sit back a little, or say recalibrate."],
    signal:["My tracking has drifted", "Say recalibrate whenever you want to fix it."],
  }[reason ?? "signal"];

  ui.drift.textContent = `${msg[0]} · say “recalibrate”`;
  ui.drift.classList.add("on");
  bus.emit("SAY", { text: `${msg[0]}. ${msg[1]}` });
});

// say() is how you drive Cue with no mic: from the console, from a test, or
// from the on-stage fallback if the demo floor is too loud to be heard.
const say = (text) => { if (!voice.isPrivateMode?.()) bus.emit("UTTERANCE", { text, final: true }); };

function stopCue() {
  void exitCue();
}
bus.on("STOP", stopCue);

window.cue = { bus, gaze, voice, context, seedDemo, compare, perform, boot, say, recalibrate, exit: exitCue, CONFIG,
               measure: (...a) => gaze.measure(...a),
               experiment: (...a) => gaze.experiment(...a),
               head: () => gaze.getHead(),
               get pending() { return pendingConfirm; } };
window.aura = window.cue;          // nothing that already says aura.* breaks


if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
