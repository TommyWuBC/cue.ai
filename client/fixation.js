// Fixation stabiliser: report where the eyes are resting, not every sample.
//
// Pure, no DOM: tests import this directly.
//
// Real eyes do not glide. They hold still (fixations, 200-600 ms) and jump
// (saccades, 20-80 ms). A webcam estimate adds noise on top of both, so a
// filter that follows every sample either flickers (light smoothing) or trails
// behind every jump (heavy smoothing). Eye trackers resolve this by detecting
// the fixation and reporting its centre, which is steady by construction, and
// letting a saccade through the moment it is confirmed.
//
// This is dispersion-based (I-DT style): samples within `radius` of the
// running centre belong to the current fixation; `breakFrames` consecutive
// samples outside it end the fixation and start a new one where they landed.
// One stray sample (a flyer) is ignored.

export function fixationFilter({ radius = 60, minMs = 100, breakFrames = 2, window = 24 } = {}) {
  let fix = null;          // { cx, cy, start, pts: [[x, y], ...] }
  let outside = [];

  const begin = (x, y, t) => { fix = { cx: x, cy: y, start: t, pts: [[x, y]] }; outside = []; };
  const recentre = () => {
    let sx = 0, sy = 0;
    for (const [x, y] of fix.pts) { sx += x; sy += y; }
    fix.cx = sx / fix.pts.length; fix.cy = sy / fix.pts.length;
  };

  return {
    get radius() { return radius; },
    setRadius(r) { radius = Math.max(20, r); },
    reset() { fix = null; outside = []; },
    /** t in ms. Returns { x, y, fixating, duration }. */
    push(x, y, t) {
      if (!fix) { begin(x, y, t); return { x, y, fixating: false, duration: 0 }; }
      if (Math.hypot(x - fix.cx, y - fix.cy) <= radius) {
        outside = [];
        fix.pts.push([x, y]);
        // A sliding window lets the centre follow slow drift and smooth pursuit
        // without ever snapping.
        if (fix.pts.length > window) fix.pts.shift();
        recentre();
      } else {
        outside.push([x, y]);
        if (outside.length >= breakFrames) {
          // Confirmed saccade: start the new fixation at the mean of the
          // samples that left, not at the last one alone.
          const nx = outside.reduce((s, p) => s + p[0], 0) / outside.length;
          const ny = outside.reduce((s, p) => s + p[1], 0) / outside.length;
          begin(nx, ny, t);
          return { x: nx, y: ny, fixating: false, duration: 0 };
        }
      }
      const duration = t - fix.start;
      return duration >= minMs
        ? { x: fix.cx, y: fix.cy, fixating: true, duration }
        : { x, y, fixating: false, duration };
    },
  };
}
