import { bus } from "./bus.js";
import * as gaze from "./gaze.js";
import * as voice from "./voice.js";
import { scan, nth, invalidate, controls, findControl } from "./resolver.js";
import * as badges from "./badges.js";
import { CONFIG, url } from "./config.js";
import { productMemory } from "./product-memory.js";
import { playSplash } from "./splash.js";

let memoryStorage;
try { memoryStorage = CONFIG.injected ? window.CUE_MEMORY_STORAGE : sessionStorage; } catch {}
const comparisons = productMemory({ storage: memoryStorage });
const isGazeMode = mode => mode === "webgazer" || mode === "eyetrax";


// ── Overlay chrome ──────────────────────────────────────────────────────────
const ui = {};
function mountUI() {
  const root = document.createElement("div");
  root.id = "aura-root";
  root.innerHTML = `
    <div class="aura-reticle"></div>
    <div class="aura-outline"><span class="aura-outline-label"></span></div>
    <div class="aura-hud">
      <div class="aura-hud-row"><span class="aura-dot"></span><b>Cue</b><span class="aura-chip aura-mode"></span></div>
      <div class="aura-hud-heard"></div>
      <div class="aura-hud-said"></div>
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
  badges.mount(root);
}

// Tracking has gone bad enough that focus was dropped. Offer the way out.
bus.on("GAZE_QUALITY", ({ low }) => { if (ui.quality) ui.quality.hidden = !low; });
addEventListener("scroll", () => gaze.refreshFocus(), { passive: true });
addEventListener("resize", () => gaze.refreshFocus());

// ── Render loop ─────────────────────────────────────────────────────────────
// GAZE arrives at ~25Hz and in bursts. Writing transform straight from the
// event gave visible stair-stepping even once the signal itself was clean, so
// the event only ever moves a TARGET and a rAF loop eases the drawn position
// toward it. That loop also keeps the outline and badges glued to their
// elements while the page scrolls — a rect captured at FOCUS time goes stale
// instantly.
const render = {
  x: innerWidth / 2, y: innerHeight / 2,
  tx: innerWidth / 2, ty: innerHeight / 2,
  conf: 0, drawnConf: 0, el: null, kind: null,
};

bus.on("GAZE", ({ x, y, confidence }) => {
  render.tx = x; render.ty = y; render.conf = confidence;
});

const FOLLOW = 0.32;     // per-frame easing toward the target
const BADGE_MS = 180;    // how often the numbered set is recomputed
const now = () => performance.now();
let lastBadge = 0;
let exited = false;

function frame() {
  if (exited) return;
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

  // Badges follow the gaze neighbourhood. Recomputing which products are
  // numbered is throttled; repositioning the ones already up is not, or they
  // detach from their cards the moment the page scrolls.
  edgeScrollTick();

  if (gaze.getState().calibrating) {
    badges.clear();               // the dots on screen are the calibration's
  } else if (now() - lastBadge > BADGE_MS) {
    lastBadge = now();
    badges.update(render.x, render.y, gaze.getFocus()?.id ?? null);
  } else {
    badges.reposition();
  }
  requestAnimationFrame(frame);
}

// When gaze is too coarse to be trusted, a bold outline on one card is a lie:
// measured at 242px error it highlights the WRONG card two times in three.
// Below the precision bar we soften it to a guess and let the numbered badges
// carry the interaction — the intended card is among them 6 times out of 6.
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
  const m = { mouse: "mouse", sim: `sim ±${CONFIG.sigma}px`, webgazer: "WebGazer",
    eyetrax: "EyeTrax" }[chip.mode] ?? chip.mode;
  ui.mode.textContent = [m, chip.stt].filter(Boolean).join(" · ");
}

bus.on("STATE", (s) => {
  if (s.calibrating !== undefined) badges.setEnabled(!s.calibrating);
  if (s.mode) { chip.mode = s.mode; paintChip(); }
  if (s.sttProvider) { chip.stt = s.sttProvider; paintChip(); }
  if (s.ptt !== undefined) ui.dot.classList.toggle("hot", s.ptt);
  if (s.listening) ui.dot.classList.add("live");
  if (s.listening === false) ui.dot.classList.remove("live");
  if (s.accuracy) {
    console.log("[cue] gaze accuracy", s.accuracy);
    // How coarse the signal turned out to be decides how many items get
    // numbered. At 341px, numbering only the nearest few can miss the one
    // they want, which defeats the point.
    badges.setPrecision(s.accuracy.after_px);
  }
  if (s.precise !== undefined) {
    precise = s.precise;
    ui.outline.dataset.guess = String(!precise);
    ui.foot.innerHTML = precise
      ? 'hold <kbd>space</kbd> to talk · say &ldquo;Cue, &hellip;&rdquo;'
      : 'say the <b>number</b> on an item · hold <kbd>space</kbd> to talk';
  }
});

bus.on("SAY", ({ text }) => { ui.said.textContent = text; voice.speak(text); });

// Scrolling moves every rect. Drop the resolver's cache immediately rather
// than waiting for its own key check to notice.
addEventListener("scroll", invalidate, { passive: true });

// ── Look at the edge to scroll ──────────────────────────────────────────────
// Hands-free browsing needs a way down the page that is not a spoken command
// every screenful. Hold your gaze in the top or bottom band and the page
// moves, accelerating the closer to the edge you look, and stopping the
// moment you look away.
//
// The band has to be generous — at 220-350px of error a narrow strip would be
// unreachable — and it must not fire while calibrating, while a dialog is up,
// or while the pointer has been abandoned in mouse mode.
const EDGE_BAND = 130;     // px from the top/bottom that counts as "the edge"
const EDGE_ARM_MS = 500;   // hold this long before it starts, so a glance is safe
const EDGE_MAX_PX = 13;    // per frame at the very edge

let edgeSince = 0, edgeDir = 0;

function edgeScrollTick() {
  const p = render;
  const gs = gaze.getState();
  if (gs.calibrating || document.querySelector("dialog[open]") || !gs.point) {
    edgeSince = 0; edgeDir = 0; document.body.classList.remove("cue-edge-top", "cue-edge-bottom");
    return;
  }

  const top = p.y < EDGE_BAND;
  const bottom = p.y > innerHeight - EDGE_BAND;
  const dir = top ? -1 : bottom ? 1 : 0;

  if (!dir) {
    edgeSince = 0; edgeDir = 0;
    document.body.classList.remove("cue-edge-top", "cue-edge-bottom");
    return;
  }
  if (dir !== edgeDir) { edgeDir = dir; edgeSince = now(); return; }
  if (now() - edgeSince < EDGE_ARM_MS) return;

  // Deeper into the band = faster, so you can control pace by where you look.
  const depth = dir < 0
    ? (EDGE_BAND - p.y) / EDGE_BAND
    : (p.y - (innerHeight - EDGE_BAND)) / EDGE_BAND;
  const step = dir * EDGE_MAX_PX * Math.min(1, Math.max(0.15, depth));

  const box = scrollableUnderGaze(false);
  (box ?? window).scrollBy({ top: step, behavior: "instant" });
  document.body.classList.toggle("cue-edge-top", dir < 0);
  document.body.classList.toggle("cue-edge-bottom", dir > 0);
}

// ── The loop: utterance -> server -> speech + actions ───────────────────────
function context() {
  const f = gaze.getFocus();
  const focused = f?.kind === "product" ? f.product : null;
  return {
    focused,
    previous: comparisons.remember(focused),
    focusedAction: f?.kind === "action" ? { verb: f.verb, label: f.label } : null,
    visible: scan().filter((t) => t.kind === "product").map((t) => t.product),
    // What a person could click on this page right now. Without this the agent
    // can describe a page but never move through one.
    controls: controls().slice(0, 25).map((c) => c.name),
    pending: pendingConfirm?.kind ?? null,
    url: location.href,
  };
}

let inflight = false;
bus.on("UTTERANCE", async ({ text, final }) => {
  if (final && /^(?:exit|quit|stop|go away|shut down|turn (?:yourself )?off|disable)(?: cue)?[.!]?$/i.test(text.trim())) {
    await exitCue();
    return;
  }
  // Calibration owns the microphone for "Cue, next". Nothing said there is a
  // shopping command, and echoing it into the HUD just looks like a bug.
  if (gaze.getState().calibrating) return;
  ui.heard.textContent = (final ? "" : "… ") + text;
  if (!final || inflight) return;

  // Naming an item and then talking about it must not let gaze quietly take
  // the focus back. The lock used to expire on a 3.5s timer, so "two" ... two
  // questions ... "add it" added whatever the eyes had drifted onto — and at
  // 242px of error that is effectively random. While the conversation
  // continues, what you named stays what you meant.
  gaze.holdFocus();
  inflight = true;
  try {
    const res = await fetch(url("/utterance"), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, context: context() }),
    });
    const out = await res.json();
    window.cue.lastActionUtterance = text;
    let completed = true;
    const fromModel = out.source === "grok";
    for (const a of out.do ?? []) {
      // Second lock. The server's allowlist already refuses these from the
      // model; this is the one that survives a jailbreak, because it is the
      // page and not the prompt.
      if (fromModel && COMMIT_VERBS.has(a.verb)) {
        console.warn("[cue] refused a commit verb proposed by the model:", a.verb);
        bus.emit("SAY", { text: "I need to hear you say that yourself." });
        completed = false;
        break;
      }
      if (perform(a.verb, a.args ?? {}) === false) { completed = false; break; }
    }
    // The agent proposed something and asked first. Hold it: the shopper's
    // "yes" is what performs it. This is how Cue is allowed to buy — it never
    // commits on its own, it states exactly what it will do and waits.
    const staged = Array.isArray(out.ask) ? out.ask : (out.ask?.verb ? [out.ask] : null);
    if (staged?.length) {
      pendingConfirm = { kind: "action", actions: staged, said: out.say ?? "" };
    }
    window.cue.lastActionUtterance = null;
    if (completed && out.say) bus.emit("SAY", { text: out.say });
  } catch (e) {
    bus.emit("SAY", { text: "Sorry, I lost my connection." });
    console.error(e);
  } finally { window.cue.lastActionUtterance = null; inflight = false; }
});

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
  if (!store) { bus.emit("SAY", { text: "There's no cart on this page." }); return; }
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
      if (perform(a.verb, a.args ?? {}, { confirmed: true }) === false) break;
    }
    return true;
  }
  if (p.kind !== "checkout") return false;
  if (ok) { window.cueStore?.approve(); bus.emit("SAY", { text: "Order approved." }); }
  else    { bus.emit("SAY", { text: "Cancelled. Nothing was charged." }); }
  return true;
}

// ── Actions the page can perform ────────────────────────────────────────────

// Badges win when they are on screen, because that is what the user can see.
// Otherwise fall back to counting every product in reading order.
function pickNumbered(n) {
  return badges.byNumber(n) ?? nth(n);
}

// The card the user is looking at. Every product-specific action is scoped to it.
function scope() {
  const f = gaze.getFocus();
  if (!f) return null;
  return f.kind === "product" ? f.el : f.el.closest("[data-cue-product],[data-aura-product]");
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

// The nearest ancestor of the focused element that can actually scroll in the
// requested axis. Returns null when that is just the page.
function scrollableUnderGaze(horizontal) {
  let el = gaze.getFocus()?.el ?? null;
  while (el && el !== document.body && el !== document.documentElement) {
    const st = getComputedStyle(el);
    const flow = horizontal ? st.overflowX : st.overflowY;
    const room = horizontal
      ? el.scrollWidth - el.clientWidth
      : el.scrollHeight - el.clientHeight;
    if (/(auto|scroll)/.test(flow) && room > 8) return el;
    el = el.parentElement;
  }
  return null;
}

// What is about to go in the bag, in the words the shopper will hear. For some
// users this is the only description of the purchase they get, so it names the
// item, the chosen options and the price.
function describeAdd(card) {
  let p = {};
  try { p = JSON.parse(card?.dataset?.cueProduct ?? card?.dataset?.auraProduct ?? "{}"); } catch {}
  const title = p.title ?? "this one";
  const size = card?.querySelector('.variants [aria-pressed="true"]')?.dataset?.auraValue
            ?? card?.querySelector('[data-cue-action="select_variant"][aria-pressed="true"]')?.dataset?.cueValue;
  const color = card?.querySelector('.colors [aria-pressed="true"]')?.dataset?.auraValue;
  const needsSize = !!card?.querySelector('.variants [data-aura-action="select_variant"]') && !size;
  const bits = [title, color, size && `size ${size}`].filter(Boolean);
  const price = typeof p.price === "number" ? `, $${p.price.toFixed(2)}` : "";
  return { title, size, color, missing: needsSize, line: `${bits.join(", ")}${price}.` };
}

function perform(verb, args, opts = {}) {
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
    case "scroll":
      if (!["up", "down", "left", "right", "top", "bottom"].includes(args.dir)) return false;
      if (args.dir === "top" || args.dir === "bottom") {
        scrollTo({ top: args.dir === "top" ? 0 : document.documentElement.scrollHeight, behavior: "smooth" });
      } else {
        const horizontal = args.dir === "left" || args.dir === "right";
        const step = args.dir === "up" || args.dir === "left" ? -1 : 1;
        // Scroll whatever actually scrolls under the gaze — a drawer, a filter
        // rail, a dialog — falling back to the window. Always scrolling the
        // window looks like nothing happened when the content is in a panel.
        const box = scrollableUnderGaze(horizontal);
        if (box) {
          box.scrollBy({ [horizontal ? "left" : "top"]:
            step * (horizontal ? box.clientWidth : box.clientHeight) * 0.75, behavior: "smooth" });
          break;
        }
        scrollBy({ [horizontal ? "left" : "top"]: step * (horizontal ? innerWidth : innerHeight) * 0.75,
          behavior: "smooth" });
      }
      break;
    case "history":
      if (args.dir === "back") history.back();
      else if (args.dir === "forward") history.forward();
      else return false;
      break;
    // "two" and "the second one" MUST mean the same item. Badges are numbered
    // locally (the few near your gaze) while nth() counts every product on the
    // page, so resolving them differently would make the two phrasings disagree
    // — and the user has no way to know which one Cue is using.
    case "focus_nth":
    case "focus_number": {
      const t = pickNumbered(args.n);
      if (!t) {
        const total = scan().filter((x) => x.kind === "product").length;
        bus.emit("SAY", { text: `I only see ${total} item${total === 1 ? "" : "s"}.` });
        return false;
      }
      // Naming an item tells us exactly where the eyes were. Hand that back to
      // the tracker as a true training pair — the one moment we have ground
      // truth, and it is free.
      if (gaze.learnFromSelection(t)) persistCalibration();
      gaze.setFocus(t);
      if (t.kind === "product") comparisons.remember(t.product);
      break;
    }
    case "recalibrate":
      recalibrate();
      break;
    case "click_focused": {
      const target = gaze.getFocus();
      if (target?.kind !== "action") {
        bus.emit("SAY", { text: "Look at a button before asking me to click it." });
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
      break;
    }
    case "select_color": {
      const value = String(args.value);
      const el = scope()?.querySelector(
        `[data-aura-action="select_color"][data-aura-value="${CSS.escape(value)}"]`);
      if (!el) { bus.emit("SAY", { text: `I don't see ${value} on this one.` }); return false; }
      el.click();
      break;
    }
    case "add_to_cart": {
      // MUST be scoped to what they were looking at. A global querySelector here
      // adds the first product on the page — i.e. charges for the wrong item.
      const card = scope();
      const el = card?.querySelector('[data-cue-action="add_to_cart"],[data-aura-action="add_to_cart"]');
      if (!el) { bus.emit("SAY", { text: "Look at the item you want first." }); return false; }

      // The bag is where a wrong item first gets in, and at 300px of gaze
      // error that is a live possibility on every add. So an add is read back
      // and waits, exactly like a charge. Done here rather than per-caller so
      // the spoken command and the agent are held to the same bar.
      if (!opts.confirmed) {
        const d = describeAdd(card);
        if (d.missing) {
          bus.emit("SAY", { text: `Which size for the ${d.title}?` });
          return false;
        }
        pendingConfirm = { kind: "add", el, said: d.line };
        bus.emit("SAY", { text: `${d.line} Add it?` });
        break;
      }

      const before = window.CART?.().length;
      el.click();
      if (before !== undefined && window.CART().length === before) return false;
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
        bus.emit("SAY", { text: "Okay." });
      }
      break;
    case "setup_passkey":
      if (window.cueCheckout?.register) window.cueCheckout.register();
      else bus.emit("SAY", { text: "There's no passkey set-up on this page." });
      break;
    case "recalibrate":
      const cameraUnavailable = !isGazeMode(gaze.getState().mode) || !gaze.getState().running;
      if (!isGazeMode(gaze.getState().mode)) {
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
    // "click the bag", "open women's coats", "go to checkout" — resolve a
    // spoken phrase against the page's own accessibility names and click it.
    // Works on a page nobody tagged for Cue, which is the whole point.
    case "click_named":
    case "open_named": {
      const c = findControl(args.name ?? args.text ?? "");
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
      // Say what is about to happen before it happens — on a page the user
      // cannot see well, a silent navigation is disorienting.
      bus.emit("SAY", { text: `Opening ${c.name}.` });
      c.el.click();
      break;
    }
    case "back": history.back(); break;
    case "forward": history.forward(); break;
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
  badges.setEnabled(false);
  try {
    await clearCalibration();
    if (!isGazeMode(gaze.getState().mode)) {
      let gazeToken = CONFIG.gazeToken;
      if (CONFIG.injected && CONFIG.gazeMode === "eyetrax") {
        try { gazeToken = (await chrome.runtime.sendMessage({ type: "cue:gaze:session" }))?.token; }
        catch {}
      }
      const actual = await gaze.start({ mode: CONFIG.gazeMode, sigma: CONFIG.sigma,
        tune: CONFIG.tune, keepData: CONFIG.keepData, gazeToken });
      if (!isGazeMode(actual)) {
        const reason = gaze.getState().gazeError || "the camera is unavailable";
        bus.emit("SAY", { text: `Eye tracking still can't start: ${reason}. Check camera permission for the app running Cue, then try again.` });
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
  finally { badges.setEnabled(true); recalibrating = false; }
}

// ── Boot ────────────────────────────────────────────────────────────────────
export async function exitCue() {
  if (exited) return;
  exited = true;
  pendingConfirm = null;
  voice.stopListening();
  gaze.stop();
  badges.clear();
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

  // Ask for the mic BEFORE the camera prompt and before calibration. Chrome
  // will not reliably prompt for it later once a video stream is live, which
  // is why speech looked "broken" rather than "not permitted".
  if (isGazeMode(CONFIG.gazeMode)) await voice.requestMic();
  if (exited) return;

  // start() reports the mode it ACTUALLY got, which may not be the one asked
  // for — no camera, or a browser blocking WebGL, degrades it to the mouse.
  const actual = await gaze.start({ mode: CONFIG.gazeMode, sigma: CONFIG.sigma,
                                    tune: CONFIG.tune, keepData: CONFIG.keepData,
                                    resume: CONFIG.calibration, gazeToken: CONFIG.gazeToken });
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
  if (isGazeMode(actual) && gaze.getState().calibrated) {
    announced = true;
  } else if (isGazeMode(actual) && CONFIG.autoCal) {
    await gaze.calibrate();
    gaze.hideCamera();
    await persistCalibration();
    // calibrate() already said how it went and what to do next. Adding "Cue is
    // ready" on top of it is two spoken lines for one event, and they landed
    // close enough together to talk over each other.
    announced = true;
  }

  if (isGazeMode(CONFIG.gazeMode) && !isGazeMode(actual) && !CONFIG.resuming) {
    bus.emit("SAY", { text: "I couldn't use the camera, so I'm following the mouse instead. Everything else works." });
  } else if (!announced && !CONFIG.resuming) {
    bus.emit("SAY", { text: "Cue is ready. Look at something and ask me about it." });
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
  if (recalibrating || gs.calibrating || !gs.calibrated || !isGazeMode(gs.mode)) {
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
const say = (text) => bus.emit("UTTERANCE", { text, final: true });

window.cue = { bus, gaze, voice, badges, context, perform, boot, say, recalibrate, exit: exitCue, CONFIG,
               measure: (...a) => gaze.measure(...a),
               experiment: (...a) => gaze.experiment(...a),
               head: () => gaze.getHead(),
               get pending() { return pendingConfirm; } };
window.aura = window.cue;          // nothing that already says aura.* breaks

// DOMContentLoaded may already have fired — it will have, for anything
// injected into a live page — so check rather than assume.
if (document.readyState === "loading") addEventListener("DOMContentLoaded", boot, { once: true });
else boot();
