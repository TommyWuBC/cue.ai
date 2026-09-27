import { bus } from "./bus.js";
import { scan, resolve } from "./resolver.js";
import * as realEyes from "./eyes.js";
import { fitGazeModel, loadGazeModel, bestPursuitLag } from "./gaze-model.js";
import { fixationFilter } from "./fixation.js";
import { createAttention } from "./attention.js";

// The engine is swappable so tests can drive calibration with synthetic frames.
let eyes = realEyes;
export function setEngine(engine) { eyes = engine ?? realEyes; }

// Gaze v2 (docs/GAZE.md). The camera path is MediaPipe Face Landmarker ->
// landmark features -> a per-user model fitted at calibration -> outlier gate
// -> One Euro -> fixation stabiliser. The mode is still called "webgazer"
// everywhere (aura.js, the extension) and now simply means "the camera".
const VENDOR = new URL("../vendor/", import.meta.url).href;
const MEDIAPIPE = {
  bundle: VENDOR + "mediapipe/vision_bundle.mjs",
  wasmLoader: VENDOR + "mediapipe/wasm/vision_wasm_internal.js",
  wasmBinary: VENDOR + "mediapipe/wasm/vision_wasm_internal.wasm",
  model: VENDOR + "models/face_landmarker.task",
};

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

// Camera tunings for gaze v2. The fixation stabiliser is what keeps the
// estimate still while you look at something, so One Euro only has to take the
// edge off and can stay light, which is where the lag used to come from.
const CAMERA_TUNINGS = [
  { upTo: 120,      minCutoff: 1.0, beta: 0.020, dCutoff: 1.0 },
  { upTo: 200,      minCutoff: 0.7, beta: 0.012, dCutoff: 1.0 },
  { upTo: Infinity, minCutoff: 0.5, beta: 0.008, dCutoff: 1.0 },
];

function tuningFor(px, table = state.mode === "webgazer" ? CAMERA_TUNINGS : TUNINGS) {
  const t = table.find((x) => px <= x.upTo) ?? table.at(-1);
  return { minCutoff: t.minCutoff, beta: t.beta, dCutoff: t.dCutoff };
}

// How far the eyes can wander and still count as the same fixation. Scales
// with how good the calibration turned out: a sloppy fit needs a wider net or
// every sample looks like a saccade.
const fixRadiusFor = (px) => Math.max(45, Math.min(120, 0.4 * (px ?? 150)));

// Outlier gate. Webgazer emits 300px+ flyers that are not eye movements. One
// far sample is a flyer and gets dropped; three that agree with each other are
// a real saccade and re-acquire immediately.
const OUTLIER_PX       = 190;
const SACCADE_CONFIRM  = 3;
const SACCADE_AGREE_PX = 150;
// Escape hatch. Requiring three consecutive samples to agree within 150px is
// fine at sigma=70, but at the sigma=242 we actually measure, consecutive
// samples differ by ~340px on average and that agreement almost never happens
// — so a genuine large gaze shift could be rejected indefinitely and the
// estimate would sit frozen at the old location. If we have been rejecting
// this long, the world has moved whether the samples agree or not.
const SACCADE_STUCK = 6;

const DWELL_MS      = 380;  // how long a candidate holds before FOCUS commits
const SWITCH_MARGIN = 0.82; // new target must be this much closer to steal focus
const EDGE          = 6;    // keep the reticle on screen at the extremes

// Tracking can be bad without being noisy — a stale feed or a face out of
// frame gives a perfectly steady, perfectly wrong estimate. These bound how
// long that is tolerated before focus is dropped entirely.
const LOW_CONFIDENCE_MS = 2200;
const STALE_SAMPLE_MS   = 1200;

const state = {
  running: false, calibrated: false, mode: "webgazer", gazeError: null,
  point: null, focus: null, cand: null, candSince: 0, conf: 0, lockUntil: 0,
  precise: true,   // is gaze accurate enough to be trusted as a pointer?
  fx: null, fy: null,
  // Affine range correction, learned in the calibration validation pass.
  cal: { ax: 1, bx: 0, ay: 1, by: 0 },
  accuracy: null,
  lastSampleAt: 0, lowSince: 0, qualityLow: false, calibrating: false,
};

// Gaze v2: the per-user model and the samples it was fitted on.
let model = null;
let training = [];
let fixer = fixationFilter();

// Where the eyes have been, as probabilities over what is on screen
// (attention.js). The highlight, "this" at speech onset and the agent's
// context all read from this, never from a single raw point.
const attention = createAttention();

