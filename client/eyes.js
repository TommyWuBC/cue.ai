// The eye engine: camera -> MediaPipe Face Landmarker -> gaze features.
//
// Replaces WebGazer's TF.js face mesh and pixel-patch ridge. It only produces
// features and head pose; the mapping to screen coordinates (the per-user
// model) lives in gaze.js, which keeps it in the page's coordinate frame.
//
// One inference per real camera frame (requestVideoFrameCallback), on the GPU
// when available. Nothing is stacked on top (WebGazer ran a Kalman filter
// before ours ran a One Euro), so the only smoothing is the one we control.
import { extract } from "./gaze-features.js";

const state = {
  running: false, video: null, stream: null, landmarker: null,
  latest: null, listener: null, preview: null, previewOn: false,
  fps: 0, inferMs: 0, latencyMs: 0, frames: 0, lastFpsAt: 0, lastTs: -1,
  delegate: null,
};

async function createLandmarker(paths) {
  const { FaceLandmarker } = await import(paths.bundle);
  const fileset = { wasmLoaderPath: paths.wasmLoader, wasmBinaryPath: paths.wasmBinary };
  const opts = (delegate) => ({
    baseOptions: { modelAssetPath: paths.model, delegate },
    runningMode: "VIDEO", numFaces: 1,
    outputFaceBlendshapes: true, outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5, minFacePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  try {
    state.delegate = "GPU";
    return await FaceLandmarker.createFromOptions(fileset, opts("GPU"));
  } catch (e) {
    console.warn("[cue] GPU face tracking unavailable, using CPU:", e?.message ?? e);
    state.delegate = "CPU";
    return await FaceLandmarker.createFromOptions(fileset, opts("CPU"));
  }
}

function onFrame(now, meta) {
  if (!state.running) return;
  const v = state.video;
  const ts = Math.max(state.lastTs + 1, Math.round(meta?.mediaTime ? meta.mediaTime * 1000 : now));
  state.lastTs = ts;
  const t0 = performance.now();
  let result = null;
  try { result = state.landmarker.detectForVideo(v, ts); } catch (e) { console.warn("[cue] face tracking frame failed", e); }
  const t1 = performance.now();
  state.inferMs += ((t1 - t0) - state.inferMs) * 0.1;
  // captureTime is when the sensor took the frame; this is the honest latency.
  if (meta?.captureTime) state.latencyMs += ((t1 - meta.captureTime) - state.latencyMs) * 0.1;

  const aspect = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 4 / 3;
  const sample = { ...extract(result, aspect), t: t1, landmarks: result?.faceLandmarks?.[0] ?? null };
  state.latest = sample;
  state.frames++;
  if (t1 - state.lastFpsAt > 1000) {
    state.fps = Math.round(state.frames * 1000 / (t1 - state.lastFpsAt));
    state.frames = 0; state.lastFpsAt = t1;
  }
  try { state.listener?.(sample); } catch (e) { console.error("[cue] gaze listener", e); }
  if (state.previewOn) drawPreview(sample);
  v.requestVideoFrameCallback(onFrame);
}

/**
 * Start the camera and the face tracker.
 *   paths: { bundle, wasmLoader, wasmBinary, model }
 */
export async function begin(paths) {
  if (state.running) return true;
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 30 }, facingMode: "user" },
    audio: false,
  });
  const v = document.createElement("video");
  v.playsInline = true; v.muted = true; v.autoplay = true;
  v.srcObject = state.stream;
  await v.play();
  state.video = v;
  state.landmarker = await createLandmarker(paths);
  state.running = true;
  state.lastFpsAt = performance.now();
  v.requestVideoFrameCallback(onFrame);
  return true;
}

export function end() {
  state.running = false;
  try { state.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { state.landmarker?.close(); } catch {}
  state.preview?.remove();
  Object.assign(state, { stream: null, video: null, landmarker: null, latest: null, preview: null, previewOn: false });
}

export const setListener = (fn) => { state.listener = fn; };
export const latest = () => state.latest;
export const isRunning = () => state.running;
export const stats = () => ({
  fps: state.fps, infer_ms: +state.inferMs.toFixed(1), latency_ms: Math.round(state.latencyMs),
  delegate: state.delegate, face: !!state.latest?.features, blink: state.latest?.reason === "blink",
});

// ── Preview: the camera with the eye landmarks drawn on it ──────────────────
// Shown during calibration so people can see they are in frame, and always in
// ?gazedebug=1.
const EYE_RINGS = [
  [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246],
  [362, 382, 381, 380, 374, 373, 390, 249, 263, 466, 388, 387, 386, 385, 384, 398],
];

// Off for this branch: a live mirrored feed of the shopper's own face,
// pinned to the corner of every page, is not something to show by default —
// calibration and ?gazedebug=1 both ask for it, and neither gets it now.
// Single chokepoint, so every caller is covered without hunting each one down.
const PREVIEW_ENABLED = false;

export function showPreview(on) {
  state.previewOn = !!on && PREVIEW_ENABLED;
  if (!state.previewOn) { state.preview?.remove(); state.preview = null; return; }
  if (state.preview) return;
  const c = document.createElement("canvas");
  c.className = "cue-cam";
  c.width = 240; c.height = 180;
  document.body.appendChild(c);
  state.preview = c;
}

function drawPreview(sample) {
  const c = state.preview, v = state.video;
  if (!c || !v) return;
  const g = c.getContext("2d");
  g.save();
  g.translate(c.width, 0); g.scale(-1, 1);            // mirror, like a selfie
  g.drawImage(v, 0, 0, c.width, c.height);
  const lm = sample.landmarks;
  if (lm) {
    g.lineWidth = 1.2;
    g.strokeStyle = sample.ok ? "rgba(244,243,239,.9)" : "rgba(255,159,10,.9)";
    for (const ring of EYE_RINGS) {
      g.beginPath();
      ring.forEach((i, k) => {
        const x = lm[i].x * c.width, y = lm[i].y * c.height;
        k ? g.lineTo(x, y) : g.moveTo(x, y);
      });
      g.closePath(); g.stroke();
    }
    g.fillStyle = "#2f6bff";
    for (const i of [468, 473]) {
      g.beginPath(); g.arc(lm[i].x * c.width, lm[i].y * c.height, 2.6, 0, Math.PI * 2); g.fill();
    }
  }
  g.restore();
  if (!lm) {
    g.fillStyle = "rgba(0,0,0,.55)"; g.fillRect(0, c.height - 26, c.width, 26);
    g.fillStyle = "#fff"; g.font = "12px -apple-system, sans-serif";
    g.fillText("Can't see your face", 10, c.height - 9);
  }
}
