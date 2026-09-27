// A lean WebGazer engine for gaze.js's setEngine() seam (see client/eyes.js
// for the shape this matches: begin, end, setListener, latest, isRunning,
// stats, showPreview). Used only on a real site (CONFIG.injected).
//
// This runs directly in the content script, inside the real tab — a normal
// getUserMedia permission prompt appears there, tied to that site's own
// origin, same as any other camera-using extension feature. That is
// precisely what MediaPipe running in an offscreen document could never do:
// an offscreen document has no window for Chrome to attach a prompt to, so
// it fails with NotAllowedError every time, unconditionally — confirmed live
// on Amazon. WebGazer doesn't insert its own script tags at runtime the way
// MediaPipe's WASM loader does, so it also never hits the page-world /
// isolated-world split documented in docs/GAZE.md.
//
// Gaze is decorative now (client/aura.js's gazeFocusForDecisions()) — the
// camera and a moving dot need to be real, the tracking behind it does not
// need to be accurate. WebGazer resolves a screen position directly (an
// image patch through ridge regression), unlike gaze-v2's own engine, which
// separates feature extraction from a per-user model. So the sample this
// reports carries {x, y} already resolved, not {features} — gaze.js's
// onEyes() branches on that shape and skips the model-predict step entirely.
const state = { running: false, latest: null, listener: null };

function onGaze(data, ts) {
  if (!data) return;
  const sample = { ok: true, reason: null, x: data.x, y: data.y, t: ts };
  state.latest = sample;
  try { state.listener?.(sample); } catch (e) { console.error("[cue] gaze listener", e); }
}

export async function begin() {
  if (state.running) return true;
  const wg = window.webgazer;
  if (!wg) throw new Error("webgazer did not load");
  // Split from the cosmetic chain below on purpose (commit 0ad25e9, this
  // project's first working WebGazer integration, proven from day one):
  // regression, tracker and the gaze listener are what actually gets the
  // camera running, chained into begin() itself. The .show*() calls one
  // chained call earlier here threw and took the whole thing down with it —
  // "version drift in the show* chain is not fatal" was the exact lesson,
  // and it wasn't being honored.
  await wg.setRegression("ridge").setTracker("TFFacemesh")
    .setGazeListener(onGaze).saveDataAcrossSessions(false).begin();
  try {
    // Our own reticle is the visible indicator; WebGazer's built-ins would
    // draw a second, uncoordinated one on top of it, and a live face-cam
    // feed is off everywhere in this app (client/eyes.js matches).
    wg.showVideoPreview(false).showPredictionPoints(false)
      .showFaceOverlay(false).showFaceFeedbackBox(false)
      .applyKalmanFilter(true);
  } catch { /* cosmetic only; the camera is already running without it */ }
  state.running = true;
  return true;
}

export function end() {
  state.running = false;
  try { window.webgazer?.end(); } catch {}
}

export const setListener = (fn) => { state.listener = fn; };
export const latest = () => state.latest;
export const isRunning = () => state.running;
export const stats = () => ({ delegate: "webgazer" });
// Its own preview is already off above; nothing to toggle here.
export function showPreview() {}

// WebGazer's own training primitive: pair the eye image at this instant with
// a screen position. gaze.js's fixation sweep (runCalibration) cannot be
// reused here — it fits a per-user model from sample.features, which this
// engine's samples do not carry (see the top of this file). Its presence is
// also how gaze.js knows which calibration path to run at all
// (runWebgazerCalibration), rather than a second CONFIG.injected check
// living in two files.
//
// Verified, not assumed — adapted from commit 86286b5, the last gaze.js
// before the MediaPipe rewrite, still the proven reference for this engine.
// recordScreenPosition silently no-ops when eye features are not ready yet
// (face briefly out of frame, a blink), so a calibration that never checks
// whether anything was actually recorded can walk through all 13 points,
// report success, and have trained on nothing. Diff the regression's own
// data before and after the call and return whether it actually grew.
export function recordScreenPosition(x, y) {
  const wg = window.webgazer;
  if (!wg) return false;
  try {
    const regression = wg.getRegression()[0];
    const before = regression.getData().slice();
    wg.recordScreenPosition(x, y, "click");
    return regression.getData().some((pair, i) => pair !== before[i]);
  } catch {
    return false;
  }
}