function attentionSigma() {
  if (state.mode === "mouse") return 45;
  if (state.mode === "sim") return Math.max(60, (state.sigma ?? 70) * 0.8);
  return Math.max(70, 0.8 * (state.accuracy?.after_px ?? 180));
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const mean   = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const sleep  = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Stray trackpad input ────────────────────────────────────────────────────
// A palm brushing the trackpad, or a stray swipe, should not steer Cue. In the
// mouse-driven modes the pointer only counts while it is actually being moved;
// after POINTER_IDLE_MS of stillness it is treated as abandoned and stops
// driving gaze, so focus stays where it was rather than being held hostage by
// wherever the cursor happened to land.
const POINTER_IDLE_MS = 3000;
let lastPointer = 0;

function touchPointer() { lastPointer = performance.now(); }
function pointerStale() { return performance.now() - lastPointer > POINTER_IDLE_MS; }

export const getPointerIdleMs = () => Math.round(performance.now() - lastPointer);

// In gaze mode the user is not holding the trackpad at all, so a real click on
// something that spends money is far more likely to be an accident than an
// intent. Cue's own clicks are synthetic (isTrusted === false) and pass
// straight through; a human one is stopped and explained.
const MONEY_ACTIONS = new Set(["add_to_cart", "checkout"]);

let clickGuardBound = false;
function guardStrayClicks() {
  if (clickGuardBound) return;
  clickGuardBound = true;
  addEventListener("click", (e) => {
    if (state.mode !== "webgazer" || !state.calibrated) return;
    if (!e.isTrusted) return;                 // this was us, via el.click()
    const el = e.target?.closest?.("[data-cue-action],[data-aura-action]");
    if (!el) return;
    const verb = el.dataset.cueAction ?? el.dataset.auraAction;
    if (!MONEY_ACTIONS.has(verb)) return;     // sizes etc. are harmless
    e.preventDefault();
    e.stopPropagation();
    bus.emit("SAY", { text: "I ignored that tap. Say it out loud instead." });
    console.warn("[cue] blocked a stray trusted click on", verb);
  }, true);
}

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

// ── Head pose ───────────────────────────────────────────────────────────────
// Webgazer maps eye appearance to screen position with a ridge regression
// fitted at one head position. Move your head and that mapping is simply wrong
// — this is the single largest source of drift after calibration, and no amount
// of filtering fixes it because the error is systematic, not noise.
//
// We cannot retrain webgazer per frame, but we can see the head move: the face
// mesh is right there. So we track it, and do three things with it.
//
//   1. Penalise confidence while the head is away from where it calibrated.
//      A wider reticle and badge-led selection is the honest response to a
//      mapping we know is off.
//   2. Nudge for recalibration once it has moved too far to rescue.
//   3. Subtract a linear estimate of the induced error, with the gain LEARNED
//      from spoken selections rather than guessed — see fitHeadGain().

// How far the head can drift, as a fraction of interocular distance, before we
// stop trusting the mapping. One IOD is roughly the width of an eye socket —
// moving that far genuinely invalidates the fit.
const HEAD_SOFT = 0.35;   // confidence starts falling
const HEAD_HARD = 1.10;   // suggest recalibrating

const head = { base: null, now: null, samples: [], gain: null };

function readHead() {
  // The engine reports head position in normalised image units with the
  // interocular distance as a depth proxy, so offsets stay comparable across
  // distances from the camera. A face lost for over half a second is lost.
  const s = eyes.latest();
  if (!s?.head || performance.now() - s.t > 500) return null;
  return { x: s.head.x, y: s.head.y, iod: s.head.iod };
}

/** Head offset from the calibration pose, in interocular-distance units. */
function headOffset() {
  const h = head.now, b = head.base;
  if (!h || !b) return null;
  const scale = b.iod || 1;
  return {
    dx: (h.x - b.x) / scale,
    dy: (h.y - b.y) / scale,
    dz: (h.iod - b.iod) / scale,       // positive = leaned closer
    dist: Math.hypot((h.x - b.x) / scale, (h.y - b.y) / scale),
  };
}

/**
 * Learn how head movement maps to gaze error, from the pairs the voice gives
 * us. Each spoken selection contributes (head offset, resulting error); a
 * least-squares fit per axis turns that into a correction.
 *
 * Deliberately conservative: nothing is applied until there are enough samples
 * spread over enough head movement, and the gain is clamped. A wrong
 * compensation is worse than none.
 */
const HEAD_MIN_SAMPLES = 8;
const HEAD_MAX_GAIN = 900;     // px of correction per IOD of head movement

function fitHeadGain() {
  const S = head.samples;
  if (S.length < HEAD_MIN_SAMPLES) return null;
  // Require real spread, or we are fitting to noise around a single pose.
  const spreadX = Math.max(...S.map((s) => s.dx)) - Math.min(...S.map((s) => s.dx));
  const spreadY = Math.max(...S.map((s) => s.dy)) - Math.min(...S.map((s) => s.dy));
  if (spreadX < 0.12 && spreadY < 0.12) return null;

  const fx = fit1d(S.map((s) => s.dx), S.map((s) => s.ex));
  const fy = fit1d(S.map((s) => s.dy), S.map((s) => s.ey));
  const gx = Math.max(-HEAD_MAX_GAIN, Math.min(HEAD_MAX_GAIN, fx.a));
  const gy = Math.max(-HEAD_MAX_GAIN, Math.min(HEAD_MAX_GAIN, fy.a));
  return { gx, gy, n: S.length };
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
  const agreed = tail.length === SACCADE_CONFIRM &&
    tail.every(([px, py]) => Math.hypot(px - x, py - y) < SACCADE_AGREE_PX);

  // Either the samples agree (clean saccade), or we have rejected so many in a
  // row that continuing to reject is the bigger error.
  const stuck = pending.length >= SACCADE_STUCK;
  if (!agreed && !stuck) { recent.pop(); return null; }

  // When we get here by being stuck the individual samples are noisy, so
  // re-acquire at the median of what we rejected rather than at the last one.
  let nx = x, ny = y;
  if (stuck && !agreed) {
    nx = median(pending.map((q) => q[0]));
    ny = median(pending.map((q) => q[1]));
  }

  recent.length = 0; recent.push([nx, ny]);
  pending = [];
  state.fx.reset(nx, t); state.fy.reset(ny, t);
  return { x: nx, y: ny };
}

function confidence() {
  if (recent.length < 3) return 0;
  const mx = median(recent.map((p) => p[0]));
  const my = median(recent.map((p) => p[1]));
  const spread = mean(recent.map((p) => Math.hypot(p[0] - mx, p[1] - my)));
  let c = Math.max(0, Math.min(1, 1 - spread / 150));

  // A tight sample cloud from a head that has moved is confidently wrong.
  // Dispersion alone cannot see that, so fold the head offset in directly.
  const off = state.head;
  if (off) {
    const over = Math.max(0, off.dist - HEAD_SOFT) / (HEAD_HARD - HEAD_SOFT);
    c *= Math.max(0.15, 1 - over);
  }
  if (state.mode === "webgazer" && !head.now) c = 0;   // face lost entirely
  // A steady estimate from a loose calibration is steadily wrong by that much.
  const acc = state.accuracy?.after_px;
  if (state.mode === "webgazer" && acc) c *= Math.max(0.3, Math.min(1, 1 - (acc - 80) / 300));
  return c;
}

// ── Ingest ──────────────────────────────────────────────────────────────────
function ingest(rawX, rawY) {
  // webgazer occasionally emits NaN when the mesh drops out. One of those
  // poisons the One Euro state permanently — every later value becomes NaN.
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return;
  state.lastSampleAt = performance.now();
  const t = performance.now() / 1000;

  // Range correction first: webgazer's ridge fit compresses toward the screen
  // centre, so the corners are literally unreachable without this.
  let x = state.cal.ax * rawX + state.cal.bx;
  let y = state.cal.ay * rawY + state.cal.by;

  // Then undo the error the head has introduced since calibration. The gain is
  // learned, so this is a no-op until there is evidence for it.
  if (state.mode === "webgazer") {
    head.now = readHead() ?? head.now;
    if (state.calibrated && !head.base) head.base = head.now;
    const off = headOffset();
    // Keep the pre-compensation estimate: fitting the gain against an already
    // compensated error would feed the correction back into its own input and
    // let it run away.
    state.uncomp = { x, y };
    if (off && head.gain) {
      x -= head.gain.gx * off.dx;
      y -= head.gain.gy * off.dy;
    }
    state.head = off;
  }

  bus.emit("GAZE_RAW", { x, y });
  const kept = gate(x, y, t);
  if (!kept) return;
  x = state.fx.filter(kept.x, t);
  y = state.fy.filter(kept.y, t);

  // Report where the eyes are resting, not every sample (fixation.js). The
  // mouse is ground truth and needs none of this.
  let fixating = false;
  if (state.mode !== "mouse") {
    const f = fixer.push(x, y, t * 1000);
    x = f.x; y = f.y; fixating = f.fixating;
  }
  state.fixating = fixating;

  x = Math.max(EDGE, Math.min(innerWidth - EDGE, x));
  y = Math.max(EDGE, Math.min(innerHeight - EDGE, y));

  state.point = { x, y };
  state.conf = confidence();
  bus.emit("GAZE", { x, y, confidence: state.conf });
  if (!state.calibrating) {
    attention.update(x, y, attentionSigma(), performance.now(), scan());
    watchTorn();
  }
}

// ── Dwell ───────────────────────────────────────────────────────────────────
// Runs on its own clock, not on sample arrival. A fixation is exactly when
// samples STOP moving, and webgazer drops frames constantly — either would
// stall a timer driven by incoming data.
let dwellTimer = null;
function startDwellLoop() {
  if (dwellTimer) return;
  dwellTimer = setInterval(() => {
    checkQuality();
    if (state.point && !state.qualityLow && !state.calibrating) {
      commitDwell(state.point.x, state.point.y);
    }
  }, 60);
}

export function stop() {
  cancelCalibration?.();
  cancelCalibration = null;
  state.running = false;
  state.calibrating = false;
  state.calibrated = false;
  state.point = null;
  setFocus(null, 0);
  if (dwellTimer) { clearInterval(dwellTimer); dwellTimer = null; }
  try { eyes.end(); } catch {}
  document.querySelectorAll(".aura-cal,.cue-modal").forEach((el) => {
    try { el.hidePopover?.(); } catch {}
    el.remove();
  });
  bus.emit("STATE", { calibrating: false, calibrated: false, listening: false });
}

// Bad tracking is not always noisy. A frozen feed or a face out of frame
// gives a rock-steady, completely wrong estimate — dispersion cannot see that,
// so check freshness and plausibility directly. When it is clearly bad we drop
// focus rather than keep pointing confidently at the wrong thing.
function checkQuality() {
  if (state.mode !== "webgazer" || !state.calibrated || state.calibrating) return;
  const now = performance.now();
  const p = state.point;
  const outside = p && (p.x < -40 || p.y < -40 || p.x > innerWidth + 40 || p.y > innerHeight + 40);
  const stale = !state.lastSampleAt || now - state.lastSampleAt > STALE_SAMPLE_MS;

  // Gate on objective failures only: the feed has stopped, or the estimate is
  // off-screen. NOT on confidence.
  //
  // Confidence is relative to sample spread, and at the 220-350px this
  // hardware actually produces it sits near zero permanently — so a
  // `conf < 0.45` test latched qualityLow a couple of seconds after every
  // calibration, cleared focus, and the dwell loop then refused to commit
  // anything ever again. Cue went silent right after calibrating and looked
  // broken. Low confidence is what the soft outline and drift nudge are for; it
  // is not a reason to stop working.
  const poor = stale || outside;

  if (poor) {
    state.lowSince ||= now;
    if (!state.qualityLow && now - state.lowSince >= LOW_CONFIDENCE_MS) {
      state.qualityLow = true;
      setFocus(null, 0);
      bus.emit("GAZE_QUALITY", { low: true, reason: driftReason() });
    }
  } else {
    state.lowSince = 0;
    if (state.qualityLow) {
      state.qualityLow = false;
      bus.emit("GAZE_QUALITY", { low: false });
    }
  }
}

// A new item takes the highlight only when it clearly holds attention, has held
// it for DWELL_MS, and beats the current one by a margin. Looking at empty
// space keeps the last highlight rather than dropping it: the highlight moves
// when the eyes clearly move, and not otherwise.
const LEAD_SHARE = 0.5;
const LEAD_MARGIN = 1.4;

function commitAttention() {
  if (performance.now() < state.lockUntil) return;
  const lead = attention.leader({ minShare: LEAD_SHARE });
  const now = performance.now();
  const target = lead?.target ?? null;
  if (!target) { state.cand = null; return; }
  if (target.id !== state.cand?.id) { state.cand = target; state.candSince = now; return; }
  if (now - state.candSince < DWELL_MS || target.id === state.focus?.id) return;
  if (state.focus && attention.shareOf(state.focus.id) * LEAD_MARGIN > lead.share) return;
  if (!target.el?.isConnected) return;
  const prev = state.focus;
  state.focus = target;
  bus.emit("FOCUS", { target, prev });
}

function commitDwell(x, y) {
  if (state.mode !== "mouse") return commitAttention();
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
// Training is FIX_POINTS + a smooth pursuit (see runCalibration below).
// Then a short pass where we watch what the model ACTUALLY predicts while the
// user looks at known points it never trained on, and fit a correction. This is what buys back the
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
let cancelCalibration = null;

// Chrome destroys the page's JS world on a full store navigation. Keep the
// fitted model and its samples in extension session storage so the next
// document in this tab can resume without calibrating again. Gaze v2 samples
// are 20 numbers each, not eye-image patches, so this is a few KB.
const SNAPSHOT_VERSION = 2;

export function canResume(snapshot) {
  return snapshot?.version === SNAPSHOT_VERSION &&
    snapshot.viewport?.width === innerWidth && snapshot.viewport?.height === innerHeight &&
    Array.isArray(snapshot.samples) && snapshot.samples.length >= 12 && snapshot.samples.length <= 2000 &&
    snapshot.samples.every((x) => Array.isArray(x?.f) && x.f.every(Number.isFinite) &&
      Number.isFinite(x.x) && Number.isFinite(x.y)) &&
    !!snapshot.model && [snapshot.cal?.ax, snapshot.cal?.bx, snapshot.cal?.ay, snapshot.cal?.by,
      snapshot.accuracy?.after_px].every(Number.isFinite);
}

export function exportCalibration() {
  if (state.mode !== "webgazer" || !state.calibrated || !state.accuracy || !model) return null;
  const round = (v) => Math.round(v * 1e4) / 1e4;
  const snapshot = {
    version: SNAPSHOT_VERSION, viewport: { width: innerWidth, height: innerHeight },
    samples: training.slice(-1500).map((x) => ({ f: x.f.map(round), x: Math.round(x.x), y: Math.round(x.y), g: x.g })),
    model: model.toJSON(), cal: { ...state.cal }, accuracy: { ...state.accuracy },
  };
  return canResume(snapshot) ? snapshot : null;
}

async function restoreCalibration(snapshot) {
  if (!canResume(snapshot)) return false;
  const m = loadGazeModel(snapshot.model);
  if (!m) return false;
  model = m;
  training = snapshot.samples.map((x) => ({ ...x }));
  state.cal = { ...snapshot.cal };
  state.accuracy = { ...snapshot.accuracy };
  state.calibrated = true;
  state.precise = state.accuracy.after_px <= POOR_PX;
  state.qualityLow = false;
  state.lowSince = 0;
  head.base = readHead();
  head.samples = []; head.gain = null;
  retune();
  bus.emit("STATE", { calibrated: true, accuracy: state.accuracy, precise: state.precise });
  return true;
}

function retune() {
  if (!state.tuneLocked && state.accuracy) {
    state.tuning = tuningFor(state.accuracy.after_px);
    state.fx = oneEuro(state.tuning);
    state.fy = oneEuro(state.tuning);
  }
  fixer = fixationFilter({ radius: fixRadiusFor(state.accuracy?.after_px) });
  recent.length = 0; pending = [];
  state.fx.reset(innerWidth / 2, performance.now() / 1000);
  state.fy.reset(innerHeight / 2, performance.now() / 1000);
}

// ── Frames ──────────────────────────────────────────────────────────────────
// Calibration and validation wait for real camera frames, not timer ticks: a
// timer happily re-reads the same frame and inflates the sample count.
let frameWaiters = [];
const nextFrame = (ms = 400) => new Promise((resolve) => {
  const t = setTimeout(() => { frameWaiters = frameWaiters.filter((w) => w !== done); resolve(null); }, ms);
  const done = (sample) => { clearTimeout(t); resolve(sample); };
  frameWaiters.push(done);
});

function onEyes(sample) {
  const waiting = frameWaiters; frameWaiters = [];
  waiting.forEach((w) => w(sample));
  if (sample.head) head.now = { x: sample.head.x, y: sample.head.y, iod: sample.head.iod };
  // A blink is not a stale feed; keep the clock alive but predict nothing.
  if (sample.features) state.lastSampleAt = performance.now();
  if (!sample.ok || !model || state.calibrating) return;
  const p = model.predict(sample.features);
  if (Number.isFinite(p.x) && Number.isFinite(p.y)) ingest(p.x, p.y);
}

// ── Calibration (gaze v2): fixations, then a pursuit, then validation ───────
// Nine fixation points that advance on their own, then one smooth-pursuit
// sweep, then five points the model never trains on. No key presses: someone
// who cannot use a trackpad should not have to press space thirteen times.
const FIX_POINTS = [
  [.08, .10], [.50, .10], [.92, .10],
  [.08, .50], [.50, .50], [.92, .50],
  [.08, .90], [.50, .90], [.92, .90],
];
// SETTLE: the eye is still travelling, discard. HOLD: then collect this long.
// Exported so tests can run a whole calibration in a second.
export const TIMING = { settle: 450, hold: 750, pursuit: 9000, validateSettle: 650, lead: 700 };

// A rounded tour of the screen: along the top, down the right, back along the
// bottom, up the left, then a diagonal through the middle.
function pursuitAt(tMs) {
  const u = Math.max(0, Math.min(1, tMs / TIMING.pursuit));
  const W = innerWidth, H = innerHeight, m = 0.08;
  const pts = [[m, m], [1 - m, m], [1 - m, 1 - m], [m, 1 - m], [m, m], [1 - m, 1 - m]];
  const seg = Math.min(pts.length - 2, Math.floor(u * (pts.length - 1)));
  const k = u * (pts.length - 1) - seg;
  const e = k < .5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;      // ease in and out of corners
  const [ax, ay] = pts[seg], [bx, by] = pts[seg + 1];
  return [(ax + (bx - ax) * e) * W, (ay + (by - ay) * e) * H];
}

async function collectAt(px, py, group, out, cancelled) {
  await sleep(TIMING.settle);
  const until = performance.now() + TIMING.hold;
  let good = 0;
  while ((performance.now() < until || good < 8) && performance.now() < until + 1200) {
    if (cancelled()) return 0;
    const s = await nextFrame();
    if (s?.ok) { out.push({ f: s.features, x: px, y: py, g: group }); good++; }
  }
  return good;
}

function runCalibration(attempt) {
  return new Promise((done, reject) => {
    const cleanup = [];
    const ov = document.createElement("div");
    ov.className = "aura-cal";
    ov.tabIndex = -1;
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-label", "Eye tracking calibration");
    ov.innerHTML = `<div class="aura-cal-hint" role="status" aria-live="polite"></div><button type="button" class="aura-cal-dot" aria-label="Start calibration"></button>`;
    document.body.appendChild(ov);
    ov.focus({ preventScroll: true });
    const dot  = ov.querySelector(".aura-cal-dot");
    const hint = ov.querySelector(".aura-cal-hint");
    let cancelled = false;
    const isCancelled = () => cancelled;

    // Space is push-to-talk everywhere else. Tell voice.js to stand down.
    state.calibrating = true;
    state.calibrated = false;
    state.accuracy = null;
    state.cal = { ax: 1, bx: 0, ay: 1, by: 0 };
    setFocus(null, 0);
    state.qualityLow = false; state.lowSince = 0;
    bus.emit("GAZE_QUALITY", { low: false });
    bus.emit("STATE", { calibrating: true });

    const place = (x, y, instant = false) => {
      dot.classList.toggle("moving", !instant);
      dot.style.left = x + "px"; dot.style.top = y + "px";
      if (hint.dataset) hint.dataset.pos = y > innerHeight * 0.6 ? "top" : "bottom";
    };
    const say = (text) => { hint.textContent = text; };

    const run = async () => {
      const anchors = [];
      for (let k = 0; k < FIX_POINTS.length; k++) {
        const [fx, fy] = FIX_POINTS[k];
        const px = fx * innerWidth, py = fy * innerHeight;
        place(px, py);
        dot.classList.remove("armed");
        say(`Look at the dot · ${k + 1} / ${FIX_POINTS.length}`);
        setTimeout(() => dot.classList.add("armed"), TIMING.settle);
        const got = await collectAt(px, py, `fix${k}`, anchors, isCancelled);
        if (cancelled) return null;
        // Nothing usable at the first two points means the face is not in view.
        // Say so now rather than walking someone through a dead screen.
        if (k >= 1 && anchors.length === 0) break;
        if (got < 4) say("I can't see your eyes. Face the camera, in good light.");
      }
      if (anchors.length < 40) {
        say("I couldn't see your eyes clearly enough. Face the camera in good light, then say “Cue, recalibrate”.");
        return { obs: [], lag: 0, n: 0 };
      }

      // Smooth pursuit: the dot moves; the eye follows it.
      say("Now follow the dot with your eyes");
      dot.classList.remove("armed");
      const [sx, sy] = pursuitAt(0);
      place(sx, sy);
      await sleep(TIMING.lead);
      dot.classList.add("pursuit");
      const pursuit = [];
      const t0 = performance.now();
      let raf = 0;
      const tick = () => {
        const [x, y] = pursuitAt(performance.now() - t0);
        place(x, y, true);
        if (performance.now() - t0 < TIMING.pursuit && !cancelled) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      while (performance.now() - t0 < TIMING.pursuit && !cancelled) {
        const s = await nextFrame();
        if (s?.ok) pursuit.push({ f: s.features, t: s.t - t0 });
      }
      cancelAnimationFrame(raf);
      dot.classList.remove("pursuit");
      if (cancelled) return null;

      say("Working out where you look…");
      await sleep(30);
      const lag = pursuit.length > 60 ? bestPursuitLag(pursuit, pursuitAt, anchors) : 0;
      const pursuitSamples = pursuit
        .filter((p) => p.t - lag > 300 && p.t - lag < TIMING.pursuit)       // skip the start-up
        .map((p, n) => { const [x, y] = pursuitAt(p.t - lag); return { f: p.f, x, y, g: `pur${Math.floor(n / 10)}` }; });
      training = [...anchors, ...pursuitSamples];
      model = fitGazeModel(training);
      console.log(`[cue] gaze model: ${model.kind}, cross-validated ${model.cv_px}px, pursuit lag ${lag}ms,`,
                  `${anchors.length} fixation + ${pursuitSamples.length} pursuit samples`);

      say("Now just look at each dot — checking accuracy");
      const obs = await sweep(dot, null, isCancelled);
      if (cancelled) return null;
      return { obs, lag, n: training.length };
    };

    const finish = (res) => {
      if (!res) return;
      const { obs, lag, n } = res;
      if (obs.length >= 25) {
        const fx = fit1d(obs.map((o) => o[0]), obs.map((o) => o[2]));
        const fy = fit1d(obs.map((o) => o[1]), obs.map((o) => o[3]));
        const before = rms(obs, 1, 0, 1, 0);
        const after  = rms(obs, fx.a, fx.b, fy.a, fy.b);
        // Only keep a range correction that clearly helps: it is fitted on the
        // same five points it is scored on, so a small gain is overfitting.
        if (after < before * 0.85) state.cal = { ax: fx.a, bx: fx.b, ay: fy.a, by: fy.b };
        state.accuracy = {
          before_px: Math.round(before),
          after_px: Math.round(after < before * 0.85 ? after : before),
          gain_x: +fx.a.toFixed(2), gain_y: +fy.a.toFixed(2),
          samples: obs.length, model: model.kind, cv_px: model.cv_px, lag_ms: lag, trained_on: n,
        };
        console.log("[cue] calibration", state.accuracy, state.cal);
      }
      state.calibrated = !!state.accuracy;
      // Whatever pose they calibrated in is the pose the mapping is valid for.
      head.base = readHead();
      head.samples = []; head.gain = null;
      retune();
      // NOTE: calibrating stays true — the wrapper may still put a modal up,
      // and space must not become push-to-talk underneath it.
      bus.emit("STATE", { calibrated: state.calibrated, accuracy: state.accuracy });
      done(state.accuracy);
    };

    let started = false;
    const begin = () => {
      if (started) return;
      started = true;
      removeEventListener("keydown", onKey, true);
      dot.disabled = true;
      run().then(finish, reject).finally(() => {
        cleanup.forEach((fn) => fn());
        if (cancelCalibration === cancel) cancelCalibration = null;
        ov.remove();
      });
    };
    const onKey = (e) => {
      if ((e.code !== "Space" && e.key !== " ") || e.repeat) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      begin();
    };
    const cancel = () => {
      cancelled = true;
      removeEventListener("keydown", onKey, true);
      cleanup.forEach((fn) => fn());
      ov.remove();
      state.calibrating = false;
      if (cancelCalibration === cancel) cancelCalibration = null;
      done(false);
    };
    cancelCalibration = cancel;

    // One gesture starts it: space, a tap, or "Cue, ready". Everything after
    // that is hands-free. aura.js declines to send utterances to the server
    // while calibrating, so this is the only consumer.
    const stopVoice = bus.on("UTTERANCE", ({ text, final }) => {
      if (final && /^(next|ready|start|begin|go|ok|okay|done)\b/i.test(text.trim())) begin();
    });
    cleanup.push(stopVoice);
    dot.addEventListener("click", begin);
    cleanup.push(() => dot.removeEventListener("click", begin));
    addEventListener("keydown", onKey, true);

    place(innerWidth / 2, innerHeight / 2, true);
    const again = attempt > 1 ? " · attempt " + attempt : "";
    say(`Keep your head still and follow the dot with your eyes. Press SPACE, tap the dot, or say “Cue, ready”${again}`);
    if (attempt === 1) bus.emit("SAY", { text: "Keep your head still and follow the dot with your eyes. Say ready when you're set." });
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
      <div class="cue-modal-card" data-poor="${poor}" style="--err:${Number(acc.after_px) || 200}">
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
    // #aura-root is an open popover living in the browser's top layer, so
    // anything in normal flow paints beneath it. Join the top layer or these
    // buttons can be covered and unreachable.
    try { ov.popover = "manual"; ov.showPopover(); } catch {}

    // On a product built for people who cannot use a trackpad, a modal with
    // only click targets is the wrong shape. aura.js drops utterances while
    // calibrating, so subscribe directly — exactly as the dots do for "next".
    let stopVoice = null;
    const pick = (act) => {
      stopVoice?.();
      try { ov.hidePopover(); } catch {}
      ov.remove();
      if (cancelCalibration === cancel) cancelCalibration = null;
      choose(act);
    };
    const cancel = () => pick("exit");
    cancelCalibration = cancel;
    ov.addEventListener("click", (e) => {
      const b = e.target.closest("[data-act]");
      if (b) pick(b.dataset.act);
    });
    stopVoice = bus.on("UTTERANCE", ({ text, final }) => {
      if (!final) return;
      const t = text.trim().toLowerCase();
      if (/\b(continue|carry on|keep going|proceed|skip|good enough|leave it|fine)\b/.test(t)) pick("continue");
      else if (/\b(again|retry|redo|recalibrat)\b/.test(t)) pick("recal");
    });
    // Keyboard reachable — this is an accessibility tool.
    ov.querySelector(".cue-btn-primary").focus();
    ov.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { e.preventDefault(); pick("continue"); }
    });

    bus.emit("SAY", {
      text: poor
        ? "I can't see where you're looking well enough. Say try again, or say continue anyway."
        : "That's a bit loose. Say try again, or say continue anyway.",
    });
  });
}

// Walk the validation points and collect (predicted, actual) pairs. Used both
// at the end of calibration and, on its own, to answer "is it any better now?"
// with a number instead of a feeling.
async function sweep(dot, hint, cancelled = () => false) {
  const obs = [];
  let nulls = 0, errors = 0, noFace = 0;
  for (let k = 0; k < VALIDATE.length; k++) {
    if (cancelled()) break;
    const [fx, fy] = VALIDATE[k];
    const px = fx * innerWidth, py = fy * innerHeight;
    dot.classList.add("moving");
    dot.style.left = px + "px"; dot.style.top = py + "px";
    dot.classList.remove("armed");
    await sleep(TIMING.validateSettle);     // let the eye land
    dot.classList.add("armed");
    // Keep sampling until we have enough GOOD ones, not just enough attempts.
    let good = 0;
    for (let n = 0; n < 45 && good < 14; n++) {
      try {
        const s = await nextFrame();
        if (s?.ok && model) {
          const p = model.predict(s.features);
          if (Number.isFinite(p.x) && Number.isFinite(p.y)) { obs.push([p.x, p.y, px, py]); good++; }
          else nulls++;
        } else {
          nulls++;
          if (!s?.features) noFace++;
        }
      } catch { errors++; }
    }
    if (hint) hint.textContent = `Just look at each dot — ${k + 1} / ${VALIDATE.length}`;
  }
  obs.stats = { nulls, errors, noFace };
  return obs;
}

/**
 * Re-measure accuracy WITHOUT retraining or changing the correction.
 *
 * This is how you find out whether learning from spoken selections is actually
 * working: measure, use Cue for a couple of minutes, measure again. Nothing is
 * mutated, so the comparison is honest.
 *
 *   await cue.gaze.measure()
 */
export async function measure() {
  if (state.mode !== "webgazer" || !eyes.isRunning() || !model) {
    console.warn("[cue] measure() needs the camera and a calibration");
    return null;
  }
  const ov = document.createElement("div");
  ov.className = "aura-cal";
  ov.innerHTML = `<div class="aura-cal-hint">Just look at each dot — measuring, not changing anything</div><div class="aura-cal-dot"></div>`;
  document.body.appendChild(ov);
  bus.emit("STATE", { calibrating: true });
  try {
    const obs = await sweep(ov.querySelector(".aura-cal-dot"), ov.querySelector(".aura-cal-hint"));
    if (obs.length < 25) {
      const st = obs.stats || {};
      const why = st.noFace > st.nulls / 2
        ? "your face wasn't detected — check lighting and that you're in frame"
        : st.errors
          ? "the face tracker threw on most frames — is the camera still live?"
          : "the tracker returned no prediction for most frames";
      console.warn(`[cue] measure failed: only ${obs.length} good samples. ${why}`, st);
      bus.emit("SAY", { text: "I couldn't measure — I lost track of your face." });
      return null;
    }
    // Score against the correction currently in force — that is what the user
    // actually experiences, not what a fresh fit could achieve.
    const { ax, bx, ay, by } = state.cal;
    const out = {
      error_px: Math.round(rms(obs, ax, bx, ay, by)),
      raw_px: Math.round(rms(obs, 1, 0, 1, 0)),
      samples: obs.length,
      learned_from: learned,
    };
    console.log("[cue] measured", out);
    return out;
  } finally {
    ov.remove();
    bus.emit("STATE", { calibrating: false });
  }
}

/**
 * Does learning from spoken selections actually reduce error? Run the whole
 * experiment hands-free:
 *
 *   cue.experiment()
 *
 * Measures now, waits while you use Cue normally, measures again when enough
 * spoken selections have landed, and prints the comparison. Nothing is
 * retrained by the measurements themselves, so the before/after is honest.
 */
export async function experiment({ selections = 8 } = {}) {
  if (state.mode !== "webgazer") {
    console.warn("[cue] experiment() needs the camera (drop ?gaze=sim)");
    return null;
  }
  bus.emit("SAY", { text: "Measuring where we are now. Just look at each dot." });
  const before = await measure();
  if (!before) return null;

  const start = learned;
  const need = start + selections;
  console.log(`%c[cue] baseline ${before.error_px}px. Now use Cue normally — ` +
              `say the number on things to pick them. ${selections} selections to go.`,
              "font-weight:bold");
  bus.emit("SAY", {
    text: `Right now I'm off by about ${before.error_px} pixels. Use me normally for a minute — ` +
          `say the number on things to pick them. I'll measure again when I've learned enough.`,
  });

  await new Promise((done) => {
    let last = start;
    const t = setInterval(() => {
      if (learned !== last) {
        last = learned;
        const left = Math.max(0, need - learned);
        console.log(`[cue] learned from ${learned - start}/${selections} selections` +
                    (left ? ` — ${left} to go` : ""));
      }
      if (learned >= need) { clearInterval(t); done(); }
    }, 400);
  });

  bus.emit("SAY", { text: "That's enough. Measuring again — look at each dot." });
  const after = await measure();
  if (!after) return null;

  const delta = before.error_px - after.error_px;
  const pct = Math.round((delta / before.error_px) * 100);
  const verdict = delta > 15 ? `BETTER by ${delta}px (${pct}%)`
                : delta < -15 ? `WORSE by ${-delta}px`
                : "no meaningful change";
  const result = { before_px: before.error_px, after_px: after.error_px,
                   selections_learned_from: learned - start, verdict };
  console.log("%c[cue] experiment:", "font-weight:bold", result);
  bus.emit("SAY", {
    text: delta > 15
      ? `I improved from ${before.error_px} to ${after.error_px} pixels.`
      : delta < -15
        ? `I got worse, ${before.error_px} to ${after.error_px} pixels.`
        : `About the same, ${after.error_px} pixels.`,
  });
  return result;
}

let calibration = null;
export function calibrate(options = {}) {
  if (calibration) return calibration;
  if (state.mode !== "webgazer" || !state.running) return Promise.resolve(false);
  // Register the shared promise before mounting the overlay or emitting events.
  // Two overlays compete for Space: the hidden one consumes the visible one's key.
  calibration = Promise.resolve().then(() => calibrateOnce(options)).finally(() => {
    calibration = null;
    state.calibrating = false;
    bus.emit("STATE", { calibrating: false });
  });
  return calibration;
}

async function calibrateOnce({ allowRetry = true, maxAttempts = 2 } = {}) {
  eyes.showPreview(true);
  for (let attempt = 1; ; attempt++) {
    const acc = await runCalibration(attempt);

    const bad = acc && acc.after_px > GOOD_PX;
    if (allowRetry && bad && attempt < maxAttempts) {
      if (await qualityModal(acc, attempt) === "recal") continue;
    }

    state.calibrating = false;
    state.lastSampleAt = performance.now();
    bus.emit("STATE", { calibrating: false, accuracy: acc });
    const q = acc?.after_px;
    bus.emit("SAY", {
      text: !acc
        ? "I couldn't measure your gaze. Check the camera and say Cue, recalibrate. You can select items by saying their numbers."
        : q <= GOOD_PX
        ? "Calibration done. What are you after?"
        : "Alright. I'll number the items — just say the number of the one you want.",
    });
    // Tell the rest of the app whether gaze is precise enough to be trusted as
    // a pointer. Below this bar, what the shopper says leads the interaction.
    state.precise = !!acc && q <= POOR_PX;
    bus.emit("STATE", { precise: state.precise });
    state.qualityLow = !acc;
    bus.emit("GAZE_QUALITY", { low: !acc, reason: "signal" });
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

let debugOn = false;
export async function start({ mode = "webgazer", sigma = 70, tune = null,
  keepData = false, resume = null, debug = false } = {}) {
  debugOn = debug || (typeof location !== "undefined" && new URLSearchParams(location.search).get("gazedebug") === "1");
  state.mode = mode;
  state.running = false;
  state.calibrated = false;
  state.gazeError = null;
  state.point = null;
  setFocus(null, 0);
  const tuning = tune ?? (mode === "mouse"
    ? MOUSE_TUNING
    : { minCutoff: MIN_CUTOFF, beta: BETA, dCutoff: D_CUTOFF });
  state.tuning = tuning;
  state.tuneLocked = !!tune;        // an explicit ?mc= override wins over auto-tuning
  state.fx = oneEuro(tuning);
  state.fy = oneEuro(tuning);

  if (mode === "mouse") {                     // dev + demo fallback, no camera
    startMouseInput();
    startDwellLoop();
    state.calibrated = true; state.running = true;
    bus.emit("STATE", { calibrated: true, mode: "mouse" });
    return "mouse";
  }

  // ?gaze=sim — mouse as ground truth with synthetic webgazer noise on top,
  // run through the real filter chain. This is how you feel what the gaze
  // experience is actually like, and tune it, without a camera or a face.
  state.sigma = sigma;
  if (mode === "sim") {
    // Size the filters for the noise being simulated, exactly as a real
    // calibration sizes them for the error it measured.
    if (!tune) { state.tuning = tuningFor(sigma, TUNINGS); state.fx = oneEuro(state.tuning); state.fy = oneEuro(state.tuning); }
    fixer = fixationFilter({ radius: fixRadiusFor(sigma * 1.1) });
    let tx = innerWidth / 2, ty = innerHeight / 2;
    addEventListener("mousemove", (e) => { touchPointer(); tx = e.clientX; ty = e.clientY; });
    setInterval(() => {
      // A brushed trackpad should not leave the cursor steering Cue for the
      // rest of the demo. Once the pointer has been still a while, stop
      // feeding it — the last position freezes instead of holding focus.
      if (pointerStale()) return;
      ingest(tx + gauss() * sigma, ty + gauss() * sigma);
    }, 40);
    startDwellLoop();
    state.calibrated = true; state.running = true;
    bus.emit("STATE", { calibrated: true, mode: "sim" });
    return "sim";
  }
  if (!navigator.mediaDevices?.getUserMedia) return degrade("this page cannot use the camera", sigma);
  let startTimer = 0;

  // Models are ours and local (vendor/), so a saturated venue network or a
  // store's CSP cannot take eye tracking away. The GPU is used when it can be;
  // otherwise the tracker falls back to the CPU rather than failing.
  const began = await Promise.race([
    eyes.begin(MEDIAPIPE).then(() => true).catch((e) => {
      console.warn("[cue] face tracker could not start", e);
      return e?.name === "NotAllowedError" ? "denied" : false;
    }),
    new Promise((r) => { startTimer = setTimeout(() => r("timeout"), 20000); }),
  ]);
  clearTimeout(startTimer);
  if (began !== true) {
    return degrade(began === "timeout" ? "the camera did not start within 20 seconds"
      : began === "denied" ? "camera permission was refused"
      : "the face tracker could not start the camera", sigma);
  }
  if (!keepData) { model = null; training = []; }
  eyes.setListener(onEyes);
  eyes.showPreview(true);
  startDwellLoop();
  guardStrayClicks();
  state.running = true;
  const restored = await restoreCalibration(resume);
  if (debugOn) import("./gaze-debug.js").then((m) => m.mount({ eyes, getState, getAttention })).catch(() => {});
  bus.emit("STATE", { mode: "webgazer", calibrated: restored });
  return "webgazer";
}

// Never leave a blank page. If the camera cannot work, say why out loud and
// fall through to the mouse so the demo still runs.
function degrade(why, sigma) {
  console.error("[cue] gaze unavailable:", why, "— falling back to the mouse");
  state.mode = "mouse";
  state.gazeError = why;
  state.fx = oneEuro(MOUSE_TUNING);
  state.fy = oneEuro(MOUSE_TUNING);
  startMouseInput();
  startDwellLoop();
  state.calibrated = true; state.running = true;
  bus.emit("STATE", { calibrated: true, mode: "mouse", gazeError: why });
  return "mouse";
}

let mouseInputBound = false;
function startMouseInput() {
  if (mouseInputBound) return;
  mouseInputBound = true;
  addEventListener("mousemove", (e) => {
    if (state.mode !== "mouse") return;
    touchPointer();
    ingest(e.clientX, e.clientY);
  });
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
  if (state.mode !== "webgazer" || !state.calibrated || !target?.el || !model) return false;
  const r = target.el.getBoundingClientRect();
  if (!r.width) return false;
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;

  // Only learn when the eyes were plausibly already there. If someone names an
  // item while looking out the window, that pair is a lie and would undo the
  // work the calibration just did.
  const p = state.point;
  if (!p || Math.hypot(p.x - cx, p.y - cy) > LEARN_MAX_PX) return false;
  const s = eyes.latest();
  if (!s?.ok || performance.now() - s.t > 300) return false;

  // A confirmed selection is one correct pair against hundreds from
  // calibration, so it is weighted up (repeated) to matter.
  for (let k = 0; k < 6; k++) training.push({ f: s.features, x: cx, y: cy, g: `learn${learned}` });
  learned++;
  scheduleRefit();

  // The same pair tells us how much of the error the head accounts for.
  const off = headOffset();
  const est = state.uncomp ?? p;
  if (off) {
    head.samples.push({ dx: off.dx, dy: off.dy, ex: est.x - cx, ey: est.y - cy });
    if (head.samples.length > 40) head.samples.shift();
    const g = fitHeadGain();
    if (g) head.gain = g;
  }
  if (learned % 5 === 0) console.log(`[cue] learned from ${learned} spoken selections`);
  return true;
}

// Refit a moment after the last confirmed selection, off the critical path,
// and only keep the new model if it does not cross-validate worse.
let refitTimer = 0;
function scheduleRefit() {
  clearTimeout(refitTimer);
  refitTimer = setTimeout(() => {
    try {
      const next = fitGazeModel(training.slice(-1500));
      if (!model || next.cv_px <= model.cv_px * 1.1) {
        console.log(`[cue] gaze model refit: ${model?.cv_px ?? "?"}px -> ${next.cv_px}px (${next.kind})`);
        model = next;
      }
    } catch (e) { console.warn("[cue] refit skipped", e); }
  }, 1500);
}

export const getLearned = () => learned;
export const getHead = () => ({
  tracked: !!head.now, offset: state.head ?? null,
  gain: head.gain, samples: head.samples.length,
});

/** Why is tracking poor right now? Used for a message worth acting on. */
export function driftReason() {
  if (state.mode !== "webgazer") return null;
  if (!head.now) return "face";
  const off = state.head;
  if (off && off.dist > HEAD_HARD) return "head";
  if (off && off.dz < -0.25) return "far";
  if (off && off.dz > 0.30) return "close";
  return "signal";
}

// ── Speech and gaze together ────────────────────────────────────────────────
// People look at a thing, then refer to it, and by the end of the sentence the
// eyes have often moved on. So remember what was being looked at over the last
// few seconds, and when speech starts, pin whatever was under the eyes just
// before it (docs/GAZE.md).
const SPEECH_LOOKBACK_MS = 250;
const focusHistory = [];         // [{ t, target }] oldest first

function noteFocus(target) {
  const t = performance.now();
  focusHistory.push({ t, target });
  while (focusHistory.length && t - focusHistory[0].t > 4000) focusHistory.shift();
}

function focusAt(t) {
  let hit = null;
  for (const h of focusHistory) { if (h.t <= t) hit = h.target; else break; }
  return hit;
}

let lastSpeechAt = 0;
const offered = new Map();      // pair key -> when we last offered
function watchTorn() {
  const now = performance.now();
  if (now - lastSpeechAt < 8000 || state.calibrating) return;
  const pair = attention.torn();
  if (!pair) return;
  const key = pair.map((it) => it.id).sort().join("|");
  if (now - (offered.get(key) ?? -Infinity) < 60000) return;
  offered.set(key, now);
  bus.emit("ATTENTION", { kind: "torn", items: pair.map((it) => ({ id: it.id, title: it.title })) });
}
function onSpeechStart() {
  if (state.mode === "mouse" || !state.calibrated || state.calibrating) return;
  if (performance.now() < state.lockUntil) return;          // voice already chose
  // What held attention just before they started speaking. A clear leader is
  // pinned; a split is left for the agent, which sees both and can ask.
  const then = attention.at(performance.now() - SPEECH_LOOKBACK_MS) ?? [];
  const lead = then[0]?.share >= 0.55 ? then[0].target : focusAt(performance.now() - SPEECH_LOOKBACK_MS);
  state.onsetAttention = then.slice(0, 3).map(({ id, share, target }) =>
    ({ id, share: Math.round(share * 100) / 100, title: target?.product?.title ?? target?.label ?? id }));
  if (lead?.el?.isConnected && lead.id !== state.focus?.id) setFocus(lead, 6000);
  else holdFocus(6000);
}
bus.on("STATE", (s) => { if (s?.ptt === true) onSpeechStart(); });
bus.on("UTTERANCE", ({ final }) => {
  const now = performance.now();
  if (!final && now - lastSpeechAt > 1500) onSpeechStart();
  lastSpeechAt = now;
});
bus.on("FOCUS", ({ target }) => noteFocus(target));

// Voice-driven selection ("the second one"). Locks out dwell briefly so the
// follow-up command acts on what was just named.
/** Keep a voice-chosen focus alive while the conversation about it continues. */
export function holdFocus(ms = 6000) {
  if (!state.focus) return false;
  state.lockUntil = Math.max(state.lockUntil, performance.now() + ms);
  return true;
}

export const isFocusLocked = () => performance.now() < state.lockUntil;

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

export function hideCamera() { if (!debugOn) eyes.showPreview(false); }
export const getFocus = () => state.focus;
export const getAccuracy = () => state.accuracy;
export const isPrecise  = () => state.precise;
export const getState = () => ({ ...state, fx: undefined, fy: undefined,
  model: model ? { kind: model.kind, cv_px: model.cv_px, samples: training.length } : null });
export const getEngine = () => eyes.stats();

/**
 * Attention for the agent: what holds the eyes now, the last few seconds,
 * this visit, and at the moment the current utterance began. Titles and
 * shares only; nothing about pixels or the camera.
 */
export function getAttention() {
  if (state.mode === "mouse" && !state.point) return null;
  return { ...attention.snapshot(), at_speech: state.onsetAttention ?? null,
    precision_px: Math.round(attentionSigma()) };
}
