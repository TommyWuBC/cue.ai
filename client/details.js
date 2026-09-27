// What a product's own page says, read in the background so Cue can answer
// "does it have noise cancelling?" without the shopper opening it.
//
// Bounded on purpose: same origin, https, product-looking URLs only (never cart,
// checkout, sign-in or order pages), GET only, two at a time, a size and time
// cap, results cached. It sends the shopper's own cookies because Amazon serves
// a robot check to cookieless requests; a product-page GET changes nothing. Everything read is
// untrusted evidence for the agent, never an instruction.

import { canonicalProductUrl } from './knowledge.js';

// Measured on two live Amazon listings at 1.88 MB each: the old 1.5 MB cap
// discarded the last ~380 KB of every one before parsing ever saw it.
export const MAX_HTML = 4_000_000;
const TIMEOUT_MS = 6000;
const MAX_CACHE = 80;

const clean = (v, n = 160) => String(v ?? "").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, n);

export function safeProductUrl(url, pageUrl) {
  try {
    if (new URL(pageUrl).protocol !== "https:") return null;
    const canon = canonicalProductUrl(url, pageUrl);
    return canon && new URL(canon).protocol === "https:" ? canon : null;
  } catch { return null; }
}

export function isBlocked(html) {
  return /validateCaptcha|robot check|enter the characters you see|automated access|are you a human/i.test(html.slice(0, 20000));
}

function jsonLd(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const walk = (n) => {
        if (Array.isArray(n)) return n.forEach(walk);
        if (!n || typeof n !== "object") return;
        const t = [].concat(n["@type"] || []).join(" ");
        if (/\bProduct\b/i.test(t)) out.push(n);
        walk(n["@graph"]);
      };
      walk(JSON.parse(m[1]));
    } catch { /* ignore a broken block */ }
  }
  return out[0] || null;
}

/** Compact facts from a product page's HTML. `doc` is optional (DOMParser result). */
export function factsFromHtml(html, doc = null) {
  const facts = {};
  const ld = jsonLd(html);
  if (ld) {
    const offer = [].concat(ld.offers || [])[0] || {};
    const rating = ld.aggregateRating || {};
    facts.title = clean(ld.name, 120);
    facts.brand = clean(ld.brand?.name || ld.brand, 40);
    facts.about = clean(ld.description, 320);
    if (offer.price != null) facts.price = `${clean(offer.priceCurrency, 4)} ${clean(offer.price, 12)}`.trim();
    if (rating.ratingValue) facts.rating = `${clean(rating.ratingValue, 4)} from ${clean(rating.reviewCount || rating.ratingCount || "?", 10)} reviews`;
    if (offer.availability) facts.availability = clean(String(offer.availability).split("/").pop(), 30);
  }
  if (doc) {
    const q = (s) => doc.querySelector(s);
    const t = (s, n) => clean(q(s)?.textContent, n);
    facts.title ||= t("#productTitle", 120) || t("h1", 120);
    facts.brand ||= t("#bylineInfo", 60);
    facts.price ||= t(".a-price .a-offscreen", 20);
    facts.rating ||= clean(q("#acrPopover")?.getAttribute("title") || t("#acrPopover .a-icon-alt", 30), 30);
    const count = t("#acrCustomerReviewText", 30);
    if (facts.rating && count && !/from/.test(facts.rating)) facts.rating += `, ${count}`;
    facts.availability ||= t("#availability", 60);
    const bullets = [...doc.querySelectorAll("#feature-bullets li span.a-list-item, [data-feature-name='featurebullets'] li")]
      .map((n) => clean(n.textContent, 150)).filter((s) => s.length > 8).slice(0, 6);
    if (bullets.length) facts.highlights = bullets;
    const specs = [...doc.querySelectorAll("#productOverview_feature_div tr, #productDetails_techSpec_section_1 tr")]
      .map((tr) => [...tr.querySelectorAll("th,td")].map((c) => clean(c.textContent, 60)).filter(Boolean).join(": "))
      .filter((s) => s.includes(":")).slice(0, 8);
    if (specs.length) facts.specs = specs;
    // Amazon ships more than one markup for reviews and varies it by listing:
    // one session measured reviewText on two pages, another measured neither
    // hook on two others. Accept them all rather than trading one miss for
    // another. Many listings carry no review text in the HTML at all, which is
    // not a failure — the agent is told to say the page does not say.
    const reviews = [...doc.querySelectorAll("[data-hook='reviewText'] span, " +
      "[data-hook='review-body'] span, [data-hook='review-collapsed'] span")]
      .map((n) => clean(n.textContent, 220)).filter((s) => s.length > 20).slice(0, 3);
    if (reviews.length) facts.reviews = reviews;
    // Measured on live listings: individual review text is not in the page at
    // all any more, signed out — the reviews section carries only the star
    // histogram. That histogram is honest, specific and always there, and a
    // high one-star share is exactly what a shopper wants flagged. The
    // aria-labels read "68 percent of reviews have 5 stars".
    const stars = {};
    for (const el of doc.querySelectorAll("[aria-label]")) {
      const m = (el.getAttribute("aria-label") || "")
        .match(/(\d+)\s*percent of reviews have (\d)\s*stars?/i);
      if (m) stars[m[2]] = Number(m[1]);
    }
    if (Object.keys(stars).length >= 4) {
      facts.star_breakdown = [5, 4, 3, 2, 1]
        .filter((n) => stars[n] != null).map((n) => `${n} star ${stars[n]}%`);
    }
    const says = t("[data-hook='cr-insights-widget-summary'], #product-summary p", 300);
    if (says) facts.customers_say = says;
    facts.about ||= t("#productDescription", 320) || clean(q("meta[name='description']")?.getAttribute("content"), 320);
  }
  for (const k of Object.keys(facts)) if (!facts[k] || facts[k].length === 0) delete facts[k];
  return Object.keys(facts).length >= 2 ? facts : null;
}

