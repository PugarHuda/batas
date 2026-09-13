import React from 'react';
import { registerRoot, Composition, delayRender, continueRender, staticFile } from 'remotion';
import { Demo } from './Demo.jsx';
import { timeline } from './timing.mjs';

// The site's own faces, loaded before the first frame renders so no frame is set in a fallback.
const faces = [['B612', 'b612-400', '400'], ['B612', 'b612-700', '700'], ['B612 Mono', 'b612-mono-400', '400'], ['Barlow Condensed', 'barlow-condensed-700', '700']];
const fontHandle = delayRender('fonts');
Promise.all(faces.map(([family, file, weight]) => new FontFace(family, `url(${staticFile(`fonts/${file}.woff2`)})`, { weight }).load().then((f) => document.fonts.add(f))))
    .then(() => continueRender(fontHandle));

const t = timeline();

const Root = () => (
    <Composition id="Demo" component={Demo} durationInFrames={t.totalFrames} fps={t.fps} width={1920} height={1080} />
);

registerRoot(Root);
