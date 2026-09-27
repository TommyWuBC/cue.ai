// What Cue has learned about this shop in this visit: every product it has seen,
// the links on each product's card (its page, its reviews), and the facts read
// from its page. Survives page loads, so "the Soundcore one" still means
// something after a search has replaced everything on screen.

const UNSAFE = /\/(?:cart|checkout|signin|sign-in|login|logout|ap\/|gp\/buy|gp\/cart|gp\/css|wishlist|account|order|addtocart|add-to-cart)\b/i;
const PRODUCTISH = /\/(?:dp|gp\/product|product|products|p|item|itm|ip)\//i;
const ASIN = /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i;
const REDIRECT = /\/(?:sspa\/click|gp\/slredirect|aclk|gp\/r\.html)/i;
const KEY = "cue.knowledge.v1";
const TTL = 60 * 60 * 1000;
const MAX_ITEMS = 40;

const clean = (v, n = 160) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

/** Ad and tracking wrappers point at the real page in a query parameter. */
export function unwrap(url, pageUrl) {
  try {
    let a = new URL(url, pageUrl);
    for (let i = 0; i < 2 && REDIRECT.test(a.pathname); i++) {
      const inner = a.searchParams.get("url") || a.searchParams.get("u") || a.searchParams.get("dest");
      if (!inner) break;
      a = new URL(inner, a.origin);
    }
    return a;
  } catch { return null; }
}

/** One stable URL per product, so a sponsored link and the plain one are the same page. */
export function canonicalProductUrl(url, pageUrl) {
  const a = unwrap(url, pageUrl);
  if (!a) return null;
  let page;
  try { page = new URL(pageUrl); } catch { return null; }
  if (a.origin !== page.origin || !/^https?:$/.test(a.protocol)) return null;
  if (UNSAFE.test(a.pathname)) return null;
  const asin = a.pathname.match(ASIN);
  if (asin) return `${a.origin}/dp/${asin[1].toUpperCase()}`;
  if (!PRODUCTISH.test(a.pathname)) return null;
  a.hash = "";
  return a.href;
}

function linkRole(href, label) {
  const text = label.toLowerCase();
  if (/product-reviews|customerreviews|#reviews/i.test(href)) return "reviews";
  if (/\b(?:out of 5 stars|ratings?|reviews?)\b/.test(text)) return "reviews";
  if (/\/stores?\/|\bvisit the\b|\bbrand\b/i.test(href + " " + text)) return "brand";
  if (/buying choices|see options|other sellers|more choices/.test(text)) return "options";
  return null;
}

/** The links inside one product card, by what they are for. */
export function cardLinks(card, pageUrl, productUrl) {
  const links = {};
  if (productUrl) links.product = productUrl;
  for (const a of card?.querySelectorAll?.("a[href]") || []) {
    let href;
    try {
      const u = unwrap(a.getAttribute("href"), pageUrl);
      if (!u || u.origin !== new URL(pageUrl).origin || UNSAFE.test(u.pathname)) continue;
      u.hash = u.hash === "#customerReviews" ? u.hash : "";
      href = u.href;
    } catch { continue; }
    const role = linkRole(href, clean(a.getAttribute("aria-label") || a.textContent, 80));
    if (role && !links[role]) links[role] = href;
    if (!links.product) {
      const canon = canonicalProductUrl(href, pageUrl);
      if (canon) links.product = canon;
    }
  }
  if (!links.reviews && links.product && ASIN.test(links.product)) links.reviews = `${links.product}#customerReviews`;
  return links;
}

function compactFacts(f) {
  if (!f || typeof f !== "object") return null;
  const out = {};
  for (const [k, n] of [["title", 100], ["brand", 40], ["price", 24], ["rating", 40], ["availability", 40],
    ["about", 200], ["customers_say", 260]]) if (f[k]) out[k] = clean(f[k], n);
  for (const [k, n, m] of [["highlights", 110, 4], ["specs", 60, 4], ["reviews", 160, 2]]) {
    if (Array.isArray(f[k]) && f[k].length) out[k] = f[k].slice(0, m).map((x) => clean(x, n));
  }
  return Object.keys(out).length ? out : null;
}

export function createKnowledge({ storage, now = Date.now, page = () => (globalThis.location?.href ?? "") } = {}) {
  let items = new Map();
  try {
    const saved = JSON.parse(storage?.getItem(KEY) || "null");
    if (saved && now() - saved.at < TTL) items = new Map((saved.items || []).map((i) => [i.id, i]));
  } catch { items = new Map(); }

  let timer = null;
  function save() {
    clearTimeout(timer);
    timer = setTimeout(flush, 400);
  }
  function flush() {
    clearTimeout(timer);
    try { storage?.setItem(KEY, JSON.stringify({ at: now(), items: [...items.values()] })); } catch { /* keep it in memory */ }
  }
  const byUrl = (url) => [...items.values()].find((i) => i.url === url || i.links?.product === url);

  return {
    /** entries: [{ product, el }] from the page scan */
    observe(entries) {
      const here = page();
      let changed = false;
      for (const { product, el } of entries || []) {
        if (!product?.id || !product.title) continue;
        const canon = canonicalProductUrl(product.url, here) || null;
        const prev = items.get(product.id) || (canon && byUrl(canon)) || {};
        const links = { ...(prev.links || {}), ...cardLinks(el, here, canon) };
        const next = {
          ...prev, id: prev.id || product.id, title: clean(product.title, 140),
          price: product.price ?? prev.price ?? null, url: canon || prev.url || null,
          links, seenAt: now(), page: here.split("#")[0],
        };
        if (JSON.stringify(prev.links) !== JSON.stringify(links) || prev.title !== next.title) changed = true;
        items.set(next.id, next);
      }
      if (items.size > MAX_ITEMS) {
        const drop = [...items.values()].sort((a, b) => a.seenAt - b.seenAt).slice(0, items.size - MAX_ITEMS);
        for (const d of drop) items.delete(d.id);
      }
      if (changed) save();
    },
    setFacts(url, facts) {
      const item = byUrl(url);
      const compact = compactFacts(facts);
      if (!item || !compact) return;
      item.facts = compact;
      save();
    },
    factsFor(url) { return byUrl(url)?.facts ?? null; },
    get(id) { return items.get(id) ?? null; },
    recent(limit = 10) {
      return [...items.values()].sort((a, b) => b.seenAt - a.seenAt).slice(0, limit);
    },
    /** What the agent is told: enough to resolve "the Soundcore one" after the page changed. */
    brief(limit = 10) {
      const here = page().split("#")[0];
      return this.recent(limit).map((i) => ({
        title: i.title, price: i.price,
        here: i.page === here,
        links: Object.keys(i.links || {}),
        read: Boolean(i.facts),
      }));
    },
    linkFor(item, part = "product") {
      const url = item?.links?.[part] || (part === "product" ? item?.url : null);
      if (url) flush();
      return url || null;
    },
    flush,
  };
}
