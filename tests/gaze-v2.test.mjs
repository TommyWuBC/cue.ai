import assert from 'node:assert/strict';
import test from 'node:test';
import { fitGazeModel, loadGazeModel, bestPursuitLag, choleskySolve } from '../client/gaze-model.js';
import { eyeFrame, extract, EYES, FEATURE_NAMES } from '../client/gaze-features.js';
import { fixationFilter } from '../client/fixation.js';

// Deterministic noise so failures are reproducible.
function rng(seed = 7) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}
function gauss(r) { return Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()); }

// A synthetic "eye": 20 features where gaze drives the iris offsets (with a
// mild non-linearity), head yaw/pitch shift the mapping, and the rest is noise.
function featuresFor(x, y, r, { noise = 0.004, yaw = 0 } = {}) {
  const gx = x / 1440 - 0.5, gy = y / 900 - 0.5;
  const u = 0.18 * gx + 0.05 * gx * gx - 0.1 * yaw, v = 0.10 * gy + 0.03 * gy * Math.abs(gy);
  const f = new Array(20).fill(0).map(() => gauss(r) * 0.01);
  f[0] = u + gauss(r) * noise; f[2] = u + gauss(r) * noise;
  f[1] = v + gauss(r) * noise; f[3] = v + gauss(r) * noise;
  f[4] = 0.3 - 0.4 * gy + gauss(r) * noise; f[5] = f[4];
  f[14] = yaw;
  return f;
}

function grid(r, n = 9, perPoint = 25, opts) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = 120 + (i % 3) * 600, y = 90 + Math.floor(i / 3) * 360;
    for (let k = 0; k < perPoint; k++) out.push({ f: featuresFor(x, y, r, opts), x, y, g: `p${i}` });
  }
  return out;
}

test('cholesky solves a small SPD system', () => {
  const X = choleskySolve([[4, 2], [2, 3]], [[2], [1]]);
  assert.ok(Math.abs(X[0][0] - 0.5) < 1e-9 && Math.abs(X[1][0]) < 1e-9);
});

test('the model learns a non-linear mapping and predicts targets it never trained on', () => {
  const r = rng(1);
  const m = fitGazeModel(grid(r));
  assert.ok(['ridge', 'krr'].includes(m.kind));
  assert.ok(m.cv_px < 80, `cross-validated error ${m.cv_px}px`);
  let err = 0, n = 0;
  for (const [x, y] of [[400, 300], [1000, 600], [720, 450], [300, 700]]) {
    for (let k = 0; k < 10; k++) { const p = m.predict(featuresFor(x, y, r)); err += Math.hypot(p.x - x, p.y - y); n++; }
  }
  assert.ok(err / n < 90, `held-out error ${Math.round(err / n)}px`);
});

test('head pose is learned rather than breaking the mapping', () => {
  const r = rng(3);
  const samples = [...grid(r, 9, 12, { yaw: -0.15 }), ...grid(r, 9, 12, { yaw: 0 }), ...grid(r, 9, 12, { yaw: 0.15 })]
    .map((s, i) => ({ ...s, g: s.g + Math.floor(i / 108) }));
  const m = fitGazeModel(samples);
  const p = m.predict(featuresFor(720, 450, r, { yaw: 0.12 }));
  assert.ok(Math.hypot(p.x - 720, p.y - 450) < 120, `with head turned: ${Math.round(Math.hypot(p.x - 720, p.y - 450))}px`);
});

test('a saved model predicts exactly what the live one did', () => {
  const r = rng(5);
  const m = fitGazeModel(grid(r));
  const back = loadGazeModel(JSON.parse(JSON.stringify(m.toJSON())));
  const f = featuresFor(500, 500, r);
  const a = m.predict(f), b = back.predict(f);
  assert.ok(Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6);
  assert.equal(loadGazeModel({ kind: 'nope' }), null);
});

