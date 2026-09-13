# References

Research was capped at ten minutes. Three techniques were borrowed, each for a reason in the story.

1. **Stroke draw-on for chart linework.**
   Remotion's `evolvePath()` animates a path from invisible to fully drawn using `stroke-dasharray` and `stroke-dashoffset`.
   https://www.remotion.dev/docs/paths/evolve-path
   (source: https://github.com/remotion-dev/remotion/blob/main/packages/paths/src/evolve-path.ts)
   Used here with the native SVG `pathLength="1"` form of the same trick. It draws the graticule, the VOR rose, flight routes, the ENS tree edges and the kill-switch signal. A line drawing on always means that a connection is being made.

2. **Word-by-word caption highlighting.**
   This follows the TikTok-style caption pages that Remotion's caption tooling produces (`@remotion/captions`, `createTikTokStyleCaptions`).
   https://www.remotion.dev/docs/captions/
   https://github.com/remotion-dev/template-tiktok
   Used for the karaoke band. Each word has a start and an end frame, and the band shows one page of at most two lines. It is implemented in `src/kit.tsx` without the package, because the timings come from the script rather than from a transcription.

3. **Spring physics for instruments that settle, not slide.**
   https://www.remotion.dev/docs/spring
   Instrument needles, the limit stops of the mark and the hash counter settle on a damped spring the way a gauge does. The HUD vocabulary itself is taken from the project's own `DESIGN.md`: the airspeed-indicator states (a green disc for inside, an open square for caution, a drawn cross for never), magenta for limits and blue for structure.
