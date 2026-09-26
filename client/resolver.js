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
  // Read defensively: this module is imported outside a browser by the node
  // test runner, and will be by the extension in contexts where some of these
  // globals are absent.
  const g = globalThis;
  return `${g.scrollX ?? 0}|${g.scrollY ?? 0}|${g.innerWidth ?? 0}|${g.innerHeight ?? 0}|` +
         `${document.querySelectorAll(PRODUCT_SEL).length}|` +
         `${document.querySelectorAll(ACTION_SEL).length}`;
}

export function scan() {
  const k = key();
  if (cache && k === cacheKey) return cache;

  const out = [];
  for (const el of document.querySelectorAll(PRODUCT_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > (globalThis.innerHeight ?? Infinity)) continue;
    let product;
    try { product = JSON.parse(productJson(el)); }
    catch { console.warn("[cue] bad product json", el); continue; }
    out.push({ kind: "product", id: product.id, label: product.title, el, rect: r, product });
  }
  for (const el of document.querySelectorAll(ACTION_SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > (globalThis.innerHeight ?? Infinity)) continue;
    const verb = actionVerb(el);
    // Scope the id to the owning product, not to rect.top. Mine embedded the
    // y position, so every id changed on scroll and focus could never be held
    // across one. Theirs is right; this keeps it while still honouring the
    // data-cue-* spelling.
    const owner = el.closest(PRODUCT_SEL);
    let productId = "page";
    if (owner) {
      try { productId = JSON.parse(productJson(owner)).id; }
      catch { continue; }
    }
    out.push({
      kind: "action",
      id: "act:" + productId + ":" + verb + ":" + (actionValue(el) ?? ""),
      label: actionLabel(el) ?? el.textContent.trim(),
      el, rect: r, verb, value: actionValue(el), productId,
    });
  }
  cache = out; cacheKey = k;
  return out;
}

export function invalidate() { cache = null; cacheKey = ""; }
// Guarded: this module is imported by the node test runner, which has no DOM.
if (typeof addEventListener === "function") addEventListener("resize", invalidate);

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
  // A button nested in a product card otherwise ties the card at distance 0.
  // Give the actual button a small forgiving hit area, but never prefer a
  // nearby button when the gaze is clearly elsewhere in the card.
  const onAction = targets.filter((t) => t.kind === "action" && dist(x, y, t.rect) <= 16);
  if (onAction.length) {
    const target = onAction.reduce((best, t) =>
      dist(x, y, t.rect) < dist(x, y, best.rect) ? t : best);
    const d = dist(x, y, target.rect);
    return { target, dist: d, score: d };
  }
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