test('pursuit lag is recovered from a moving target', () => {
  const r = rng(9);
  const path = (t) => [200 + 1000 * (0.5 + 0.5 * Math.sin(t / 900)), 150 + 600 * (0.5 + 0.5 * Math.cos(t / 1300))];
  const TRUE_LAG = 180;
  const pursuit = [];
  for (let t = 0; t < 9000; t += 33) { const [x, y] = path(t - TRUE_LAG); pursuit.push({ f: featuresFor(x, y, r), t }); }
  const lag = bestPursuitLag(pursuit, path, grid(r, 9, 6));
  assert.ok(Math.abs(lag - TRUE_LAG) <= 60, `recovered ${lag}ms`);
});

test('refuses to fit on too little data', () => {
  assert.throws(() => fitGazeModel([{ f: [1], x: 0, y: 0, g: 'a' }]));
});

// ── Features ─────────────────────────────────────────────────────────────────
function face({ iris = [0, 0], roll = 0, scale = 1, blinkScore = 0, open = 0.3 } = {}) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  const put = (i, x, y) => {
    const c = Math.cos(roll), s = Math.sin(roll);
    lm[i] = { x: 0.5 + scale * (x * c - y * s), y: 0.5 + scale * (x * s + y * c), z: 0 };
  };
  for (const [eye, cx] of [[EYES.right, -0.06], [EYES.left, 0.06]]) {
    put(eye.a, cx - 0.03, 0); put(eye.b, cx + 0.03, 0);
    put(eye.up, cx, -0.03 * open); put(eye.down, cx, 0.03 * open);
    put(eye.iris, cx + iris[0] * 0.06, iris[1] * 0.06);
  }
  return { faceLandmarks: [lm], faceBlendshapes: [{ categories: [
    { categoryName: 'eyeBlinkLeft', score: blinkScore }, { categoryName: 'eyeBlinkRight', score: blinkScore }] }] };
}

test('iris offsets move with the eyes and ignore head roll and distance', () => {
  const base = extract(face({ iris: [0.2, 0.1] }));
  assert.equal(base.ok, true);
  assert.equal(base.features.length, FEATURE_NAMES.length);
  const rolled = extract(face({ iris: [0.2, 0.1], roll: 0.35, scale: 1.4 }));
  for (const i of [0, 1, 2, 3]) assert.ok(Math.abs(base.features[i] - rolled.features[i]) < 1e-6);
  const looked = extract(face({ iris: [-0.2, 0.1] }));
  assert.ok(looked.features[0] < base.features[0] - 0.3, 'looking the other way changes u');
});

test('blinks and missing faces are flagged, not predicted from', () => {
  assert.equal(extract(face({ blinkScore: 0.9 })).reason, 'blink');
  assert.equal(extract(face({ open: 0.05 })).reason, 'blink');
  assert.equal(extract({ faceLandmarks: [] }).reason, 'face');
  assert.equal(eyeFrame(face().faceLandmarks[0], EYES.right).width > 0, true);
});

// ── Fixations ────────────────────────────────────────────────────────────────
test('fixations are steady, saccades snap, a single flyer is ignored', () => {
  const r = rng(11);
  const f = fixationFilter({ radius: 60 });
  let t = 0, outs = [];
  for (let k = 0; k < 40; k++) outs.push(f.push(500 + gauss(r) * 18, 400 + gauss(r) * 18, t += 33));
  const late = outs.slice(10);
  const jitter = late.slice(1).reduce((s, o, i) => s + Math.hypot(o.x - late[i].x, o.y - late[i].y), 0) / (late.length - 1);
  assert.ok(late.every((o) => o.fixating));
  assert.ok(jitter < 4, `frame-to-frame jitter while fixating ${jitter.toFixed(1)}px (raw ~25px)`);

  const flyer = f.push(900, 100, t += 33);
  assert.ok(Math.hypot(flyer.x - 500, flyer.y - 400) < 30, 'one stray sample does not move it');

  f.push(1000, 300, t += 33);
  const jumped = f.push(1002, 298, t += 33);
  assert.ok(Math.hypot(jumped.x - 1001, jumped.y - 299) < 5, 'a confirmed saccade lands within two frames');
});
