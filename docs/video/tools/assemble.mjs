// Builds the ffmpeg inputs: a concat list of screencast frames (each shown until the next) and
// the voiceover mixed at each scene's start. Then encodes 1080p H.264 + AAC.
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const dir = 'out';
const { t0, end, frames } = JSON.parse(fs.readFileSync(`${dir}/frames.json`, 'utf8'));
const endMs = t0 + end * 1000;
const fr = frames.filter((f) => f.t <= endMs);
const posix = (p) => p.replace(/\\/g, '/');
const lines = [];
for (let i = 0; i < fr.length; i++) {
  const s = Math.max(fr[i].t, t0);
  const e = i + 1 < fr.length ? Math.max(fr[i + 1].t, t0) : endMs;
  const d = (e - s) / 1000;
  if (d <= 0) continue;
  lines.push(`file '${posix(fr[i].file)}'`, `duration ${d.toFixed(4)}`);
}
lines.push(`file '${posix(fr.at(-1).file)}'`);
fs.writeFileSync(`${dir}/list.txt`, lines.join('\n'));

const scenes = JSON.parse(fs.readFileSync('offsets.json', 'utf8'));
const inputs = scenes.flatMap((s) => ['-i', s.file]);
const filter =
  scenes.map((s, i) => `[${i}:a]adelay=${Math.round(s.start * 1000)}|${Math.round(s.start * 1000)}[a${i}]`).join(';') +
  ';' + scenes.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${scenes.length}:normalize=0,apad[aout]`;
execFileSync('ffmpeg', ['-y', '-v', 'error', ...inputs, '-filter_complex', filter, '-map', '[aout]', '-t', String(end), '-c:a', 'pcm_s16le', `${dir}/voice.wav`], { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-v', 'error', '-f', 'concat', '-safe', '0', '-i', `${dir}/list.txt`, '-i', `${dir}/voice.wav`,
  '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', '-shortest', `${dir}/lexcompiler-demo.mp4`], { stdio: 'inherit' });
console.log(`${fr.length} frames, ${end}s`);
