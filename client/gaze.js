import { bus } from "./bus.js";
import { scan, resolve } from "./resolver.js";

// ── Tuning ──────────────────────────────────────────────────────────────────
// One Euro filter. A fixed EMA forces a choice between "stable" and "keeps up";
// One Euro raises its own cutoff with observed speed, so it is heavy while you
// stare and light the instant you look away. The previous median+EMA pair
// removed 0% of the noise because its saccade escape hatch fired on almost
// every frame (webgazer's frame-to-frame delta routinely exceeds any threshold
// small enough to catch a real saccade).
// Swept against sim mode over 6 noise seeds (see ?gaze=sim). At sigma=70:
//   noise sd 19.3px · frame-to-frame jitter 6.5px · settles a 400px jump in 260ms.
// dCutoff has to sit well BELOW the noise frequency or the speed estimate is
// driven by the noise itself and beta re-opens the filter it was meant to close.
const MIN_CUTOFF = 0.20;  // Hz — smoothing floor while fixating
const BETA       = 0.002; // speed coupling; higher = snappier but noisier
const D_CUTOFF   = 0.30;  // Hz — cutoff for the speed estimate itself

// Mouse mode is ground truth, so it needs far less help. It keeps a little
// smoothing on purpose: on stage the fallback should move like the real thing.
const MOUSE_TUNING = { minCutoff: 3.5, beta: 0.05, dCutoff: 1.0 };

// Outlier gate. Webgazer emits 300px+ flyers that are not eye movements. One
// far sample is a flyer and gets dropped; three that agree with each other are
// a real saccade and re-acquire immediately.
const OUTLIER_PX       = 190;
const SACCADE_CONFIRM  = 3;
const SACCADE_AGREE_PX = 150;

const DWELL_MS      = 380;  // how long a candidate holds before FOCUS commits
const SWITCH_MARGIN = 0.82; // new target must be this much closer to steal focus
const EDGE          = 6;    // keep the reticle on screen at the extremes

const state = {
  running: false, calibrated: false, mode: "webgazer",
  point: null, focus: null, cand: null, candSince: 0, conf: 0, lockUntil: 0,
  fx: null, fy: null,
  // Affine range correction, learned in the calibration validation pass.
  cal: { ax: 1, bx: 0, ay: 1, by: 0 },
  accuracy: null,
};

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean   = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

// ── One Euro ────────────────────────────────────────────────────────────────
function lowpass() {
  let y = null;
  return {
    filter(x, alpha) { y = y === null ? x : y + alpha * (x - y); return y; },
    reset() { y = null; },
  };
}

export function oneEuro({ minCutoff, beta, dCutoff }) {
  const xf = lowpass(), dxf = lowpass();
  let tPrev = null, xPrev = null;
  const alpha = (cutoff, dt) => {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  };
  return {
    reset(x, t) { xf.reset(); dxf.reset(); tPrev = t; xPrev = x; return x; },
    filter(x, t) {
      if (tPrev === null) { tPrev = t; xPrev = x; return xf.filter(x, 1); }
      // Clamp dt: webgazer drops frames constantly and a 2s gap would otherwise
      // make alpha ~1 and pass the raw sample straight through.
      const dt = Math.max(0.008, Math.min(0.2, t - tPrev));
      tPrev = t;
      const dx = (x - xPrev) / dt;
      xPrev = x;
      const dxHat = dxf.filter(dx, alpha(dCutoff, dt));
      const cutoff = minCutoff + beta * Math.abs(dxHat);
      return xf.filter(x, alpha(cutoff, dt));
    },
  };
}

// ── Outlier gate ────────────────────────────────────────────────────────────
const recent = [];
let pending = [];

