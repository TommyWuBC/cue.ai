import { bus } from "./bus.js";
import * as gaze from "./gaze.js";
import * as voice from "./voice.js";
import { scan, nth, invalidate } from "./resolver.js";

const qs = new URLSearchParams(location.search);
const CONFIG = {
  gazeMode: qs.get("gaze") || "webgazer",      // webgazer | mouse | sim
  autoCal: qs.get("cal") !== "0",
  sigma: +(qs.get("sigma") || 70),             // sim mode: synthetic noise, px
  // Filter overrides, for sweeping the tuning against sim mode. Omit in normal use.
  tune: qs.has("mc") ? {
    minCutoff: +qs.get("mc"), beta: +(qs.get("beta") ?? 0.002), dCutoff: +(qs.get("dc") ?? 0.3),
  } : null,
};

// ── Overlay chrome ──────────────────────────────────────────────────────────
const ui = {};
function mountUI() {
  const root = document.createElement("div");
  root.id = "cue-root";
  root.innerHTML = `
    <div class="cue-reticle"></div>
    <div class="cue-outline"><span class="cue-outline-label"></span></div>
    <div class="cue-hud">
      <div class="cue-hud-row"><span class="cue-dot"></span><b>Cue</b><span class="cue-chip cue-mode"></span></div>
      <div class="cue-hud-heard"></div>
      <div class="cue-hud-said"></div>
      <div class="cue-hud-foot">hold <kbd>space</kbd> to talk · say &ldquo;Cue, &hellip;&rdquo;</div>
    </div>`;
  document.body.appendChild(root);
  ui.reticle = root.querySelector(".cue-reticle");
  ui.outline = root.querySelector(".cue-outline");
  ui.label   = root.querySelector(".cue-outline-label");
  ui.heard   = root.querySelector(".cue-hud-heard");
  ui.said    = root.querySelector(".cue-hud-said");
  ui.mode    = root.querySelector(".cue-mode");
  ui.dot     = root.querySelector(".cue-dot");
}

// ── Render loop ─────────────────────────────────────────────────────────────
// GAZE arrives at ~25Hz and in bursts. Writing transform straight from the
// event gave visible stair-stepping even once the signal itself was clean, so
// the event only ever moves a TARGET and a rAF loop eases the drawn position
// toward it. This is also what keeps the outline glued to its element while
// the page scrolls — the rect captured at FOCUS time goes stale instantly.
const render = {
  x: innerWidth / 2, y: innerHeight / 2,
  tx: innerWidth / 2, ty: innerHeight / 2,
  conf: 0, drawnConf: 0, el: null, kind: null,
};

bus.on("GAZE", ({ x, y, confidence }) => {
  render.tx = x; render.ty = y; render.conf = confidence;
});

const FOLLOW = 0.32;     // per-frame easing toward the target

function frame() {
  render.x += (render.tx - render.x) * FOLLOW;
  render.y += (render.ty - render.y) * FOLLOW;
  render.drawnConf += (render.conf - render.drawnConf) * 0.12;

  if (ui.reticle) {
    ui.reticle.style.transform = `translate3d(${render.x.toFixed(1)}px, ${render.y.toFixed(1)}px, 0)`;
    ui.reticle.style.opacity = (0.25 + render.drawnConf * 0.55).toFixed(3);
    // A wide, soft reticle when the signal is poor reads as honest rather than
    // broken: it shows the user how sure Cue is instead of faking precision.
    const s = 1 + (1 - render.drawnConf) * 0.9;
    ui.reticle.style.setProperty("--cue-reticle-scale", s.toFixed(2));
  }

  if (render.el && ui.outline) {
    const r = render.el.getBoundingClientRect();
    ui.outline.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
    ui.outline.style.width  = r.width + "px";
    ui.outline.style.height = r.height + "px";
  }
  requestAnimationFrame(frame);
}

bus.on("FOCUS", ({ target }) => {
  if (!target) { render.el = null; ui.outline.classList.remove("on"); return; }
  render.el = target.el;
  ui.outline.classList.add("on");
  ui.outline.dataset.kind = target.kind;
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
  if (s.accuracy) console.log("[cue] gaze accuracy", s.accuracy);
});

bus.on("SAY", ({ text }) => { ui.said.textContent = text; voice.speak(text); });

// Scrolling moves every rect. Drop the resolver's cache immediately rather
// than waiting for its own key check to notice.
addEventListener("scroll", invalidate, { passive: true });

// ── The loop: utterance -> server -> speech + actions ───────────────────────
function context() {
  const f = gaze.getFocus();
  return {
    focused: f?.kind === "product" ? f.product : null,
    focusedAction: f?.kind === "action" ? { verb: f.verb, label: f.label } : null,
    visible: scan().filter((t) => t.kind === "product").map((t) => t.product),
    pending: pendingConfirm?.kind ?? null,
    url: location.href,
  };
}

