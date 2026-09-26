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

// One tuning cannot serve every face and every room. The constants above were
// swept at sigma=70; at the 242px we actually measured they leave sd 112 and
// 47px of jitter, which reads as the cursor flying around. Re-sweeping at 242
// gives sd 56 / jitter 16 — but those constants are sluggish on a good signal.
// So pick the tuning from the accuracy we just measured, and stop guessing.
const TUNINGS = [
  { upTo: 120,      minCutoff: 0.20, beta: 0.0020, dCutoff: 0.30 },  // swept at sigma 70
  { upTo: 200,      minCutoff: 0.15, beta: 0.0010, dCutoff: 0.30 },
  { upTo: Infinity, minCutoff: 0.10, beta: 0.0005, dCutoff: 0.30 },  // swept at sigma 242
];

function tuningFor(px) {
  const t = TUNINGS.find((x) => px <= x.upTo) ?? TUNINGS.at(-1);
  return { minCutoff: t.minCutoff, beta: t.beta, dCutoff: t.dCutoff };
}

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
  precise: true,   // is gaze accurate enough to be trusted as a pointer?
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

// Quality thresholds, in px of measured error. Amazon's product tiles are
// 249px wide, so anything past POOR cannot resolve one item from its neighbour
// and the numbered-badge path has to carry the interaction instead.
const GOOD_PX = 150;
const POOR_PX = 220;

function runCalibration(attempt) {
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

      // Retune the filter to the signal we actually got.
      if (state.accuracy && state.mode === "webgazer" && !state.tuneLocked) {
        const t = tuningFor(state.accuracy.after_px);
        state.tuning = t;
        state.fx = oneEuro(t);
        state.fy = oneEuro(t);
        console.log("[cue] filter tuned for", state.accuracy.after_px + "px:", t);
      }

      recent.length = 0; pending = [];
      state.fx.reset(innerWidth / 2, performance.now() / 1000);
      state.fy.reset(innerHeight / 2, performance.now() / 1000);
      // NOTE: calibrating stays true — the wrapper may still put a modal up,
      // and space must not become push-to-talk underneath it.
      bus.emit("STATE", { calibrated: true, accuracy: state.accuracy });
      done(state.accuracy);
    };

    const show = () => {
      if (i >= TRAIN.length) { finish(); return; }
      const [fx, fy] = TRAIN[i];
      dot.style.left = fx * innerWidth + "px";
      dot.style.top  = fy * innerHeight + "px";
      dot.classList.remove("armed");
      const again = attempt > 1 ? `  ·  attempt ${attempt}` : "";
      hint.textContent = `Look at the dot and press SPACE  ·  ${i + 1} / ${TRAIN.length}${again}`;
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
    if (attempt === 1) bus.emit("SAY", { text: "Look at each dot and press space." });
    show();
  });
}

// ── Quality gate ────────────────────────────────────────────────────────────
// A number in the console helps nobody at a demo table. If the calibration is
// not good enough to pick a product, say so in words, say what usually causes
// it, and offer to do it again — this is the difference between a judge who
// thinks the idea is broken and one who gets a clean run on the second try.
function qualityModal(acc, attempt) {
  return new Promise((choose) => {
    const poor = acc.after_px > POOR_PX;
    const ov = document.createElement("div");
    ov.className = "cue-modal";
    ov.innerHTML = `
      <div class="cue-modal-card">
        <h3>${poor ? "I can't see where you're looking well enough" : "That calibration is a bit loose"}</h3>
        <p class="cue-modal-num">${acc.after_px}px <span>average error</span></p>
        <p>${poor
          ? "At this accuracy I'd be guessing which item you mean. One more try usually fixes it."
          : "Good enough to work, but you'll get better results from another pass."}</p>
        <ul>
          <li>Sit so your face fills the little preview, roughly an arm's length away</li>
          <li>Avoid a bright window behind you</li>
          <li>Move your eyes to each dot, not your head</li>
          <li>Stay in the same position afterwards</li>
        </ul>
        <div class="cue-modal-row">
          <button class="cue-btn cue-btn-primary" data-act="recal">Try again</button>
          <button class="cue-btn" data-act="continue">Continue anyway</button>
        </div>
        <p class="cue-modal-foot">Either way you can pick items by saying the number
          shown on them, and Cue gets more accurate the more you do.</p>
      </div>`;
    document.body.appendChild(ov);

    const pick = (act) => { ov.remove(); choose(act); };
    ov.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) pick(b.dataset.act);
    });
    // Keyboard reachable — this is an accessibility tool.
    ov.querySelector(".cue-btn-primary").focus();
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); pick("continue"); }
    });

    bus.emit("SAY", {
      text: poor
        ? "I can't see where you're looking well enough. Shall we try that again?"
        : "That's a bit loose. You can try again, or continue.",
    });
  });
}

