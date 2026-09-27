# Logo zoom-out

Remotion piece for the Cue mark: opens on black deep inside the logo, pulls back to
the full lockup, then holds dead still for exactly 9.0s so audio can be laid over the
hold in Premiere.

## Timeline (30fps, 1920x1080, 360 frames / 12.0s)

| frames | seconds | what |
|---|---|---|
| 0-8 | 0.0-0.3 | black, camera parked inside the inner ring |
| 9-89 | 0.3-3.0 | pull-back from ~12x to 1x, 6deg of counter-rotation settling to 0 |
| 90-359 | 3.0-12.0 | logo locked off — 270 byte-identical frames |

Frame 90 onward is literally the same render (the scale/rotation interpolation is
clamped), so there is no drift or edge shimmer under the audio.

## Output

- `out/cue-logo-zoom.mov` — ProRes 422 HQ. Use this one in Premiere.
- `out/cue-logo-zoom.mp4` — H.264, for quick preview.

## Rendering

```bash
npm install
npx remotion render LogoZoomOut out/cue-logo-zoom.mov \
  --codec=prores --prores-profile=hq --concurrency=1
```

`--concurrency=1` matters: parallel Remotion workers antialias the curved edges
slightly differently, which makes the 9s hold shimmer. One worker keeps it identical.

Preview interactively with `npm start`.

## Notes

- The mark is rebuilt as vector SVG in `src/Logo.tsx` (two butt-capped arcs plus a
  dot) rather than using the source raster, so it stays sharp when zoomed.
  Geometry was measured off the reference artwork by scanline analysis, not eyeballed;
  the reconstruction overlaps the source at IoU 0.94 (the rest is photo distortion).
  The rings are internally tangent on the left — `INNER.cx - INNER.r` equals
  `OUTER.cx - OUTER.r` — which is what makes them fuse into one shape there.
- The start scale is derived from `DARK_RADIUS` (the black core inside the inner ring)
  rather than hard-coded, so retracing the logo or changing resolution can't leave a
  lit pixel in frame 0.
- Timing, start scale and easing are the constants at the top of `src/ZoomOut.tsx`.
- Background and logo colour are composition props if you need the mark on white.
