// Maps a gaze point to a targetable element. Only elements carrying
// data-cue-product / data-cue-action (or the legacy data-aura-* spelling) are
// ever considered — that is what makes a few centimetres of gaze error harmless.

const MAX_DIST = 320;        // px; beyond this, gaze resolves to nothing

const PRODUCT_SEL = "[data-cue-product],[data-aura-product]";
const ACTION_SEL  = "[data-cue-action],[data-aura-action]";

const productJson = (el) => el.dataset.cueProduct ?? el.dataset.auraProduct;
const actionVerb  = (el) => el.dataset.cueAction  ?? el.dataset.auraAction;
const actionValue = (el) => el.dataset.cueValue   ?? el.dataset.auraValue;
const actionLabel = (el) => el.dataset.cueLabel   ?? el.dataset.auraLabel;

// scan() runs ~16x a second from the dwell loop. Re-parsing every product's
// JSON that often is pure garbage generation, so cache until something that
// could move a rect actually changes.
let cache = null;
let cacheKey = "";

function key() {
  return `${scrollX}|${scrollY}|${innerWidth}|${innerHeight}|` +
         `${document.querySelectorAll(PRODUCT_SEL).length}|` +
         `${document.querySelectorAll(ACTION_SEL).length}`;
}

export function scan() {
  const k = key();
  if (cache && k === cacheKey) return cache;

  const out = [];
  for (const el of document.querySelectorAll(PRODUCT_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    let product;
    try { product = JSON.parse(productJson(el)); }
    catch { console.warn("[cue] bad product json", el); continue; }
    out.push({ kind: "product", id: product.id, label: product.title, el, rect: r, product });
  }
  for (const el of document.querySelectorAll(ACTION_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    const verb = actionVerb(el);
    out.push({
      kind: "action",
      id: "act:" + verb + ":" + (actionValue(el) ?? "") + ":" + Math.round(r.top),
      label: actionLabel(el) ?? el.textContent.trim(),
      el, rect: r, verb, value: actionValue(el),
    });
  }
  cache = out; cacheKey = k;
  return out;
}

export function invalidate() { cache = null; cacheKey = ""; }
addEventListener("resize", invalidate);

// Distance from point to rect (0 if inside). Containment always beats proximity.
function dist(x, y, r) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

// Returns the raw distance AND the scored one. The caller's hysteresis has to
// compare like with like; mixing the two let a focused card be compared against
// a 0.75x-discounted challenger and lose when it should not.
export function resolve(x, y, targets) {
  let best = null, bestScore = Infinity, bestDist = Infinity;
  for (const t of targets) {
    const d = dist(x, y, t.rect);
    // Actions are small; give them a modest bonus so a button inside a card can win.
    const score = t.kind === "action" ? d * 0.75 : d;
    if (score < bestScore) { bestScore = score; bestDist = d; best = t; }
  }
  return bestDist <= MAX_DIST
    ? { target: best, dist: bestDist, score: bestScore }
    : { target: null, dist: bestDist, score: bestScore };
}

// Ordinal reference: "the second one" -> nth product in reading order.
export function nth(n) {
  const ps = scan().filter((t) => t.kind === "product")
    .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
  return ps[n - 1] ?? null;
}