function gate(x, y, t) {
  recent.push([x, y]);
  if (recent.length > 7) recent.shift();
  if (recent.length < 4) return { x, y };

  const mx = median(recent.map((p) => p[0]));
  const my = median(recent.map((p) => p[1]));
  if (Math.hypot(x - mx, y - my) <= OUTLIER_PX) { pending = []; return { x, y }; }

  // Far from the cloud. Saccade, or flyer?
  pending.push([x, y]);
  const tail = pending.slice(-SACCADE_CONFIRM);
  const confirmed = tail.length === SACCADE_CONFIRM &&
    tail.every(([px, py]) => Math.hypot(px - x, py - y) < SACCADE_AGREE_PX);

  if (!confirmed) { recent.pop(); return null; }   // drop it, keep the cloud clean

  recent.length = 0; recent.push([x, y]);
  pending = [];
  state.fx.reset(x, t); state.fy.reset(y, t);
  return { x, y };
}

function confidence() {
  if (recent.length < 3) return 0;
  const mx = median(recent.map((p) => p[0]));
  const my = median(recent.map((p) => p[1]));
  const spread = mean(recent.map((p) => Math.hypot(p[0] - mx, p[1] - my)));
  return Math.max(0, Math.min(1, 1 - spread / 150));
}

// ── Ingest ──────────────────────────────────────────────────────────────────
function ingest(rawX, rawY) {
  const t = performance.now() / 1000;

  // Range correction first: webgazer's ridge fit compresses toward the screen
  // centre, so the corners are literally unreachable without this.
  let x = state.cal.ax * rawX + state.cal.bx;
  let y = state.cal.ay * rawY + state.cal.by;

  const kept = gate(x, y, t);
  if (!kept) return;
  x = state.fx.filter(kept.x, t);
  y = state.fy.filter(kept.y, t);

  x = Math.max(EDGE, Math.min(innerWidth - EDGE, x));
  y = Math.max(EDGE, Math.min(innerHeight - EDGE, y));

  state.point = { x, y };
  state.conf = confidence();
  bus.emit("GAZE", { x, y, confidence: state.conf });
}

// ── Dwell ───────────────────────────────────────────────────────────────────
// Runs on its own clock, not on sample arrival. A fixation is exactly when
// samples STOP moving, and webgazer drops frames constantly — either would
// stall a timer driven by incoming data.
let dwellTimer = null;
function startDwellLoop() {
  if (dwellTimer) return;
  dwellTimer = setInterval(() => {
    if (state.point) commitDwell(state.point.x, state.point.y);
  }, 60);
}

function commitDwell(x, y) {
  // While a voice-set focus is locked, the eyes do not get to steal it back.
  // Without this, "the third one" is undone 60ms later, before you say "add it".
  if (performance.now() < state.lockUntil) return;
  const targets = scan();
  const { target, score } = resolve(x, y, targets);
  const now = performance.now();

  if (target?.id !== state.cand?.id) { state.cand = target; state.candSince = now; return; }
  if (now - state.candSince < DWELL_MS) return;
  if (target?.id === state.focus?.id) return;

  // Hysteresis: don't let focus flicker between two adjacent cards. Compare
  // like with like — the incumbent has to be scored the same way the
  // challenger was, or an action's 0.75x discount decides the contest.
  if (state.focus && target) {
    const incumbent = targets.filter((t) => t.id === state.focus.id);
    if (incumbent.length) {
      const fs = resolve(x, y, incumbent).score;
      if (score > fs * SWITCH_MARGIN) return;
    }
  }
  const prev = state.focus;
  state.focus = target;
  bus.emit("FOCUS", { target, prev });
}

// ── Calibration ─────────────────────────────────────────────────────────────
// Training points sit closer to the edges than before. Ridge regression does
// not extrapolate: whatever box you train inside is the box you can reach, and
// the old grid stopped at 10%/15% from each edge.
const TRAIN = [
  [.06, .08], [.5, .08], [.94, .08],
  [.06, .50], [.5, .50], [.94, .50],
  [.06, .92], [.5, .92], [.94, .92],
];

// Then a short pass where we watch what webgazer ACTUALLY predicts while the
// user looks at known points, and fit a correction. This is what buys back the
// corners, and it gives us an accuracy number worth showing a judge.
const VALIDATE = [[.06, .08], [.94, .08], [.5, .5], [.06, .92], [.94, .92]];