export function createDetails({ fetchImpl = globalThis.fetch, parse = null, pageUrl = () => location.href } = {}) {
  const cache = new Map();      // url -> facts | null
  // Why pages did or did not yield facts, so the server log can say.
  const stats = { asked: 0, rejected: 0, fetched: 0, http: 0, blocked: 0, nofacts: 0, ok: 0, error: 0, last: "" };
  const pending = new Map();    // url -> Promise
  let running = 0;
  const queue = [];

  const domParse = parse || ((html) => (typeof DOMParser === "undefined" ? null
    : new DOMParser().parseFromString(html, "text/html")));

  async function load(url) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    try {
      const res = await fetchImpl(url, { credentials: "include", signal: ctl.signal, redirect: "follow" });
      stats.fetched++;
      if (!res.ok) { stats.http++; stats.last = `http ${res.status}`; return null; }
      const html = (await res.text()).slice(0, MAX_HTML);
      if (isBlocked(html)) { stats.blocked++; stats.last = "robot check"; return null; }
      const facts = factsFromHtml(html, domParse(html));
      if (facts) stats.ok++; else { stats.nofacts++; stats.last = `no facts from ${html.length} bytes`; }
      return facts;
    } catch (e) { stats.error++; stats.last = String(e?.name || e).slice(0, 40); return null; }
    finally { clearTimeout(timer); }
  }

  function pump() {
    while (running < 2 && queue.length) {
      const job = queue.shift();
      running++;
      load(job.url).then((facts) => {
        cache.set(job.url, facts);
        if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value);
        job.resolve(facts);
      }).finally(() => { running--; pending.delete(job.url); pump(); });
    }
  }

  function get(url) {
    stats.asked++;
    const safe = safeProductUrl(url, pageUrl());
    if (!safe) { stats.rejected++; stats.last = `rejected ${String(url).slice(0, 60)}`; return Promise.resolve(null); }
    if (cache.has(safe)) return Promise.resolve(cache.get(safe));
    if (!pending.has(safe)) pending.set(safe, new Promise((resolve) => { queue.push({ url: safe, resolve }); pump(); }));
    return pending.get(safe);
  }

  return {
    get,
    stats: () => ({ ...stats, cached: cache.size }),
    prefetch(urls, max = 12) { for (const u of urls.slice(0, max)) void get(u); },
    /** Wait briefly for pages the shopper is asking about, never longer than `ms`. */
    async ensure(urls, ms = 1800) {
      await Promise.race([Promise.all(urls.map(get)), new Promise((r) => setTimeout(r, ms))]);
    },
    peek(url) { const s = safeProductUrl(url, pageUrl()); return s ? cache.get(s) ?? null : null; },
  };
}
