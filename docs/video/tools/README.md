# Re-recording the demo video

These scripts made `docs/video/lexcompiler-demo.mp4`. They were run once on Shakil's laptop, so paths are hard-coded: change the Chrome path, the project path and the check-run URL if you run them elsewhere.

1. Install the recorder in a folder outside the project: `npm install playwright-core@1.48.2`. Copy `record.mjs` and `assemble.mjs` there.
2. Start Keycloak and the live server (see `docs/submission/TEAMMATE_CHECKLIST.md`). No tunnel is needed.
3. Render the voiceover: `npm run voiceover`. It needs `ELEVENLABS_API_KEY` in `.env.local`, and skips scenes whose text hasn't changed.
4. Write `offsets.json`: one `{ "id", "file", "start", "dur" }` per clip, in seconds. Scene ids must match `docs/video/narration.json`. Start at 1.0 and leave a 0.6 s gap between clips.
5. Run `node record.mjs out offsets.json`, then `node assemble.mjs`. ffmpeg must be on the PATH. The video is `out/lexcompiler-demo.mp4`.
6. Run `git checkout -- target-repo` afterwards: the dashboard's demo buttons patch those files.

`build-diagram.mjs` writes the overview diagram: `node build-diagram.mjs docs/submission/lexcompiler-architecture.svg`.
