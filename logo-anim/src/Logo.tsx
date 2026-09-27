import React from 'react';

/**
 * Vector reconstruction of the mark, traced by measuring the source artwork
 * (scanline analysis of the reference photo, then normalised so the outer ring
 * has centre 500,500 and mid-radius 291 in a 1000x1000 space).
 *
 * The defining relationship: the two rings are internally tangent on the left —
 * `INNER.cx - INNER.r === OUTER.cx - OUTER.r` — so their strokes coincide exactly
 * there and read as one fused shape. Keep that true if you retune anything.
 */

export const OUTER = {cx: 500, cy: 500, r: 291, w: 44, halfGapDeg: 36.5};
export const INNER = {cx: 373, cy: 500, r: 164, w: 44, halfGapDeg: 26.5};
export const DOT = {cx: 558, cy: 500, r: 48.5};

// The hollow centre of the inner ring — the point the camera starts buried in.
export const DARK_CORE = {x: INNER.cx, y: INNER.cy};

// Radius of solid black around DARK_CORE: bounded by the inner ring's inner edge
// on one side and by the dot on the other.
export const DARK_RADIUS = Math.min(
  INNER.r - INNER.w / 2,
  Math.hypot(DOT.cx - DARK_CORE.x, DOT.cy - DARK_CORE.y) - DOT.r
);

const polar = (cx: number, cy: number, r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return {x: cx + r * Math.cos(rad), y: cy + r * Math.sin(rad)};
};

/** Arc opening to the right (gap centred on 0 degrees), swept the long way round. */
const cArc = (cx: number, cy: number, r: number, halfGapDeg: number) => {
  const start = polar(cx, cy, r, halfGapDeg);
  const end = polar(cx, cy, r, 360 - halfGapDeg);
  return `M ${start.x} ${start.y} A ${r} ${r} 0 1 1 ${end.x} ${end.y}`;
};

export const Logo: React.FC<{color?: string}> = ({color = '#FFFFFF'}) => {
  return (
    <svg
      viewBox="0 0 1000 1000"
      xmlns="http://www.w3.org/2000/svg"
      style={{width: '100%', height: '100%', overflow: 'visible'}}
      shapeRendering="geometricPrecision"
    >
      <path
        d={cArc(OUTER.cx, OUTER.cy, OUTER.r, OUTER.halfGapDeg)}
        fill="none"
        stroke={color}
        strokeWidth={OUTER.w}
        strokeLinecap="butt"
      />
      <path
        d={cArc(INNER.cx, INNER.cy, INNER.r, INNER.halfGapDeg)}
        fill="none"
        stroke={color}
        strokeWidth={INNER.w}
        strokeLinecap="butt"
      />
      <circle cx={DOT.cx} cy={DOT.cy} r={DOT.r} fill={color} />
    </svg>
  );
};