export async function calibrate({ allowRetry = true, maxAttempts = 2 } = {}) {
  for (let attempt = 1; ; attempt++) {
    const acc = await runCalibration(attempt);

    const bad = acc && acc.after_px > GOOD_PX;
    if (allowRetry && bad && attempt < maxAttempts) {
      if (await qualityModal(acc, attempt) === "recal") continue;
    }

    bus.emit("STATE", { calibrating: false, accuracy: acc });
    const q = acc?.after_px;
    bus.emit("SAY", {
      text: !q || q <= GOOD_PX
        ? "Calibration done. I can see where you're looking."
        : "Alright. I'll show numbers on the items so you can just say which one.",
    });
    // Tell the rest of the app whether gaze is precise enough to be trusted as
    // a pointer. Below this bar, numbered badges lead the interaction.
    state.precise = !q || q <= POOR_PX;
    bus.emit("STATE", { precise: state.precise });
    return acc;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

export async function start({ mode = "webgazer", sigma = 70, tune = null, keepData = false } = {}) {
  state.mode = mode;
  const tuning = tune ?? (mode === "mouse"
    ? MOUSE_TUNING
    : { minCutoff: MIN_CUTOFF, beta: BETA, dCutoff: D_CUTOFF });
  state.tuning = tuning;
  state.tuneLocked = !!tune;        // an explicit ?mc= override wins over auto-tuning
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

  // Webgazer persists its training data across sessions by default, and
  // begin() installs capture-phase click/mousemove listeners on document that
  // keep training the ridge model on the assumption that you were looking
  // wherever you clicked. Together those two defaults are poison: every click
  // in every past session — including the mouse- and sim-mode runs, where the
  // cursor had nothing to do with the eyes — wrote a false training pair into
  // a model that survives reloads. Measured cost: 242px error against
  // webgazer's own published ~130px.
  if (!keepData) {
    try { wg.saveDataAcrossSessions(false); } catch {}
  }

  const began = await Promise.race([
    wg.begin().then(() => true).catch((e) => { console.warn("[cue] webgazer.begin", e); return false; }),
    new Promise((r) => setTimeout(() => r("timeout"), 15000)),
  ]);
  if (began !== true) {
    return degrade(began === "timeout"
      ? "the camera did not start within 15 seconds"
      : "webgazer could not start the camera", sigma);
  }

  if (!keepData) {
    // clearData() is async and only exists after begin(); it wipes localForage
    // and re-inits the regression, so it has to run here, not before.
    try { await wg.clearData(); console.log("[cue] cleared stored gaze model"); }
    catch (e) { console.warn("[cue] clearData", e); }
  } else {
    console.warn("[cue] ?keepdata=1 — reusing the stored gaze model");
  }

  // Kill the implicit click/mousemove training for good. From here the ONLY
  // thing that trains the model is our own calibration points, which are the
  // only moments we actually know where the eyes were.
  try { wg.removeMouseEventListeners(); } catch (e) { console.warn("[cue] removeMouseEventListeners", e); }

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

// ── Learning from what the voice confirms ───────────────────────────────────
// Webgazer's built-in click training assumes you were looking wherever you
// clicked, which is often false — that assumption is most of why the stored
// model was so bad. But Cue has something better: when you SAY "two", we know
// with certainty which item you meant, and the badge was only on screen
// because you were already looking near it. That is a true training pair,
// handed to us by the interaction itself.
//
// So every spoken selection quietly improves the model. Calibration stops
// being a thing you do once at the start and decays from; it gets better the
// more you use it.
const LEARN_MAX_PX = 420;     // beyond this the pair is not credible
let learned = 0;

export function learnFromSelection(target) {
  if (state.mode !== "webgazer" || !state.calibrated || !target?.el) return false;
  const r = target.el.getBoundingClientRect();
  if (!r.width) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

  // Only learn when the eyes were plausibly already there. If someone names an
  // item while looking out the window, that pair is a lie and would undo the
  // work the calibration just did.
  const p = state.point;
  if (!p || Math.hypot(p.x - cx, p.y - cy) > LEARN_MAX_PX) return false;

  // Feed it in the raw prediction frame, undoing our affine correction —
  // webgazer trains on its own output, not on ours.
  try {
    window.webgazer?.recordScreenPosition(cx, cy, "click");
    learned++;
    if (learned % 5 === 0) console.log(`[cue] learned from ${learned} spoken selections`);
    return true;
  } catch { return false; }
}

export const getLearned = () => learned;

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
export const isPrecise  = () => state.precise;
export const getState = () => ({ ...state, fx: undefined, fy: undefined });
