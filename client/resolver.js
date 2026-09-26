// Maps a gaze point to a targetable element. Only elements carrying
// data-aura-product / data-aura-action are ever considered — that is what makes
// a few centimetres of gaze error harmless.

const MAX_DIST = 320;        // px; beyond this, gaze resolves to nothing

export function scan() {
  const out = [];
  for (const el of document.querySelectorAll("[data-aura-product]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    let product;
    try { product = JSON.parse(el.dataset.auraProduct); }
    catch { console.warn("[aura] bad data-aura-product", el); continue; }
    out.push({ kind: "product", id: product.id, label: product.title, el, rect: r, product });
  }
  for (const el of document.querySelectorAll("[data-aura-action]")) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom < 0 || r.top > innerHeight) continue;
    out.push({
      kind: "action",
      id: "act:" + el.dataset.auraAction + ":" + (el.dataset.auraValue ?? ""),
      label: el.dataset.auraLabel ?? el.textContent.trim(),
      el, rect: r, verb: el.dataset.auraAction, value: el.dataset.auraValue,
    });
  }
  return out;
}

// Distance from point to rect (0 if inside). Containment always beats proximity.
function dist(x, y, r) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

export function resolve(x, y, targets) {
  let best = null, bestD = Infinity;
  for (const t of targets) {
    const d = dist(x, y, t.rect);
    // Actions are small; give them a modest bonus so a button inside a card can win.
    const score = t.kind === "action" ? d * 0.75 : d;
    if (score < bestD) { bestD = score; best = t; }
  }
  return bestD <= MAX_DIST ? { target: best, dist: bestD } : { target: null, dist: bestD };
}

// Ordinal reference: "the second one" -> nth product in reading order.
export function nth(n) {
  const ps = scan().filter(t => t.kind === "product")
    .sort((a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));
  return ps[n - 1] ?? null;
}