let inflight = false;
bus.on("UTTERANCE", async ({ text, final }) => {
  ui.heard.textContent = (final ? "" : "… ") + text;
  if (!final || inflight) return;
  inflight = true;
  try {
    const res = await fetch("/utterance", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, context: context() }),
    });
    const out = await res.json();
    for (const a of out.do ?? []) perform(a.verb, a.args ?? {});
    if (out.say) bus.emit("SAY", { text: out.say });
  } catch (e) {
    bus.emit("SAY", { text: "Sorry, I lost my connection." });
    console.error(e);
  } finally { inflight = false; }
});

// ── Confirmation ────────────────────────────────────────────────────────────
// Nothing that spends money happens on one utterance. Checkout stages an
// intent, Cue reads it back, and only "yes" completes it. This is the whole
// trust story, so it lives in the client where the readback is visible.
let pendingConfirm = null;

function stageCheckout() {
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
  if (p.kind !== "checkout") return false;
  if (ok) { window.cueStore?.approve(); bus.emit("SAY", { text: "Order approved." }); }
  else    { bus.emit("SAY", { text: "Cancelled. Nothing was charged." }); }
  return true;
}

// ── Actions the page can perform ────────────────────────────────────────────

// The card the user is looking at. Every product-specific action is scoped to it.
function scope() {
  const f = gaze.getFocus();
  if (!f) return null;
  return f.kind === "product" ? f.el : f.el.closest("[data-cue-product],[data-aura-product]");
}

function perform(verb, args) {
  switch (verb) {
    case "scroll":
      scrollBy({ top: (args.dir === "up" ? -1 : 1) * innerHeight * 0.75, behavior: "smooth" });
      break;
    case "focus_nth": {
      const t = nth(args.n);
      if (t) gaze.setFocus(t);
      else bus.emit("SAY", { text: `I only see ${scan().filter((x) => x.kind === "product").length} items.` });
      break;
    }
    case "click_focused": gaze.getFocus()?.el.click(); break;
    case "select_variant": {
      const el = scope()?.querySelector(
        `[data-cue-action="select_variant"][data-cue-value="${CSS.escape(String(args.value).toUpperCase())}"],` +
        `[data-aura-action="select_variant"][data-aura-value="${CSS.escape(String(args.value).toUpperCase())}"]`);
      if (!el) { bus.emit("SAY", { text: `I don't see size ${args.value} on this one.` }); break; }
      el.click();
      break;
    }
    case "add_to_cart": {
      // MUST be scoped to what they were looking at. A global querySelector here
      // adds the first product on the page — i.e. charges for the wrong item.
      const el = scope()?.querySelector('[data-cue-action="add_to_cart"],[data-aura-action="add_to_cart"]');
      if (!el) { bus.emit("SAY", { text: "Look at the item you want first." }); break; }
      el.click();
      break;
    }
    case "checkout": stageCheckout(); break;
    case "confirm":
      if (!resolveConfirm(true)) bus.emit("SAY", { text: "There's nothing waiting for approval." });
      break;
    case "cancel":
      if (!resolveConfirm(false)) bus.emit("SAY", { text: "Okay." });
      break;
    case "navigate": location.href = args.url; break;
    default: console.warn("[cue] unknown verb", verb, args);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  mountUI();
  requestAnimationFrame(frame);

  // Ask for the mic BEFORE the camera prompt and before calibration. Chrome
  // will not reliably prompt for it later once a video stream is live, which
  // is why speech looked "broken" rather than "not permitted".
  if (CONFIG.gazeMode === "webgazer") await voice.requestMic();

  // start() reports the mode it ACTUALLY got, which may not be the one asked
  // for — no camera, or a browser blocking WebGL, degrades it to the mouse.
  const actual = await gaze.start({ mode: CONFIG.gazeMode, sigma: CONFIG.sigma, tune: CONFIG.tune });
  if (actual === "webgazer" && CONFIG.autoCal) {
    await gaze.calibrate();
    gaze.hideCamera();
  }
  await voice.startListening();

  if (CONFIG.gazeMode === "webgazer" && actual !== "webgazer") {
    bus.emit("SAY", { text: "I couldn't use the camera, so I'm following the mouse instead. Everything else works." });
  } else {
    bus.emit("SAY", { text: "Cue is ready. Look at something and ask me about it." });
  }
}

// A silent failure in boot is the worst outcome: a blank page with no reason.
bus.on("STATE", (s) => {
  if (!s.gazeError) return;
  ui.said.textContent = `⚠ ${s.gazeError} — using the mouse`;
});

// say() is how you drive Cue with no mic: from the console, from a test, or
// from the on-stage fallback if the demo floor is too loud to be heard.
const say = (text) => bus.emit("UTTERANCE", { text, final: true });

window.cue = { bus, gaze, voice, context, perform, boot, say, CONFIG,
               get pending() { return pendingConfirm; } };
window.aura = window.cue;          // nothing that already says aura.* breaks
addEventListener("DOMContentLoaded", boot);
