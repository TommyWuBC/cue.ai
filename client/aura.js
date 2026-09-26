import { bus } from "./bus.js";
import * as gaze from "./gaze.js";
import * as voice from "./voice.js";
import { scan, nth, invalidate } from "./resolver.js";
import * as badges from "./badges.js";
import { CONFIG, url } from "./config.js";


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
      <div class="cue-hud-drift">tracking has drifted · say &ldquo;recalibrate&rdquo;</div>
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
  ui.drift   = root.querySelector(".cue-hud-drift");
  ui.foot    = root.querySelector(".cue-hud-foot");
  badges.mount(root);
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
const BADGE_MS = 180;    // how often the numbered set is recomputed
const now = () => performance.now();
let lastBadge = 0;

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

  // Badges follow the gaze neighbourhood. Recomputing which products are
  // numbered is throttled; repositioning the ones already up is not, or they
  // detach from their cards the moment the page scrolls.
  if (now() - lastBadge > BADGE_MS) {
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
  const m = { mouse: "mouse", sim: `sim ±${CONFIG.sigma}px`, webgazer: "gaze" }[chip.mode] ?? chip.mode;
  ui.mode.textContent = [m, chip.stt].filter(Boolean).join(" · ");
}

bus.on("STATE", (s) => {
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

function perform(verb, args) {
  switch (verb) {
    case "scroll":
      scrollBy({ top: (args.dir === "up" ? -1 : 1) * innerHeight * 0.75, behavior: "smooth" });
      break;
    // "two" and "the second one" MUST mean the same item. Badges are numbered
    // locally (the few near your gaze) while nth() counts every product on the
    // page, so resolving them differently would make the two phrasings disagree
    // — and the user has no way to know which one Cue is using.
    case "focus_nth":
    case "focus_number": {
      const t = pickNumbered(args.n);
      if (t) {
        // Naming an item tells us exactly where the eyes were. Hand that back
        // to the tracker as a true training pair — this is the one moment we
        // have ground truth, and it is free.
        gaze.learnFromSelection(t);
        gaze.setFocus(t);
      } else {
        const total = scan().filter((x) => x.kind === "product").length;
        bus.emit("SAY", { text: `I only see ${total} item${total === 1 ? "" : "s"}.` });
      }
      break;
    }
    case "recalibrate":
      recalibrate();
      break;
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

// Voice-reachable recalibration. Gaze drifts when you shift in your seat, and
// at a demo table the person in the chair changes every few minutes.
let recalibrating = false;
async function recalibrate() {
  if (recalibrating) return;
  if (gaze.getState().mode !== "webgazer") {
    bus.emit("SAY", { text: "There's no camera to calibrate in this mode." });
    return;
  }
  recalibrating = true;
  badges.setEnabled(false);
  try { await gaze.calibrate(); gaze.hideCamera(); }
  finally { badges.setEnabled(true); recalibrating = false; }
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
  const actual = await gaze.start({ mode: CONFIG.gazeMode, sigma: CONFIG.sigma,
                                    tune: CONFIG.tune, keepData: CONFIG.keepData });
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

// ── Drift watch ─────────────────────────────────────────────────────────────
// Calibration decays: people shift in their seat, lean in, or a new person sits
// down without recalibrating. Rather than a modal that interrupts, nudge in the
// HUD once confidence has been poor for a sustained stretch.
const DRIFT_WINDOW_MS = 10000;
const DRIFT_CONF = 0.25;
let lowSince = null, nudgedAt = 0;

bus.on("GAZE", ({ confidence }) => {
  if (recalibrating || gaze.getState().mode !== "webgazer") { lowSince = null; return; }
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

window.cue = { bus, gaze, voice, badges, context, perform, boot, say, recalibrate, CONFIG,
               measure: (...a) => gaze.measure(...a),
               experiment: (...a) => gaze.experiment(...a),
               head: () => gaze.getHead(),
               get pending() { return pendingConfirm; } };
window.aura = window.cue;          // nothing that already says aura.* breaks
addEventListener("DOMContentLoaded", boot);
