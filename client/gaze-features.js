// Turn one Face Landmarker result into the numbers a gaze model can learn from.
//
// Pure functions, no DOM: tests import this directly.
//
// The iris is measured inside each eye's own frame (origin between the eye
// corners, x along the corners, unit = eye width), so rolling the head or
// leaning towards the camera does not change it. Vertical gaze is the hard axis
// on a webcam, so it gets three independent signals: the iris offset, how open
// the lids are (they follow the eyes down), and MediaPipe's look-up/look-down
// blendshapes. Head pose goes in as its own features, so the regression learns
// how moving your head shifts the mapping instead of silently breaking.

// Face Landmarker indices (478-point mesh with irises). "a" is the corner on
// the image's left, "b" on its right, so both eyes share one x direction.
export const EYES = {
  right: { a: 33, b: 133, up: 159, down: 145, iris: 468 },   // the subject's right eye
  left:  { a: 362, b: 263, up: 386, down: 374, iris: 473 },  // the subject's left eye
};

const BLENDS = [
  "eyeLookInLeft", "eyeLookOutLeft", "eyeLookUpLeft", "eyeLookDownLeft",
  "eyeLookInRight", "eyeLookOutRight", "eyeLookUpRight", "eyeLookDownRight",
];

export const FEATURE_NAMES = [
  "uR", "vR", "uL", "vL", "apR", "apL",
  ...BLENDS,
  "yaw", "pitch", "roll", "tx", "ty", "tz",
];

const BLINK = 0.5;          // eyeBlink blendshape above this: the eye is closing
const MIN_APERTURE = 0.08;  // lid gap / eye width below this: too closed to read

/** Iris position and lid aperture for one eye, in that eye's own frame. */
export function eyeFrame(lm, eye, aspect = 1) {
  const p = (i) => ({ x: lm[i].x * aspect, y: lm[i].y });
  const a = p(eye.a), b = p(eye.b), iris = p(eye.iris), up = p(eye.up), down = p(eye.down);
  const ex = b.x - a.x, ey = b.y - a.y;
  const w = Math.hypot(ex, ey);
  if (!(w > 1e-6)) return null;
  const ux = ex / w, uy = ey / w;        // along the eye
  const vx = -uy, vy = ux;               // perpendicular, pointing down the image
  const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  const dx = iris.x - cx, dy = iris.y - cy;
  return {
    u: (dx * ux + dy * uy) / w,
    v: (dx * vx + dy * vy) / w,
    aperture: Math.hypot(down.x - up.x, down.y - up.y) / w,
    width: w,
  };
}

/** Yaw, pitch, roll (radians) and translation from a 4x4 column-major matrix. */
export function headPose(m) {
  if (!m || m.length < 16) return null;
  const r = (i, j) => m[j * 4 + i];      // column-major
  return {
    yaw: Math.atan2(r(0, 2), r(2, 2)),
    pitch: Math.asin(Math.max(-1, Math.min(1, -r(1, 2)))),
    roll: Math.atan2(r(1, 0), r(1, 1)),
    tx: m[12], ty: m[13], tz: m[14],
  };
}

/**
 * One frame in, one sample out:
 *   { ok, reason, features: number[], head: { x, y, iod, ...pose } }
 * `ok` is false for no face or a blink; the caller freezes rather than drops.
 */
export function extract(result, aspect = 1) {
  const lm = result?.faceLandmarks?.[0];
  if (!lm || lm.length < 478) return { ok: false, reason: "face" };

  const R = eyeFrame(lm, EYES.right, aspect), L = eyeFrame(lm, EYES.left, aspect);
  if (!R || !L) return { ok: false, reason: "face" };

  const blend = {};
  for (const c of result.faceBlendshapes?.[0]?.categories ?? []) blend[c.categoryName] = c.score;
  const pose = headPose(result.facialTransformationMatrixes?.[0]?.data) ??
    { yaw: 0, pitch: 0, roll: 0, tx: 0, ty: 0, tz: 0 };

  // Head position in normalised image units, for drift detection. Interocular
  // distance doubles as a distance-from-camera proxy.
  const ra = lm[EYES.right.a], lb = lm[EYES.left.b];
  const head = {
    x: (ra.x + lb.x) / 2, y: (ra.y + lb.y) / 2,
    iod: Math.hypot((lb.x - ra.x) * aspect, lb.y - ra.y),
    ...pose,
  };

  const blink = Math.max(blend.eyeBlinkLeft ?? 0, blend.eyeBlinkRight ?? 0) > BLINK ||
    Math.min(R.aperture, L.aperture) < MIN_APERTURE;

  const features = [
    R.u, R.v, L.u, L.v, R.aperture, L.aperture,
    ...BLENDS.map((k) => blend[k] ?? 0),
    pose.yaw, pose.pitch, pose.roll, pose.tx / 10, pose.ty / 10, pose.tz / 10,
  ];
  if (!features.every(Number.isFinite)) return { ok: false, reason: "face", head };
  return { ok: !blink, reason: blink ? "blink" : null, features, head };
}
