// Attention map: where the shopper's eyes have been, as probabilities.
//
// Pure, no DOM: tests import this directly.
//
// A webcam cannot say "you are looking at this button" (docs/GAZE.md: the
// ceiling is ~100-200px). It CAN say "you have mostly been looking around
// here". So instead of a pointer, every gaze estimate is treated as a blob of
// probability: a 2-D Gaussian centred on the estimate with the tracker's
// measured error as its spread. Each item's share is the probability that the
// true gaze lies inside its box — much more for the item under the centre,
// some for its neighbours, nothing for things far away.
//
// Those shares are integrated over time at three speeds:
//   fast    (~0.5 s)  what is being looked at right now  -> highlight, "this"
//   recent  (~4 s)    what the last few seconds were about -> "these", context
//   studied (~45 s)   what this visit has lingered on      -> "the one I looked at"
// plus plain seconds of attention per item for the whole session.

const erf = (x) => {
  // Abramowitz & Stegun 7.1.26, |error| < 1.5e-7.
  const s = Math.sign(x), a = Math.abs(x), t = 1 / (1 + 0.3275911 * a);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a);
  return s * y;
};
const cdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

/** Probability that a point ~ N((x, y), sigma²) lies inside the rectangle. */
export function massInRect(x, y, sigma, r) {
  const px = cdf((r.right - x) / sigma) - cdf((r.left - x) / sigma);
  const py = cdf((r.bottom - y) / sigma) - cdf((r.top - y) / sigma);
  return Math.max(0, px * py);
}

const SPEEDS = { fast: 500, recent: 4000, studied: 45000 };

export function createAttention({ speeds = SPEEDS, historyMs = 6000 } = {}) {
  const items = new Map();   // id -> { id, kind, label, title, fast, recent, studied, seconds, target }
  let lastT = null;
  const history = [];        // [{ t, fast: [[id, share], ...] }] for "what was it when they started talking"

  const item = (tg) => {
    let it = items.get(tg.id);
    if (!it) { it = { id: tg.id, kind: tg.kind, fast: 0, recent: 0, studied: 0, seconds: 0 }; items.set(tg.id, it); }
    it.label = tg.label; it.title = tg.product?.title ?? tg.label ?? tg.id; it.kind = tg.kind;
    it.target = tg;
    return it;
  };

  function shares(field, kinds) {
    let sum = 0;
    const out = [];
    for (const it of items.values()) {
      if (kinds && !kinds.includes(it.kind)) continue;
      if (it[field] > 1e-4) { out.push(it); sum += it[field]; }
    }
    return { out: out.sort((a, b) => b[field] - a[field]), sum };
  }

  return {
    /**
     * One gaze estimate. targets: [{ id, kind, label, rect, product? }] visible now.
     * t in ms. Returns this frame's per-target mass (for tests and debugging).
     */
    update(x, y, sigma, t, targets) {
      const dt = lastT === null ? 0 : Math.max(0, Math.min(0.2, (t - lastT) / 1000));
      lastT = t;
      const decay = {};
      for (const k of Object.keys(speeds)) decay[k] = Math.exp(-(dt * 1000) / speeds[k]);
      for (const it of items.values()) for (const k of Object.keys(speeds)) it[k] *= decay[k];

      const mass = targets.map((tg) => [tg, massInRect(x, y, sigma, tg.rect)]);
      // Nested or overlapping boxes can claim more than the whole blob; scale
      // back so the shares stay honest probabilities.
      const total = mass.reduce((s, [, m]) => s + m, 0);
      const scale = total > 1 ? 1 / total : 1;
      for (const [tg, m] of mass) {
        const p = m * scale;
        if (p < 1e-4) continue;
        const it = item(tg);
        for (const k of Object.keys(speeds)) it[k] += p * dt;
        it.seconds += p * dt;
      }
      const top = shares("fast").out.slice(0, 4).map((it) => [it.id, it.fast]);
      history.push({ t, fast: top });
      while (history.length && t - history[0].t > historyMs) history.shift();
      return mass.map(([tg, m]) => ({ id: tg.id, p: m * scale }));
    },

    /** The item holding attention right now, if one clearly does. */
    leader({ minShare = 0.5, kinds = null } = {}) {
      const { out, sum } = shares("fast", kinds);
      if (!out.length || sum <= 0) return null;
      const share = out[0].fast / Math.max(sum, 0.35 * (1 - Math.exp(-1)));  // a trickle is not attention
      return share >= minShare ? { target: out[0].target, share, runnerUp: out[1] ? out[1].fast / sum : 0 } : null;
    },

    /** Share of fast attention an item holds (0..1). */
    shareOf(id) {
      const { sum } = shares("fast");
      const it = items.get(id);
      return it && sum > 0 ? it.fast / sum : 0;
    },

    /** What held attention at time t (e.g. when speech began). */
    at(t) {
      let snap = null;
      for (const h of history) { if (h.t <= t) snap = h; else break; }
      if (!snap?.fast.length) return null;
      const sum = snap.fast.reduce((s, [, v]) => s + v, 0);
      return snap.fast.map(([id, v]) => ({ id, share: v / sum, target: items.get(id)?.target }));
    },

    /**
     * Two items the eyes keep going back and forth between: both hold a real
     * share of the last few seconds and neither dominates.
     */
    torn({ kinds = ["product"], minEach = 0.28 } = {}) {
      const { out, sum } = shares("recent", kinds);
      if (out.length < 2 || sum < 1.2) return null;           // needs a couple of seconds of looking
      const [a, b] = out, sa = a.recent / sum, sb = b.recent / sum;
      return sa >= minEach && sb >= minEach && sa + sb >= 0.75 ? [a, b] : null;
    },

    /** A compact, serialisable picture for the agent. No elements, no pixels. */
    snapshot() {
      const round = (v) => Math.round(v * 100) / 100;
      const pick = (field, kinds, n) => {
        const { out, sum } = shares(field, kinds);
        return out.slice(0, n).map((it) => ({ id: it.id, kind: it.kind, title: it.title, share: round(it[field] / (sum || 1)) }))
          .filter((x) => x.share >= 0.05);
      };
      const session = [...items.values()].filter((it) => it.kind === "product" && it.seconds >= 0.5)
        .sort((a, b) => b.seconds - a.seconds).slice(0, 5)
        .map((it) => ({ id: it.id, title: it.title, seconds: Math.round(it.seconds * 10) / 10 }));
      return { now: pick("fast", null, 4), recent: pick("recent", null, 4), studied: pick("studied", ["product"], 4), session };
    },

    reset() { items.clear(); history.length = 0; lastT = null; },
  };
}
