# ETHGlobal video requirements (added by the coordinator at 14:12 UTC — these override the brief)

To be eligible for Top 10 Finalist prizes the uploaded video must be:

- **Between 2:00 and 4:00 long.** Aim for 3:30–3:50 total. No speed-ups anywhere (manually checked).
- **At least 720p.** Render 1920x1080.
- **Audio without music.** Do not add any music, stingers, whooshes or sound effects to the composition. The only audio
  will be the author's own voice-over, recorded afterwards while reading the karaoke subtitles.

So:

1. Render the video with no audio track, or a silent one. Nothing from `public/` that is an audio file may be used.
2. The karaoke subtitle timing is the voice-over's timing: keep the pace readable aloud (about 140–150 words per
   minute) and leave a short beat between scenes so the author can breathe.
3. Write `video/RECORDING.md`: how to record the voice-over (read the highlighted words, one take per scene is fine),
   and the exact command to lay the recording under the render without re-encoding the picture:

   ```
   ffmpeg -i out/batas-demo.mp4 -i voice.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest out/batas-demo-final.mp4
   ```

   ffmpeg is installed on this machine (`ffmpeg -version` works).
4. Report the final duration from `ffprobe` in your structured result.

## Update 14:16 UTC — slides are being made separately

A second agent is building explanatory Remotion slide scenes in `C:\Hackathons\ETH Online\video-slides\` (about 75
seconds in total, silent, 1920x1080, 30 fps, h264, with their own karaoke subtitles in the same style). The coordinator
will splice them between your footage scenes with ffmpeg. So:

- **Your footage-only render must be 2:30–2:45**, not 3:30. Cut intro/explainer narration that the slides will cover
  (what Batas is, why Aqua needs a mandate, the architecture) and keep your scenes on real footage and real output.
- Render at exactly 1920x1080, 30 fps, h264, yuv420p, no audio track, so the segments concatenate without re-encoding.
- Also render each of your scenes as its own file in `out/scenes/NN-name.mp4` and list their order and durations in
  `COVERAGE.md`, so slides can be inserted at scene boundaries.
