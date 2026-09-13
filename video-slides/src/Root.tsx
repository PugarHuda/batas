import React from 'react';
import { Composition } from 'remotion';
import { SCENES, FPS, timeScene } from './narration';
import { ColdOpen, Problem, Mandate, KillSwitch, Hedera, Ens, Close } from './scenes';

const COMPONENTS = [ColdOpen, Problem, Mandate, KillSwitch, Hedera, Ens, Close];

export const Root: React.FC = () => (
  <>
    {SCENES.map((s, i) => (
      <Composition key={s.id} id={s.id} component={COMPONENTS[i]} durationInFrames={timeScene(s.en).duration} fps={FPS} width={1920} height={1080} />
    ))}
  </>
);
