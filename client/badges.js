// Numbered selection badges.
//
// Measured gaze error on a real face is 242px. Amazon's product tiles are
// 249px wide. Gaze therefore cannot pick an item — it can pick a neighbourhood.
// So gaze narrows to a few candidates, we stamp big numbers on them, and the
// voice picks one: "two".
//
// This is what makes the whole thing work for a stranger who walks up to the
// table, and it is the only part of the interaction that is legible to an
// audience standing three feet behind them.

import { bus } from "./bus.js";
import { scan, controls } from "./resolver.js";

// How many candidates to number, and how far out to look for them. Both scale
// with how accurate gaze actually turned out to be.
//
// At ~150px, gaze genuinely narrows the field and numbering the nearest four
// is a precise, low-noise affordance. At the 341px we have measured, gaze
// barely narrows anything — so numbering only four risks the wanted item not
// being among them, which is the one failure the whole design exists to avoid.
// Past that point we number everything on screen and let the voice do all the
// work. Slightly busier, but it cannot miss.
const TIERS = [
  { upTo: 160,      max: 4, radius: 460 },
  { upTo: 240,      max: 6, radius: 620 },
  { upTo: Infinity, max: 9, radius: Infinity },   // number everything visible
];
let tier = TIERS[0];

/** Called with the measured calibration error, in px. */
export function setPrecision(px) {
  tier = TIERS.find((t) => px <= t.upTo) ?? TIERS.at(-1);
  console.log(`[cue] badges tuned for ${Math.round(px)}px:`,
              `up to ${tier.max}`,
              tier.radius === Infinity ? "(everything on screen)" : `within ${tier.radius}px`);
  root && (root.dataset.sig = "");    // force a rebuild
}

let root = null;
let shown = [];          // [{ target, n, el }]
let enabled = true;

export function mount(parent) {
  root = document.createElement("div");
  root.className = "cue-badges";
  (parent ?? document.body).appendChild(root);
}

export function setEnabled(on) {
  enabled = on;
  if (!on) clear();
}

export function clear() {
  if (root) {
    root.textContent = "";
    // The signature must go too. update() short-circuits when the computed
    // signature matches the last one, so leaving a stale sig here means the
    // badges never come back after a clear — which is every recalibration.
    delete root.dataset.sig;
  }
  shown = [];
}

// Distance from a point to a rect (0 inside) — same metric the resolver uses,
// so what gets numbered matches what would get focused.
function dist(x, y, r) {
  const dx = Math.max(r.left - x, 0, x - r.right);
  const dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}

/** Recompute which products are numbered, from the current gaze point. */
export function update(x, y, focusedId) {
  if (!enabled || !root) return;

  const products = scan().filter((t) => t.kind === "product");
  // Buttons and icons get numbers too, so a shop can be moved through before
  // any product is tagged. Skip controls that already sit on a numbered card.
  const chrome = controls()
    .filter((c) => c.rect.width >= 28 && c.rect.height >= 24)
    .filter((c) => !c.el.closest?.("[data-cue-product],[data-aura-product]"))
    .map((c) => ({
      kind: "control", id: "ctl:" + c.name.toLowerCase(), label: c.name, el: c.el, rect: c.rect,
    }));
  const pool = [...products, ...chrome];
  if (!pool.length) { clear(); return; }

  // Reading order, so the numbers a user sees are stable and match "the third
  // one" — two ways of saying the same thing must never disagree.
  const ordered = [...pool].sort(
    (a, b) => (a.rect.top - b.rect.top) || (a.rect.left - b.rect.left));

  const near = ordered
    .map((t) => ({ t, d: dist(x, y, t.rect) }))
    .filter((o) => o.d <= tier.radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, tier.max)
    .map((o) => o.t);

  if (!near.length) { clear(); return; }

  // Number them in reading order, not by distance — a number that jumps around
  // as your eyes drift is worse than no number at all.
  const picked = ordered.filter((t) => near.includes(t));

  const sig = picked.map((t) => t.id).join("|") + "#" + (focusedId ?? "");
  if (sig === root.dataset.sig) { reposition(); return; }
  root.dataset.sig = sig;

  root.textContent = "";
  shown = picked.map((target, k) => {
    const box = document.createElement("div");
    box.className = "cue-cand";
    box.dataset.focused = String(target.id === focusedId);
    box.dataset.kind = target.kind;
    root.appendChild(box);

    const el = document.createElement("div");
    el.className = "cue-badge";
    el.textContent = String(k + 1);
    el.dataset.focused = String(target.id === focusedId);
    el.dataset.kind = target.kind;
    root.appendChild(el);
    return { target, n: k + 1, el, box };
  });
  reposition();
}

/** Keep badges glued to their cards while the page scrolls or reflows. */
export function reposition() {
  for (const b of shown) {
    const r = b.target.el.getBoundingClientRect();
    const off = r.width === 0 || r.bottom < 0 || r.top > innerHeight;
    b.el.style.opacity = off ? "0" : "1";
    if (b.box) b.box.style.opacity = off ? "0" : "1";
    if (off) continue;
    b.el.style.transform = `translate3d(${Math.round(r.left + 10)}px, ${Math.round(r.top + 10)}px, 0)`;
    if (b.box) {
      b.box.style.transform = `translate3d(${Math.round(r.left)}px, ${Math.round(r.top)}px, 0)`;
      b.box.style.width = Math.round(r.width) + "px";
      b.box.style.height = Math.round(r.height) + "px";
    }
  }
}

export function setFocused(id) {
  for (const b of shown) {
    const on = String(b.target.id === id);
    b.el.dataset.focused = on;
    if (b.box) b.box.dataset.focused = on;
  }
}

/** Resolve a spoken number to the target it is currently stamped on. */
export function byNumber(n) {
  return shown.find((b) => b.n === n)?.target ?? null;
}

export const getShown = () => shown.map((b) => ({ n: b.n, id: b.target.id, label: b.target.label }));
export const getTier = () => ({ ...tier });

// Anything that changes layout invalidates positions. Guarded so the module
// can be imported outside a browser (tests, tooling).
if (typeof addEventListener === "function") {
  addEventListener("scroll", reposition, { passive: true });
  addEventListener("resize", reposition);
}
bus.on("FOCUS", ({ target }) => setFocused(target?.id ?? null));
