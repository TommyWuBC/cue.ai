import React from 'react';
import {Composition, Still} from 'remotion';
import {FPS, TOTAL, ZoomOut} from './ZoomOut';
import {Logo} from './Logo';

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="LogoZoomOut"
        component={ZoomOut}
        durationInFrames={TOTAL}
        fps={FPS}
        width={1920}
        height={1080}
        defaultProps={{background: '#000000', color: '#FFFFFF'}}
      />
      <Still
        id="LogoCheck"
        component={LogoCheck}
        width={1000}
        height={1000}
      />
    </>
  );
};

const LogoCheck: React.FC = () => (
  <div style={{width: 1000, height: 1000, background: '#1c1c1c'}}>
    <Logo />
  </div>
);
