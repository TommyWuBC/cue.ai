import { bus } from "./bus.js";
import { scan, resolve } from "./resolver.js";

// ── Tuning ──────────────────────────────────────────────────────────────────
const MEDIAN_N    = 5;     // spike rejection window
const ALPHA_FIX   = 0.18;  // heavy smoothing while fixating
const ALPHA_SACC  = 0.75;  // light smoothing mid-saccade (snap to new target fast)
const SACCADE_PX  = 90;    // jump beyond this = saccade, not jitter
const DWELL_MS    = 380;   // how long a candidate must hold before FOCUS commits
const SWITCH_MARGIN = 0.82; // new target must be this much closer to steal focus

const state = {
  running: false, calibrated: false, mode: "webgazer",
  buf: [], ema: null, focus: null, cand: null, candSince: 0, conf: 0, lockUntil: 0,
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

function ingest(rawX, rawY) {
  // A median filter is the right tool for spike rejection but the wrong one for
  // saccades: it pins the estimate to the OLD fixation until most of the window
  // has refilled. On a real jump, drop the history and re-acquire immediately.
  const last = state.buf.at(-1);
  if (last && Math.hypot(rawX - last[0], rawY - last[1]) > SACCADE_PX) {
    state.buf.length = 0;
    state.ema = { x: rawX, y: rawY };
  }
  state.buf.push([rawX, rawY]);
  if (state.buf.length > MEDIAN_N) state.buf.shift();
  const mx = median(state.buf.map(p => p[0]));
  const my = median(state.buf.map(p => p[1]));

  if (!state.ema) state.ema = { x: mx, y: my };
  // Adaptive smoothing: stable while you stare, responsive when you look away.
  const jump  = Math.hypot(mx - state.ema.x, my - state.ema.y);
  const alpha = jump > SACCADE_PX ? ALPHA_SACC : ALPHA_FIX;
  state.ema.x += alpha * (mx - state.ema.x);
  state.ema.y += alpha * (my - state.ema.y);

  // Confidence: tight sample cloud = trustworthy fixation.
  const spread = Math.max(...state.buf.map(p => Math.hypot(p[0] - mx, p[1] - my)));
  state.conf = Math.max(0, Math.min(1, 1 - spread / 260));

  bus.emit("GAZE", { x: state.ema.x, y: state.ema.y, confidence: state.conf });
}

// Dwell runs on its own clock, not on sample arrival. A fixation is exactly when
// samples STOP moving, and webgazer drops frames constantly — either would stall
// a timer driven by incoming data.
let dwellTimer = null;
function startDwellLoop() {
  if (dwellTimer) return;
  dwellTimer = setInterval(() => {
    if (state.ema) commitDwell(state.ema.x, state.ema.y);
  }, 60);
}

function commitDwell(x, y) {
  // While a voice-set focus is locked, the eyes do not get to steal it back.
  // Without this, "the third one" is undone 60ms later, before you say "add it".
  if (performance.now() < state.lockUntil) return;
  const targets = scan();
  const { target, dist } = resolve(x, y, targets);
  const now = performance.now();

  if (target?.id !== state.cand?.id) { state.cand = target; state.candSince = now; return; }
  if (now - state.candSince < DWELL_MS) return;
  if (target?.id === state.focus?.id) return;

  // Hysteresis: don't let focus flicker between two adjacent cards.
  if (state.focus && target) {
    const fd = resolve(x, y, targets.filter(t => t.id === state.focus.id)).dist;
    if (dist > fd * SWITCH_MARGIN) return;
  }
  const prev = state.focus;
  state.focus = target;
  bus.emit("FOCUS", { target, prev });
}

// ── Calibration ─────────────────────────────────────────────────────────────
const POINTS = [[.1,.15],[.5,.15],[.9,.15],[.1,.5],[.5,.5],[.9,.5],[.1,.85],[.5,.85],[.9,.85]];

export function calibrate() {
  return new Promise((done) => {
    const ov = document.createElement("div");
    ov.className = "aura-cal";
    ov.innerHTML = `<div class="aura-cal-hint"></div><div class="aura-cal-dot"></div>`;
    document.body.appendChild(ov);
    const dot  = ov.querySelector(".aura-cal-dot");
    const hint = ov.querySelector(".aura-cal-hint");
    let i = 0;

    const show = () => {
      if (i >= POINTS.length) {
        ov.remove(); state.calibrated = true;
        bus.emit("STATE", { calibrated: true });
        bus.emit("SAY", { text: "Calibration done. I can see where you're looking." });
        return done(true);
      }
      const [fx, fy] = POINTS[i];
      dot.style.left = fx * innerWidth + "px";
      dot.style.top  = fy * innerHeight + "px";
      dot.classList.remove("armed");
      hint.textContent = `Look at the dot and press SPACE  ·  ${i + 1} / ${POINTS.length}`;
    };

    const onKey = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      const [fx, fy] = POINTS[i];
      const px = fx * innerWidth, py = fy * innerHeight;
      dot.classList.add("armed");
      // Feed several samples per point — one is far too few for the ridge fit.
      let n = 0;
      const tick = setInterval(() => {
        window.webgazer?.recordScreenPosition(px, py, "click");
        if (++n >= 6) { clearInterval(tick); i++; show(); }
      }, 55);
    };

    addEventListener("keydown", onKey);
    bus.emit("SAY", { text: "Look at each dot and press space." });
    show();
    const stop = bus.on("STATE", (s) => { if (s.calibrated) { removeEventListener("keydown", onKey); stop(); } });
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
export async function start({ mode = "webgazer" } = {}) {
  state.mode = mode;
  if (mode === "mouse") {                     // dev + demo fallback, no camera
    addEventListener("mousemove", (e) => ingest(e.clientX, e.clientY));
    startDwellLoop();
    state.calibrated = true; state.running = true;
    bus.emit("STATE", { calibrated: true, mode: "mouse" });
    return;
  }
  const wg = window.webgazer;
  if (!wg) throw new Error("webgazer not loaded");
  wg.setRegression("ridge").setTracker("TFFacemesh");
  wg.setGazeListener((d) => { if (d) ingest(d.x, d.y); });
  await wg.begin();
  try {
    wg.showVideoPreview(true).showPredictionPoints(false)
      .showFaceOverlay(false).showFaceFeedbackBox(true).applyKalmanFilter(true);
  } catch { /* version drift in the show* chain is not fatal */ }
  startDwellLoop();
  state.running = true;
  bus.emit("STATE", { mode: "webgazer", calibrated: false });
}

// Voice-driven selection ("the second one"). Locks out dwell briefly so the
// follow-up command acts on what was just named.
export function setFocus(target, lockMs = 3500) {
  const prev = state.focus;
  state.focus = target;
  state.cand = target;
  state.candSince = performance.now();
  state.lockUntil = performance.now() + lockMs;
  bus.emit("FOCUS", { target, prev });
}

export function hideCamera() { try { window.webgazer?.showVideoPreview(false); } catch {} }
export const getFocus = () => state.focus;
export const getState = () => ({ ...state, buf: undefined });
