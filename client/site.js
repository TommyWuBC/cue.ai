// What this shop is, learned from the page in front of the shopper and a few
// same-origin links that page already offers. No site-specific selectors.

const SKIP = /^(search|sign in|log in|account|bag|cart|menu|home|skip|close)$/i;

export function sameOrigin(url, pageUrl) {
  try {
    const a = new URL(url, pageUrl);
    const b = new URL(pageUrl);
    if (a.origin !== b.origin) return null;
    if (!/^https?:$/.test(a.protocol)) return null;
    a.hash = "";
    return a.href;
  } catch { return null; }
}

function text(node) {
  return String(node?.textContent || node?.getAttribute?.("aria-label") || "")
    .replace(/\s+/g, " ").trim().slice(0, 80);
}

/** Navigation this page already shows, plus its headings. */
export function readPage(doc, pageUrl) {
  const title = text(doc.querySelector?.("title")) || text(doc.querySelector?.("h1"));
  const headings = [...(doc.querySelectorAll?.("h1, h2") || [])].map(text).filter(Boolean).slice(0, 8);
  const links = [];
  const seen = new Set();
  const anchors = doc.querySelectorAll?.('nav a[href], [role="navigation"] a[href], header a[href]') || [];
  for (const a of anchors) {
    const href = sameOrigin(a.href || a.getAttribute?.("href"), pageUrl);
    const name = text(a);
    if (!href || !name || name.length < 2 || SKIP.test(name) || seen.has(href)) continue;
    seen.add(href);
    links.push({ name, url: href });
    if (links.length >= 12) break;
  }
  return { title, headings, links };
}

/** Visible text of a page, capped so it can be handed to the agent. */
export function pageText(doc, limit = 1400) {
  const bits = [];
  const title = text(doc.querySelector?.("title"));
  if (title) bits.push(title);
  for (const node of doc.querySelectorAll?.("h1, h2, h3") || []) {
    const line = text(node);
    if (line) bits.push(line);
  }
  const body = String(doc.body?.innerText || doc.body?.textContent || "").replace(/\s+/g, " ").trim();
  if (body) bits.push(body);
  return bits.join("\n").slice(0, limit);
}

/** Same-origin links ordered by how close they are to where the shopper is looking. */
export function linksNear(doc, pageUrl, point) {
  const px = point?.x ?? 0, py = point?.y ?? 0;
  const seen = new Set();
  const scored = [];
  for (const a of doc.querySelectorAll?.("a[href]") || []) {
    const href = sameOrigin(a.href || a.getAttribute?.("href"), pageUrl);
    const name = text(a);
    if (!href || !name || name.length < 2 || SKIP.test(name) || seen.has(href)) continue;
    seen.add(href);
    let d = 1e9;
    try {
      const r = a.getBoundingClientRect();
      if (r?.width) d = Math.hypot(r.left + r.width / 2 - px, r.top + r.height / 2 - py);
    } catch { /* a link with no box stays last */ }
    scored.push({ name, url: href, d });
  }
  scored.sort((a, b) => a.d - b.d);
  return scored;
}

async function snippet(url, name, fetchText) {
  let html = "";
  try { html = await fetchText(url); } catch { return { title: name, url, text: "" }; }
  if (typeof html !== "string" || !html) return { title: name, url, text: "" };
  const parsed = parseHtml(html);
  if (!parsed) return { title: name, url, text: "" };
  const info = readPage(parsed, url);
  return { title: info.title || name, url, headings: info.headings.slice(0, 3), text: pageText(parsed, 400) };
}

/** Several reads at once, of the links nearest the shopper. */
export async function crawlNear(doc, pageUrl, fetchText, point, { workers = 3, limit = 6 } = {}) {
  const here = readPage(doc, pageUrl);
  const targets = linksNear(doc, pageUrl, point).slice(0, limit);
  for (const link of here.links) {
    if (targets.length >= limit) break;
    if (!targets.some((t) => t.url === link.url)) targets.push({ ...link, d: 1e9 });
  }
  const nearby = new Array(targets.length);
  let cursor = 0;
  async function worker() {
    while (cursor < targets.length) {
      const i = cursor++;
      nearby[i] = await snippet(targets[i].url, targets[i].name, fetchText);
    }
  }
  const n = Math.min(workers, targets.length);
  if (n) await Promise.all(Array.from({ length: n }, worker));
  const found = nearby.filter(Boolean);
  return {
    origin: new URL(pageUrl).origin,
    title: here.title,
    headings: here.headings,
    text: pageText(doc, 1400),
    links: here.links,
    nearby: found,
    pages: [{ title: here.title, url: pageUrl, headings: here.headings }, ...found],
  };
}

export function learnSite(doc, pageUrl, fetchText, opts) {
  return crawlNear(doc, pageUrl, fetchText, null, opts);
}

function parseHtml(html) {
  if (typeof DOMParser === "undefined") return null;
  try { return new DOMParser().parseFromString(html, "text/html"); } catch { return null; }
}

/** A page the shopper named, only if this site actually linked to it. */
export function matchPage(phrase, site) {
  const q = String(phrase || "").toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  if (!q || !site) return null;
  const pages = [...(site.links || []), ...(site.pages || [])];
  const named = pages.map((p) => ({ ...p, name: (p.name || p.title || "").toLowerCase() })).filter((p) => p.name && p.url);
  return named.find((p) => p.name === q)
      || named.find((p) => p.name.includes(q) && q.length > 2)
      || named.find((p) => q.includes(p.name) && p.name.length > 2)
      || null;
}
