// The per-user mapping from eye features to a point on the screen.
//
// Pure functions, no DOM: tests import this directly.
//
// Two model families are fitted at calibration and the one that predicts
// held-out targets better is kept:
//   - ridge regression over the features plus quadratic terms of the core gaze
//     signals (stable, extrapolates sensibly to the screen edges);
//   - RBF kernel ridge regression (captures the non-linear bits the ridge
//     cannot, and is what the 2026 capture-clock study found worked best).
// Regularisation (and the kernel width) are chosen by cross-validation that
// holds out whole targets, never individual frames: frames from the same point
// are nearly identical, so frame-level CV would grade the model on its own
// training data.

// ── Small linear algebra ────────────────────────────────────────────────────
/** Solve A X = B for symmetric positive-definite A (n×n) and B (n×k). */
export function choleskySolve(A, B) {
  const n = A.length, k = B[0].length;
  const L = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let p = 0; p < j; p++) s -= L[i][p] * L[j][p];
      if (i === j) {
        if (s <= 1e-12) s = 1e-12;          // regularised systems should not get here
        L[i][j] = Math.sqrt(s);
      } else L[i][j] = s / L[j][j];
    }
  }
  const X = Array.from({ length: n }, () => new Float64Array(k));
  for (let c = 0; c < k; c++) {
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = B[i][c];
      for (let p = 0; p < i; p++) s -= L[i][p] * y[p];
      y[i] = s / L[i][i];
    }
    for (let i = n - 1; i >= 0; i--) {
      let s = y[i];
      for (let p = i + 1; p < n; p++) s -= L[p][i] * X[p][c];
      X[i][c] = s / L[i][i];
    }
  }
  return X;
}

// ── Standardisation ─────────────────────────────────────────────────────────
export function standardizer(X) {
  const d = X[0].length, n = X.length;
  const mu = new Float64Array(d), sd = new Float64Array(d);
  for (const x of X) for (let j = 0; j < d; j++) mu[j] += x[j] / n;
  for (const x of X) for (let j = 0; j < d; j++) sd[j] += (x[j] - mu[j]) ** 2 / n;
  for (let j = 0; j < d; j++) sd[j] = Math.sqrt(sd[j]) || 1;   // constant feature: leave it at 0
  return {
    mu: Array.from(mu), sd: Array.from(sd),
    apply: (x) => x.map((v, j) => (v - mu[j]) / sd[j]),
  };
}

// ── Ridge over an expanded basis ────────────────────────────────────────────
// Quadratic terms only for the core gaze signals: all 20 features squared would
// be 210 terms for a few hundred samples, which is asking to overfit.
const CORE = [0, 1, 2, 3, 4, 5, 14, 15];   // uR vR uL vL apR apL yaw pitch (see gaze-features.js)

function expand(z) {
  const core = CORE.filter((i) => i < z.length).map((i) => z[i]);
  const quad = [];
  for (let i = 0; i < core.length; i++) for (let j = i; j < core.length; j++) quad.push(core[i] * core[j]);
  return [1, ...z, ...quad];
}

function fitRidge(Z, Y, lambda) {
  const P = Z.map(expand);
  const m = P[0].length;
  const A = Array.from({ length: m }, () => new Float64Array(m));
  const B = Array.from({ length: m }, () => new Float64Array(2));
  for (let r = 0; r < P.length; r++) {
    const p = P[r];
    for (let i = 0; i < m; i++) {
      B[i][0] += p[i] * Y[r][0]; B[i][1] += p[i] * Y[r][1];
      for (let j = 0; j <= i; j++) A[i][j] += p[i] * p[j];
    }
  }
  for (let i = 0; i < m; i++) {
    for (let j = 0; j < i; j++) A[j][i] = A[i][j];
    if (i > 0) A[i][i] += lambda;          // never shrink the intercept
  }
  const W = choleskySolve(A, B);
  return {
    predict(z) {
      const p = expand(z);
      let x = 0, y = 0;
      for (let i = 0; i < p.length; i++) { x += p[i] * W[i][0]; y += p[i] * W[i][1]; }
      return [x, y];
    },
    params: { W: W.map((r) => Array.from(r)) },
  };
}

// ── RBF kernel ridge ────────────────────────────────────────────────────────
const sqdist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2; return s; };

function medianSqDist(Z) {
  const d = [];
  const step = Math.max(1, Math.floor(Z.length / 60));
  for (let i = 0; i < Z.length; i += step) for (let j = i + step; j < Z.length; j += step) d.push(sqdist(Z[i], Z[j]));
  d.sort((a, b) => a - b);
  return d[d.length >> 1] || 1;
}

function fitKrr(Z, Y, lambda, gamma) {
  const n = Z.length;
  const my = [Y.reduce((s, y) => s + y[0], 0) / n, Y.reduce((s, y) => s + y[1], 0) / n];
  const K = Array.from({ length: n }, () => new Float64Array(n));
  for (let i = 0; i < n; i++) {
    K[i][i] = 1 + lambda;
    for (let j = 0; j < i; j++) K[i][j] = K[j][i] = Math.exp(-gamma * sqdist(Z[i], Z[j]));
  }
  const alpha = choleskySolve(K, Y.map((y) => [y[0] - my[0], y[1] - my[1]]));
  return {
    predict(z) {
      let x = my[0], y = my[1];
      for (let i = 0; i < n; i++) {
        const k = Math.exp(-gamma * sqdist(z, Z[i]));
        x += k * alpha[i][0]; y += k * alpha[i][1];
      }
      return [x, y];
    },
    params: { gamma, my, alpha: alpha.map((r) => Array.from(r)), Z: Z.map((z) => Array.from(z)) },
  };
}

