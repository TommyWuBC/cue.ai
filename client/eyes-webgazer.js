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
  await wg.setRegression("ridge").setGazeListener(onGaze)
    .saveDataAcrossSessions(false)
    // Our own reticle is the visible indicator; WebGazer's built-ins would
    // draw a second, uncoordinated one on top of it.
    .showVideoPreview(false).showPredictionPoints(false)
    .showFaceOverlay(false).showFaceFeedbackBox(false)
    .begin();
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
