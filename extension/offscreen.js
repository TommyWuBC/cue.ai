// Runs the camera and MediaPipe for gaze v2 on a real site. See
// extension/offscreen.html for why this page exists at all, and
// client/eyes-bridge.js for the content-script side of this split — that
// module has the same exported shape as client/eyes.js, so client/gaze.js
// never knows the difference (see gaze.js's setEngine seam).
//
// Nothing here computes screen coordinates: this page only extracts features
// (eye vectors, blendshapes, head pose) from camera frames and hands them
// across. The per-user model that turns features into a screen position
// stays in the content script, in the page's own coordinate frame, same as
// it always has — moving that here would put gaze predictions in the wrong
// frame the moment the page scrolled or resized.
import * as eyes from "../client/eyes.js";

const VENDOR = chrome.runtime.getURL("vendor/");
const MEDIAPIPE = {
  bundle: VENDOR + "mediapipe/vision_bundle.mjs",
  wasmLoader: VENDOR + "mediapipe/wasm/vision_wasm_internal.js",
  wasmBinary: VENDOR + "mediapipe/wasm/vision_wasm_internal.wasm",
  model: VENDOR + "models/face_landmarker.task",
};

// Strip what nothing on the other side reads. `landmarks` (478 points) exists
// for the camera preview overlay, which is disabled; sending it every frame
// would be pure waste over the message channel. `stats()` rides along on each
// message since it lives in this page's eyes.js state, and the debug panel on
// the other side needs it to show fps/latency/delegate.
function slim(sample) {
  const { ok, reason, features, head, t } = sample;
  return { ok, reason, features, head, t };
}

eyes.setListener((sample) => {
  chrome.runtime.sendMessage({
    type: "cue:gaze:sample", sample: slim(sample), stats: eyes.stats(),
  }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  if (message?.type === "cue:gaze:begin") {
    eyes.begin(MEDIAPIPE).then(() => respond({ ok: true }))
      .catch((e) => respond({ ok: false, error: String(e?.name || e?.message || e) }));
    return true;
  }
  if (message?.type === "cue:gaze:end") {
    try { eyes.end(); } catch {}
    respond({ ok: true });
  }
});
