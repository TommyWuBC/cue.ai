import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {DARK_CORE, DARK_RADIUS, Logo} from './Logo';

export const FPS = 30;
export const BLACK_HOLD = 9; // 0.3s of pure black before the camera moves
export const ZOOM = 81; // 2.7s pull-back
export const HOLD = 270; // 9.0s of the logo locked off, for the audio overlay
export const TOTAL = BLACK_HOLD + ZOOM + HOLD; // 360 frames = 12.0s

// Logo box edge in px at 1x. The outer ring is 0.626 of this, so ~474px tall
// on a 1080 frame.
const LOGO_SIZE = 757;
// Headroom beyond the scale at which the frame is exactly filled by the logo's
// black core, so frame 0 is safely black rather than borderline.
const START_MARGIN = 1.12;
const START_ROTATION = 6;

export const ZoomOut: React.FC<{background?: string; color?: string}> = ({
  background = '#000000',
  color = '#FFFFFF',
}) => {
  const frame = useCurrentFrame();
  const {width, height} = useVideoConfig();

  // Zoom far enough in that the logo's black core covers the frame corners.
  // Derived rather than hard-coded, so retracing the logo or changing the
  // resolution cannot silently leave a lit pixel in frame 0.
  const blackoutScale =
    Math.hypot(width / 2, height / 2) / (DARK_RADIUS * (LOGO_SIZE / 1000));
  const startScale = blackoutScale * START_MARGIN;

  const t = interpolate(frame, [BLACK_HOLD, BLACK_HOLD + ZOOM], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    // Near-linear through the middle so the pull-back keeps moving, with a
    // soft departure and a long, gentle landing.
    easing: Easing.bezier(0.4, 0.15, 0.3, 1),
  });

  // Interpolate in log space so the pull-back reads at a constant rate of zoom.
  const scale = Math.exp(interpolate(t, [0, 1], [Math.log(startScale), 0]));
  const rotation = interpolate(t, [0, 1], [START_ROTATION, 0]);

  return (
    <AbsoluteFill style={{backgroundColor: background}}>
      <AbsoluteFill style={{justifyContent: 'center', alignItems: 'center'}}>
        <div
          style={{
            width: LOGO_SIZE,
            height: LOGO_SIZE,
            transform: `scale(${scale}) rotate(${rotation}deg)`,
            transformOrigin: `${(DARK_CORE.x / 1000) * 100}% ${
              (DARK_CORE.y / 1000) * 100
            }%`,
            willChange: 'transform',
          }}
        >
          <Logo color={color} />
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
