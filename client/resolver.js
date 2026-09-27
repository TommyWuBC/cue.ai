// Maps a gaze point to a targetable element. Only elements carrying
// data-cue-product / data-cue-action (or the legacy data-aura-* spelling) are
// ever considered — that is what makes a few centimetres of gaze error harmless.

import { bestMatch, norm } from "./speech.js";

const MAX_DIST = 320;        // px; beyond this, gaze resolves to nothing

const PRODUCT_SEL = "[data-cue-product],[data-aura-product]";
// Anything a sighted person could click. This is what lets Cue work on a page
// nobody tagged for it: links, buttons and controls are discoverable from the
// accessibility tree, which every real site already has because screen readers
// depend on it.
const CONTROL_SEL = [
  "a[href]", "button", "summary",
  "[role=button]", "[role=link]", "[role=tab]", "[role=menuitem]",
  "input[type=submit]", "input[type=button]",
].join(",");
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
    const g = globalThis, vw = g.innerWidth ?? Infinity, vh = g.innerHeight ?? Infinity;
    if (r.width === 0 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    let product;
    try { product = JSON.parse(productJson(el)); }
    catch { console.warn("[cue] bad product json", el); continue; }
    out.push({ kind: "product", id: product.id, label: product.title, el, rect: r, product });
  }
  for (const el of document.querySelectorAll(ACTION_SEL)) {
    const r = el.getBoundingClientRect();
    const g = globalThis, vw = g.innerWidth ?? Infinity, vh = g.innerHeight ?? Infinity;
    if (r.width === 0 || r.bottom <= 0 || r.top >= vh || r.right <= 0 || r.left >= vw) continue;
    const verb = actionVerb(el);
    // Scope the id to the owning product, not to rect.top: mine embedded the y
    // position so every id changed on scroll. Honour both attribute spellings.
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

// The visible label a person would use to refer to a control. aria-label wins
// because that is what the site itself says it means.
export function controlName(el) {
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return aria.trim().slice(0, 60);
  const labelled = el.getAttribute("aria-labelledby");
  if (labelled) {
    const t = labelled.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ").trim();
    if (t) return t.slice(0, 60);
  }
  const text = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  if (text) return text.slice(0, 60);
  return (el.getAttribute("title") || el.getAttribute("alt") || "").trim().slice(0, 60);
}

/** Every visible, named control on the page — what Cue can be asked to click. */
export function controls() {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CONTROL_SEL)) {
    if (el.closest("#aura-root") || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;
    if (r.bottom <= 0 || r.top >= (globalThis.innerHeight ?? Infinity)) continue;
    const name = controlName(el);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, el, rect: r, href: el.getAttribute("href") || null });
    if (out.length >= 40) break;
  }
  return out;
}

// Everything a spoken "click" may reach: the controls above plus checkboxes,
// radios, options and labels, anywhere in the document. controls() stays the
// on-screen list because badges and the agent's context are built from it.
const CLICKABLE_SEL = CONTROL_SEL + "," + [
  "[role=checkbox]", "[role=radio]", "[role=option]", "[role=switch]", "[role=menuitemradio]",
  "[role=menuitemcheckbox]", "input[type=checkbox]", "input[type=radio]", "label[for]",
].join(",");

export function clickables(limit = 400) {
  const out = [];
  const seen = new Set();
  for (const el of document.querySelectorAll(CLICKABLE_SEL)) {
    if (el.closest("#aura-root") || el.disabled) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.height < 4) continue;
    const name = controlName(el) || (el.labels?.[0]?.innerText ?? "").trim().slice(0, 60);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    out.push({ name, el, rect: r, href: el.getAttribute("href") || null });
    if (out.length >= limit) break;
  }
  return out;
}

function literal(list, q) {
  const n = (c) => norm(c.name);
  return list.find((c) => n(c) === q)
      ?? list.find((c) => n(c).startsWith(q))
      ?? list.find((c) => n(c).includes(q))
      ?? list.find((c) => q.includes(n(c)) && n(c).length > 2)
      ?? null;
}

/**
 * Best control for a spoken phrase. What is on screen wins, then the rest of
 * the page, and only then a sound-alike match ("the card" for "Cart").
 */
export function findControl(phrase) {
  const q = norm(phrase);
  if (!q) return null;
  const onScreen = controls();
  const hit = literal(onScreen, q);
  if (hit) return hit;
  const all = clickables();
  const anywhere = literal(all, q);
  if (anywhere) return anywhere;
  const fuzzy = bestMatch(q, onScreen.map((c) => c.name));
  if (fuzzy) return onScreen[fuzzy.index];
  const far = bestMatch(q, all.map((c) => c.name));
  return far ? all[far.index] : null;
}

