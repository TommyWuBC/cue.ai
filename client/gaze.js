import { bus } from "./bus.js";
import { scan, resolve } from "./resolver.js";

// ── Tuning ──────────────────────────────────────────────────────────────────
const MEDIAN_N    = 5;     // spike rejection window
const ALPHA_FIX   = 0.18;  // heavy smoothing while fixating
const ALPHA_SACC  = 0.75;  // light smoothing mid-saccade (snap to new target fast)
const SACCADE_PX  = 90;    // jump beyond this = saccade, not jitter
const DWELL_MS    = 380;   // how long a candidate must hold before FOCUS commits
const SWITCH_MARGIN = 0.82; // new target must be this much closer to steal focus
const LOW_CONFIDENCE_MS = 2200;
const STALE_SAMPLE_MS = 1200;

const state = {
  running: false, calibrated: false, mode: "webgazer",
  buf: [], ema: null, focus: null, cand: null, candSince: 0, conf: 0, lockUntil: 0,
  lastSampleAt: 0, lowSince: 0, qualityLow: false, calibrating: false,
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

function ingest(rawX, rawY) {
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
  state.lastSampleAt = performance.now();
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
    checkQuality();
    if (state.ema && !state.qualityLow && !state.calibrating) commitDwell(state.ema.x, state.ema.y);
  }, 60);
}

function checkQuality() {
  if (state.mode !== "webgazer" || !state.calibrated || state.calibrating) return;
  const now = performance.now();
  const p = state.ema;
  const outside = p && (p.x < -40 || p.y < -40 || p.x > innerWidth + 40 || p.y > innerHeight + 40);
  const poor = !state.lastSampleAt || now - state.lastSampleAt > STALE_SAMPLE_MS ||
    state.conf < 0.45 || outside;
  if (poor) {
    state.lowSince ||= now;
    if (!state.qualityLow && now - state.lowSince >= LOW_CONFIDENCE_MS) {
      state.qualityLow = true;
      setFocus(null, 0);
      bus.emit("GAZE_QUALITY", { low: true });
    }
  } else {
    state.lowSince = 0;
    if (state.qualityLow) {
      state.qualityLow = false;
      bus.emit("GAZE_QUALITY", { low: false });
    }
  }
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

let calibration = null;
export function calibrate() {
  if (state.mode !== "webgazer") return Promise.resolve(false);
  if (calibration) return calibration;
  calibration = (async () => {
    state.calibrating = true;
    state.calibrated = false;
    state.qualityLow = false;
    state.lowSince = 0;
    state.buf = []; state.ema = null; state.lastSampleAt = 0;
    setFocus(null, 0);
    bus.emit("GAZE_QUALITY", { low: false });
    await window.webgazer?.clearData?.();
    return new Promise((done) => {
      const ov = document.createElement("div");
      ov.className = "aura-cal";
      ov.innerHTML = `<div class="aura-cal-hint"></div><div class="aura-cal-dot"></div>`;
      document.body.appendChild(ov);
      const dot  = ov.querySelector(".aura-cal-dot");
      const hint = ov.querySelector(".aura-cal-hint");
      let i = 0;
      let recording = false;

      const show = () => {
        if (i >= POINTS.length) {
          ov.remove(); state.calibrated = true;
          state.calibrating = false;
          state.lastSampleAt = performance.now();
          removeEventListener("keydown", onKey);
          stop();
          bus.emit("STATE", { calibrated: true });
          bus.emit("SAY", { text: "Calibration done. I can see where you're looking." });
          return done(true);
        }
        const [fx, fy] = POINTS[i];
        dot.style.left = fx * innerWidth + "px";
        dot.style.top  = fy * innerHeight + "px";
        dot.classList.remove("armed");
        hint.textContent = `Look at the dot. Say “Cue, next” or press SPACE · ${i + 1} / ${POINTS.length}`;
      };

      const capture = () => {
        if (recording) return;
        recording = true;
        const [fx, fy] = POINTS[i];
        const px = fx * innerWidth, py = fy * innerHeight;
        dot.classList.add("armed");
        // Feed several samples per point — one is far too few for the ridge fit.
        let n = 0;
        const tick = setInterval(() => {
          window.webgazer?.recordScreenPosition(px, py, "click");
          if (++n >= 6) { clearInterval(tick); i++; recording = false; show(); }
        }, 55);
      };
      const onKey = (e) => {
        if (e.code !== "Space" || e.repeat) return;
        e.preventDefault();
        capture();
      };

      addEventListener("keydown", onKey);
      const stop = bus.on("UTTERANCE", ({ text, final }) => {
        if (final && /^(next|ready|capture|yes)$/i.test(text.trim())) capture();
      });
      bus.emit("SAY", { text: "Look at each dot and say Cue, next, or press space." });
      show();
    });
  })().finally(() => { calibration = null; state.calibrating = false; });
  return calibration;
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

// Keep the outline and action scope tied to the current viewport. Voice must
// never act on an item that was visible before a scroll.
export function refreshFocus() {
  const focused = state.focus;
  if (!focused) return;
  if (!focused.el.isConnected) { setFocus(null, 0); return; }
  const rect = focused.el.getBoundingClientRect();
  if (!rect.width || !rect.height || rect.bottom <= 0 || rect.top >= innerHeight ||
      rect.right <= 0 || rect.left >= innerWidth) {
    setFocus(null, 0);
    return;
  }
  state.focus = { ...focused, rect };
  bus.emit("FOCUS", { target: state.focus, prev: focused });
}

export function hideCamera() { try { window.webgazer?.showVideoPreview(false); } catch {} }
export const getFocus = () => state.focus;
export const getState = () => ({ ...state, buf: undefined });