export function fit1d(pred, truth) {
  const mp = mean(pred), mt = mean(truth);
  let num = 0, den = 0;
  for (let i = 0; i < pred.length; i++) {
    num += (pred[i] - mp) * (truth[i] - mt);
    den += (pred[i] - mp) ** 2;
  }
  let a = den > 1e-6 ? num / den : 1;
  a = Math.max(0.5, Math.min(3.5, a));        // refuse an absurd gain
  return { a, b: mt - a * mp };
}

function rms(obs, ax, bx, ay, by) {
  return Math.sqrt(mean(obs.map(([px, py, tx, ty]) =>
    (ax * px + bx - tx) ** 2 + (ay * py + by - ty) ** 2)));
}

export function calibrate() {
  return new Promise((done) => {
    const ov = document.createElement("div");
    ov.className = "cue-cal";
    ov.innerHTML = `<div class="cue-cal-hint"></div><div class="cue-cal-dot"></div>`;
    document.body.appendChild(ov);
    const dot  = ov.querySelector(".cue-cal-dot");
    const hint = ov.querySelector(".cue-cal-hint");
    let i = 0;

    // Space is push-to-talk everywhere else. Tell voice.js to stand down.
    bus.emit("STATE", { calibrating: true });

    const finish = async () => {
      // Must match the capture flag it was added with, or it is never removed
      // and space keeps re-triggering calibration points under the store page.
      removeEventListener("keydown", onKey, true);
      hint.textContent = "Now just look at each dot — no key, checking accuracy";
      const obs = [];
      for (let k = 0; k < VALIDATE.length; k++) {
        const [fx, fy] = VALIDATE[k];
        const px = fx * innerWidth, py = fy * innerHeight;
        dot.style.left = px + "px"; dot.style.top = py + "px";
        dot.classList.remove("armed");
        await sleep(650);                       // let the eye land
        dot.classList.add("armed");
        for (let n = 0; n < 14; n++) {
          try {
            const p = await window.webgazer.getCurrentPrediction();
            if (p && Number.isFinite(p.x)) obs.push([p.x, p.y, px, py]);
          } catch { /* a dropped frame is not fatal */ }
          await sleep(45);
        }
      }

      if (obs.length >= 25) {
        const fx = fit1d(obs.map((o) => o[0]), obs.map((o) => o[2]));
        const fy = fit1d(obs.map((o) => o[1]), obs.map((o) => o[3]));
        const before = rms(obs, 1, 0, 1, 0);
        const after  = rms(obs, fx.a, fx.b, fy.a, fy.b);
        // Only keep the correction if it actually helps.
        if (after < before) {
          state.cal = { ax: fx.a, bx: fx.b, ay: fy.a, by: fy.b };
        }
        state.accuracy = {
          before_px: Math.round(before),
          after_px: Math.round(Math.min(before, after)),
          gain_x: +fx.a.toFixed(2), gain_y: +fy.a.toFixed(2),
          samples: obs.length,
        };
        console.log("[cue] calibration", state.accuracy, state.cal);
      }

      ov.remove();
      state.calibrated = true;
      recent.length = 0; pending = [];
      state.fx.reset(innerWidth / 2, performance.now() / 1000);
      state.fy.reset(innerHeight / 2, performance.now() / 1000);
      bus.emit("STATE", { calibrated: true, calibrating: false, accuracy: state.accuracy });

      const q = state.accuracy?.after_px;
      bus.emit("SAY", {
        text: q && q > 170
          ? "Calibration is a bit loose, but I can work with it. Look at something and ask me about it."
          : "Calibration done. I can see where you're looking.",
      });
      done(true);
    };

    const show = () => {
      if (i >= TRAIN.length) { finish(); return; }
      const [fx, fy] = TRAIN[i];
      dot.style.left = fx * innerWidth + "px";
      dot.style.top  = fy * innerHeight + "px";
      dot.classList.remove("armed");
      hint.textContent = `Look at the dot and press SPACE  ·  ${i + 1} / ${TRAIN.length}`;
    };

    const onKey = (e) => {
      if (e.code !== "Space") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      const [fx, fy] = TRAIN[i];
      const px = fx * innerWidth, py = fy * innerHeight;
      dot.classList.add("armed");
      // Feed several samples per point — one is far too few for the ridge fit.
      let n = 0;
      const tick = setInterval(() => {
        window.webgazer?.recordScreenPosition(px, py, "click");
        if (++n >= 8) { clearInterval(tick); i++; show(); }
      }, 55);
    };

    addEventListener("keydown", onKey, true);
    bus.emit("SAY", { text: "Look at each dot and press space." });
    show();
  });
}

