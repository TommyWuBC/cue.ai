import { bus } from "./bus.js";
import * as gaze from "./gaze.js";
import * as voice from "./voice.js";
import { scan, nth } from "./resolver.js";

const qs = new URLSearchParams(location.search);
const CONFIG = { gazeMode: qs.get("gaze") || "webgazer", autoCal: qs.get("cal") !== "0" };

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
      <div class="aura-hud-foot">hold <kbd>space</kbd> to talk · say “Cue, …”</div>
    </div>
    <div class="aura-quality" role="status" aria-live="polite" hidden>
      <span>Gaze seems uncertain. Say “Cue, recalibrate” or use the button.</span>
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
  ui.quality = root.querySelector(".aura-quality");
  ui.quality.querySelector("button").addEventListener("click", () => perform("recalibrate", {}));
}

bus.on("GAZE_QUALITY", ({ low }) => { ui.quality.hidden = !low; });

bus.on("GAZE", ({ x, y, confidence }) => {
  ui.reticle.style.transform = `translate(${x}px, ${y}px)`;
  ui.reticle.style.opacity = 0.25 + confidence * 0.55;
});

bus.on("FOCUS", ({ target }) => {
  if (!target) { ui.outline.classList.remove("on"); return; }
  const r = target.rect;
  Object.assign(ui.outline.style, {
    transform: `translate(${r.left}px, ${r.top}px)`,
    width: r.width + "px", height: r.height + "px",
  });
  ui.outline.classList.add("on");
  ui.outline.dataset.kind = target.kind;
  ui.label.textContent = target.kind === "product"
    ? `${target.product.title} · $${target.product.price}`
    : target.label;
});

bus.on("STATE", (s) => {
  if (s.mode) ui.mode.textContent = s.mode === "mouse" ? "mouse mode" : "gaze";
  if (s.ptt !== undefined) ui.dot.classList.toggle("hot", s.ptt);
  if (s.listening) ui.dot.classList.add("live");
});

bus.on("SAY", ({ text }) => { ui.said.textContent = text; voice.speak(text); });

// ── The loop: utterance -> server -> speech + actions ───────────────────────
function context() {
  const f = gaze.getFocus();
  return {
    focused: f?.kind === "product" ? f.product : null,
    focusedAction: f?.kind === "action" ? { verb: f.verb, label: f.label } : null,
    visible: scan().filter(t => t.kind === "product").map(t => t.product),
    url: location.href,
  };
}

let inflight = false;
bus.on("UTTERANCE", async ({ text, final }) => {
  ui.heard.textContent = (final ? "" : "… ") + text;
  if (gaze.getState().calibrating) return;
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

// ── Actions the page can perform ────────────────────────────────────────────

// The card the user is looking at. Every product-specific action is scoped to it.
function scope() {
  const f = gaze.getFocus();
  if (!f) return null;
  return f.kind === "product" ? f.el : f.el.closest("[data-aura-product]");
}

function perform(verb, args) {
  switch (verb) {
    case "scroll":
      scrollBy({ top: (args.dir === "up" ? -1 : 1) * innerHeight * 0.75, behavior: "smooth" });
      break;
    case "focus_nth": {
      const t = nth(args.n);
      if (t) gaze.setFocus(t);
      else bus.emit("SAY", { text: `I only see ${scan().filter(x => x.kind === "product").length} items.` });
      break;
    }
    case "click_focused": gaze.getFocus()?.el.click(); break;
    case "select_variant": {
      const el = scope()?.querySelector(
        `[data-aura-action="select_variant"][data-aura-value="${CSS.escape(String(args.value).toUpperCase())}"]`);
      if (!el) { bus.emit("SAY", { text: `I don't see size ${args.value} on this one.` }); break; }
      el.click();
      break;
    }
    case "add_to_cart": {
      // MUST be scoped to what they were looking at. A global querySelector here
      // adds the first product on the page — i.e. charges for the wrong item.
      const el = scope()?.querySelector('[data-aura-action="add_to_cart"]');
      if (!el) { bus.emit("SAY", { text: "Look at the item you want first." }); break; }
      el.click();
      break;
    }
    case "checkout":
      document.querySelector('[data-aura-action="checkout"]')?.click();
      break;
    case "recalibrate":
      gaze.calibrate().then(() => gaze.hideCamera()).catch(e => {
        console.error("[cue] recalibration failed", e);
        bus.emit("SAY", { text: "I couldn't recalibrate. Please check the camera." });
      });
      break;
    case "navigate": location.href = args.url; break;
    default: console.warn("[aura] unknown verb", verb, args);
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  mountUI();
  await gaze.start({ mode: CONFIG.gazeMode });
  voice.startListening();
  if (CONFIG.gazeMode === "webgazer" && CONFIG.autoCal) {
    await gaze.calibrate();
    gaze.hideCamera();
  }
  bus.emit("SAY", { text: "Cue is ready. Look at something and ask me about it." });
}

// say() is how you drive Aura with no mic: from the console, from a test, or
// from the on-stage fallback if the demo floor is too loud to be heard.
const say = (text) => bus.emit("UTTERANCE", { text, final: true });

window.cue = { bus, gaze, voice, context, perform, boot, say, CONFIG };
window.aura = window.cue; // Compatibility for existing demo scripts.
addEventListener("DOMContentLoaded", boot);