// ── Cross-validation ────────────────────────────────────────────────────────
function folds(groups, k) {
  const ids = [...new Set(groups)];
  const f = new Map(ids.map((g, i) => [g, i % k]));
  return groups.map((g) => f.get(g));
}

function cvError(Z, Y, groups, fit, k = 5) {
  const fold = folds(groups, Math.min(k, new Set(groups).size));
  let err = 0, n = 0;
  for (let f = 0; f < Math.max(...fold) + 1; f++) {
    const tr = [], te = [];
    fold.forEach((v, i) => (v === f ? te : tr).push(i));
    if (!tr.length || !te.length) continue;
    const m = fit(tr.map((i) => Z[i]), tr.map((i) => Y[i]));
    for (const i of te) { const [x, y] = m.predict(Z[i]); err += Math.hypot(x - Y[i][0], y - Y[i][1]); n++; }
  }
  return n ? err / n : Infinity;
}

/** Keep at most `max` samples, evenly across groups, so kernel fits stay fast. */
function thin(samples, max) {
  if (samples.length <= max) return samples;
  const step = samples.length / max;
  return Array.from({ length: max }, (_, i) => samples[Math.floor(i * step)]);
}

/**
 * Fit a gaze model.
 *   samples: [{ f: number[], x, y, g }]   g groups frames from the same target
 * Returns { kind, predict(f) -> {x, y}, cv_px, toJSON() }.
 */
export function fitGazeModel(samples, { kernel = true } = {}) {
  if (samples.length < 12) throw new Error("not enough calibration samples");
  const std = standardizer(samples.map((s) => s.f));
  const Z = samples.map((s) => std.apply(s.f));
  const Y = samples.map((s) => [s.x, s.y]);
  const G = samples.map((s) => s.g);

  let best = null;
  for (const lambda of [0.3, 3, 30]) {
    const e = cvError(Z, Y, G, (z, y) => fitRidge(z, y, lambda));
    if (!best || e < best.e) best = { e, kind: "ridge", lambda };
  }
  if (kernel) {
    const few = thin(samples.map((s, i) => i), 260);
    const Zk = few.map((i) => Z[i]), Yk = few.map((i) => Y[i]), Gk = few.map((i) => G[i]);
    const base = 1 / medianSqDist(Zk);
    for (const lambda of [0.03, 0.3]) for (const scale of [0.5, 1, 2]) {
      const e = cvError(Zk, Yk, Gk, (z, y) => fitKrr(z, y, lambda, base * scale));
      if (e < best.e) best = { e, kind: "krr", lambda, gamma: base * scale, idx: few };
    }
  }

  const m = best.kind === "ridge"
    ? fitRidge(Z, Y, best.lambda)
    : fitKrr(best.idx.map((i) => Z[i]), best.idx.map((i) => Y[i]), best.lambda, best.gamma);
  return wrap(best.kind, std.mu, std.sd, m, best.e);
}

function wrap(kind, mu, sd, m, cv) {
  return {
    kind, cv_px: Math.round(cv),
    predict(f) {
      const [x, y] = m.predict(f.map((v, j) => (v - mu[j]) / sd[j]));
      return { x, y };
    },
    toJSON: () => ({ kind, mu, sd, cv, params: m.params }),
  };
}

/** Rebuild a model saved with toJSON() (calibration resume across pages). */
export function loadGazeModel(j) {
  if (!j || !Array.isArray(j.mu) || !Array.isArray(j.sd) || !j.params) return null;
  let m;
  if (j.kind === "ridge") {
    const W = j.params.W;
    m = { predict(z) {
      const p = expand(z); let x = 0, y = 0;
      for (let i = 0; i < p.length; i++) { x += p[i] * W[i][0]; y += p[i] * W[i][1]; }
      return [x, y];
    }, params: j.params };
  } else if (j.kind === "krr") {
    const { gamma, my, alpha, Z } = j.params;
    m = { predict(z) {
      let x = my[0], y = my[1];
      for (let i = 0; i < Z.length; i++) { const k = Math.exp(-gamma * sqdist(z, Z[i])); x += k * alpha[i][0]; y += k * alpha[i][1]; }
      return [x, y];
    }, params: j.params };
  } else return null;
  return wrap(j.kind, j.mu, j.sd, m, j.cv ?? 0);
}

/**
 * Smooth pursuit: the eye (and the camera) lag a moving target. Try a few lags
 * and keep the one whose samples fit best. `pursuit` is [{ f, t }] and
 * `targetAt(t)` gives the dot's position at time t.
 */
export function bestPursuitLag(pursuit, targetAt, anchors = [], lags = [0, 60, 120, 180, 240, 300]) {
  let best = { lag: 120, e: Infinity };
  for (const lag of lags) {
    const s = [...anchors, ...pursuit.map((p, i) => {
      const [x, y] = targetAt(p.t - lag);
      return { f: p.f, x, y, g: `p${Math.floor(i / 8)}` };
    })];
    try {
      const m = fitGazeModel(s, { kernel: false });
      if (m.cv_px < best.e) best = { lag, e: m.cv_px };
    } catch { /* too few samples at this lag */ }
  }
  return best.lag;
}