// ── Boot ────────────────────────────────────────────────────────────────────
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export async function start({ mode = "webgazer", sigma = 70, tune = null } = {}) {
  state.mode = mode;
  const tuning = tune ?? (mode === "mouse"
    ? MOUSE_TUNING
    : { minCutoff: MIN_CUTOFF, beta: BETA, dCutoff: D_CUTOFF });
  state.tuning = tuning;
  state.fx = oneEuro(tuning);
  state.fy = oneEuro(tuning);

  if (mode === "mouse") {                     // dev + demo fallback, no camera
    addEventListener("mousemove", (e) => ingest(e.clientX, e.clientY));
    startDwellLoop();
    state.calibrated = true; state.running = true;
    bus.emit("STATE", { calibrated: true, mode: "mouse" });
    return "mouse";
  }

  // ?gaze=sim — mouse as ground truth with synthetic webgazer noise on top,
  // run through the real filter chain. This is how you feel what the gaze
  // experience is actually like, and tune it, without a camera or a face.
  if (mode === "sim") {
    let tx = innerWidth / 2, ty = innerHeight / 2;
    addEventListener("mousemove", (e) => { tx = e.clientX; ty = e.clientY; });
    setInterval(() => ingest(tx + gauss() * sigma, ty + gauss() * sigma), 40);
    startDwellLoop();
    state.calibrated = true; state.running = true;
    bus.emit("STATE", { calibrated: true, mode: "sim" });
    return "sim";
  }
  const wg = window.webgazer;
  if (!wg) return degrade("webgazer did not load", sigma);

  // Webgazer's face mesh runs on TF.js, which needs WebGL. Brave's
  // fingerprinting protection farbles canvas/WebGL readback and can take it
  // away entirely — in which case begin() hangs instead of failing, and the
  // page sits there forever with no calibration and no explanation.
  if (!webglAvailable()) {
    return degrade("this browser is blocking WebGL (Brave Shields?)", sigma);
  }

  wg.setRegression("ridge").setTracker("TFFacemesh");
  wg.setGazeListener((d) => { if (d) ingest(d.x, d.y); });

  const began = await Promise.race([
    wg.begin().then(() => true).catch((e) => { console.warn("[cue] webgazer.begin", e); return false; }),
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  if (began !== true) {
    return degrade(began === "timeout"
      ? "the camera did not start within 15 seconds"
      : "webgazer could not start the camera", sigma);
  }

  try {
    wg.showVideoPreview(true).showPredictionPoints(false)
      .showFaceOverlay(false).showFaceFeedbackBox(true).applyKalmanFilter(true);
  } catch { /* version drift in the show* chain is not fatal */ }
  startDwellLoop();
  state.running = true;
  bus.emit("STATE", { mode: "webgazer", calibrated: false });
  return "webgazer";
}

function webglAvailable() {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch { return false; }
}

// Never leave a blank page. If the camera cannot work, say why out loud and
// fall through to the mouse so the demo still runs.
function degrade(why, sigma) {
  console.error("[cue] gaze unavailable:", why, "— falling back to the mouse");
  state.mode = "mouse";
  state.fx = oneEuro(MOUSE_TUNING);
  state.fy = oneEuro(MOUSE_TUNING);
  addEventListener("mousemove", (e) => ingest(e.clientX, e.clientY));
  startDwellLoop();
  state.calibrated = true; state.running = true;
  bus.emit("STATE", { calibrated: true, mode: "mouse", gazeError: why });
  return "mouse";
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
export const getAccuracy = () => state.accuracy;
export const getState = () => ({ ...state, fx: undefined, fy: undefined });