/** A native <select> option by its visible text: "select price low to high". */
export function findOption(phrase) {
  const q = norm(phrase);
  if (!q) return null;
  const options = [];
  for (const select of document.querySelectorAll("select")) {
    if (select.closest("#aura-root") || select.disabled) continue;
    for (const option of select.options) {
      if (!option.disabled && option.text.trim()) options.push({ select, option, name: option.text.trim() });
    }
  }
  const exact = options.find((o) => norm(o.name) === q) ?? options.find((o) => norm(o.name).includes(q));
  if (exact) return exact;
  const fuzzy = bestMatch(q, options.map((o) => o.name));
  return fuzzy ? options[fuzzy.index] : null;
}

// ── Typing and reading: what lets Cue act on a page nobody tagged ───────────

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 4 && r.height > 4 && getComputedStyle(el).visibility !== "hidden";
}

// Never typed into by voice: credentials and payment details. Cue may shop; it
// does not get to enter a password or a card number on anyone's behalf.
function sensitive(el) {
  const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
  return el.type === "password" || /^cc-|current-password|new-password|one-time/.test(ac) ||
    /card|cvv|cvc|password|passcode|ssn/.test(norm(el.name + " " + el.id));
}

const FIELD_SEL = "input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=submit])" +
  ":not([type=button]):not([type=file]),textarea,[contenteditable=true],[role=searchbox],[role=textbox]";

export function fieldName(el) {
  const labelled = el.labels?.[0]?.innerText;
  return (el.getAttribute("aria-label") || labelled || el.placeholder ||
    el.getAttribute("title") || el.name || el.id || "").trim().slice(0, 60);
}

/** Visible text fields a person could type into, minus anything sensitive. */
export function fields() {
  return [...document.querySelectorAll(FIELD_SEL)]
    .filter((el) => !el.closest("#aura-root") && !el.disabled && !el.readOnly && visible(el) && !sensitive(el))
    .map((el) => ({ el, name: fieldName(el) }));
}

export function searchBox() {
  const all = fields();
  return all.find((f) => f.el.type === "search" || f.el.getAttribute("role") === "searchbox")?.el
    ?? all.find((f) => /search/.test(norm(f.name + " " + f.el.id + " " + f.el.name)))?.el ?? null;
}

export function findField(phrase) {
  const q = norm(phrase);
  const all = fields();
  if (!q) return all[0]?.el ?? null;
  const literal = all.find((f) => norm(f.name) === q) ?? all.find((f) => norm(f.name).includes(q)) ??
    all.find((f) => q.includes(norm(f.name)) && norm(f.name).length > 2);
  if (literal) return literal.el;
  // A field is also known by its placeholder and type: the newsletter box is
  // labelled with a sentence, but people call it "the email field".
  const aliases = all.map((f) => norm([f.el.placeholder, f.el.name, f.el.id, f.el.type].filter(Boolean).join(" ")));
  const alias = aliases.findIndex((a) => a && (a.includes(q) || q.split(" ").every((w) => a.includes(w))));
  if (alias >= 0) return all[alias].el;
  const fuzzy = bestMatch(q, all.map((f) => f.name));
  return fuzzy ? all[fuzzy.index].el : null;
}

/** Type like a person: framework-controlled inputs ignore a bare `.value =`. */
export function setText(el, text) {
  el.focus();
  if (el.isContentEditable) { el.textContent = text; }
  else {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement;
    Object.getOwnPropertyDescriptor(proto.prototype, "value").set.call(el, text);
  }
  el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

export function submitField(el) {
  const form = el.form || el.closest("form");
  if (form?.requestSubmit) { form.requestSubmit(); return true; }
  for (const type of ["keydown", "keypress", "keyup"]) {
    el.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true }));
  }
  return true;
}

/** Visible page text, trimmed — the evidence for questions about untagged content. */
export function pageText(limit = 2500) {
  const root = document.querySelector("main,[role=main],#dp,#search") ?? document.body;
  const out = [];
  let used = 0;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n && used < limit; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest("#aura-root,script,style,noscript,nav,footer") || /^(SCRIPT|STYLE)$/.test(el.tagName)) continue;
    const t = n.nodeValue.replace(/\s+/g, " ").trim();
    if (t.length < 3) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.bottom <= 0 || r.top >= (globalThis.innerHeight ?? Infinity)) continue;
    out.push(t); used += t.length + 1;
  }
  return out.join(" ").slice(0, limit);
}

/** Scroll the first match into view and outline it. */
export function findText(phrase) {
  const q = norm(phrase);
  if (!q) return false;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (!el || el.closest("#aura-root,script,style,noscript") || !norm(n.nodeValue).includes(q)) continue;
    if (!visible(el)) continue;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const prev = el.style.outline;
    el.style.outline = "3px solid #f5a623";
    setTimeout(() => { el.style.outline = prev; }, 3000);
    return true;
  }
  return false;
}

// A spoken name is a weak signal on a real store. These controls commit money;
// only the shopper's own hands (or the passkey flow on the demo store) may.
export const COMMITS_MONEY = /\b(buy now|place (?:your )?order|complete (?:purchase|order)|pay now|confirm (?:order|purchase|payment)|subscribe now|proceed to checkout)\b/i;

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
