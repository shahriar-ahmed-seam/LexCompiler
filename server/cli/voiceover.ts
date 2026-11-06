/**
 * Renders the demo video's voiceover with ElevenLabs text-to-speech: one MP3 per scene.
 *
 *   npm run voiceover -- [--script docs/video/narration.json] [--out data/voiceover] [--only <sceneId>] [--dry-run] [--force]
 *
 * The script is JSON: { "voices": { "en": "<voiceId>", "bn": "<voiceId>" }, "scenes": [{ "id", "lang", "text" }] }.
 * Scenes in the same language are stitched (previous and next text), so the joins sound natural.
 * A scene whose text hasn't changed since its last render is skipped, so edits cost only what
 * changed; --dry-run prints the characters that would be billed and calls nothing. The key comes
 * from ELEVENLABS_API_KEY (the npm script loads .env.local); it is never read here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const value = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const MODEL_ID = 'eleven_v4';
/** George (narrative), from ElevenLabs' premade voices; a script can choose others per language. */
const DEFAULT_VOICE = 'JBFqnCBsd6RMkjVDRZzb';

interface Scene {
  id: string;
  lang: 'en' | 'bn';
  text: string;
}
interface Script {
  voices?: Partial<Record<Scene['lang'], string>>;
  scenes: Scene[];
}

function readScript(file: string): Script {
  const script = JSON.parse(fs.readFileSync(file, 'utf8')) as Script;
  if (!Array.isArray(script.scenes) || script.scenes.length === 0) throw new Error(`${file} has no scenes`);
  const ids = new Set<string>();
  for (const s of script.scenes) {
    if (!/^[a-z0-9-]+$/.test(s.id ?? '')) throw new Error(`scene id "${s.id}" must be lowercase letters, digits and dashes`);
    if (ids.has(s.id)) throw new Error(`scene id "${s.id}" is used twice`);
    ids.add(s.id);
    if (s.lang !== 'en' && s.lang !== 'bn') throw new Error(`scene ${s.id}: lang must be "en" or "bn"`);
    if (!s.text?.trim()) throw new Error(`scene ${s.id} has no text`);
  }
  return script;
}

/** What a scene's audio depends on; a matching .json beside the MP3 means it is up to date. */
const fingerprint = (scene: Scene, voiceId: string, previousText?: string, nextText?: string) =>
  crypto.createHash('sha256').update(JSON.stringify([MODEL_ID, voiceId, scene.lang, scene.text, previousText ?? '', nextText ?? ''])).digest('hex');

async function main() {
  const scriptFile = value('script') || 'docs/video/narration.json';
  const outDir = value('out') || 'data/voiceover';
  const only = value('only');
  const script = readScript(scriptFile);
  if (only && !script.scenes.some((s) => s.id === only)) throw new Error(`no scene "${only}" in ${scriptFile}`);

  const jobs = script.scenes.map((scene, i) => {
    // Stitch only with neighbours in the same language.
    const prev = script.scenes[i - 1]?.lang === scene.lang ? script.scenes[i - 1].text : undefined;
    const next = script.scenes[i + 1]?.lang === scene.lang ? script.scenes[i + 1].text : undefined;
    const voiceId = script.voices?.[scene.lang] || DEFAULT_VOICE;
    const mp3 = path.join(outDir, `${String(i + 1).padStart(2, '0')}-${scene.id}.mp3`);
    const hash = fingerprint(scene, voiceId, prev, next);
    const meta = mp3.replace(/\.mp3$/, '.json');
    const fresh = !flag('force') && fs.existsSync(mp3) && fs.existsSync(meta) && JSON.parse(fs.readFileSync(meta, 'utf8')).hash === hash;
    return { scene, voiceId, prev, next, mp3, meta, hash, fresh };
  });
  const todo = jobs.filter((j) => (!only || j.scene.id === only) && !j.fresh);
  const chars = todo.reduce((n, j) => n + j.scene.text.length, 0);
  console.log(`${todo.length} of ${jobs.length} scene(s) to render, ${chars} characters (${jobs.length - todo.length} up to date).`);
  if (flag('dry-run') || todo.length === 0) return;

  if (!process.env.ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set; run it through `npm run voiceover`, which loads .env.local');
  const client = new ElevenLabsClient();
  fs.mkdirSync(outDir, { recursive: true });
  for (const j of todo) {
    const audio = await client.textToSpeech.convert(j.voiceId, {
      text: j.scene.text,
      modelId: MODEL_ID,
      languageCode: j.scene.lang,
      previousText: j.prev,
      nextText: j.next,
      outputFormat: 'mp3_44100_128',
    });
    await pipeline(Readable.fromWeb(audio as import('node:stream/web').ReadableStream), fs.createWriteStream(j.mp3));
    fs.writeFileSync(j.meta, JSON.stringify({ id: j.scene.id, lang: j.scene.lang, voiceId: j.voiceId, model: MODEL_ID, chars: j.scene.text.length, hash: j.hash }, null, 2));
    console.log(`${j.mp3} (${j.scene.lang}, ${j.scene.text.length} characters)`);
  }
}

main().catch((err) => {
  console.error(`voiceover: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
