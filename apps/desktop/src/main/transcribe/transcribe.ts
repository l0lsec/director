import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { wordsFromDtw, rmsFrames, wavPcm16, type TWord } from '@director/analysis';
import { runJobOk } from '../jobs/runner';
import { requireSidecar } from '../jobs/sidecars';
import { findModel } from './models';
import { quickHash, cacheDirFor } from '../media/importer';
import { mediaCacheRoot } from '../media/handlers';

export const TIMING_VERSION = 4;

export interface Transcript { mediaId?: string; language: string; model: string; words: TWord[]; seconds: number; elapsedMs: number }

/** Transcribe a media file with whisper.cpp (Metal), DTW word ends and audio-refined word starts. Cached by content hash. */
export async function transcribeFile(path: string, opts: { model?: string; language?: string; projectDir?: string; force?: boolean } = {}): Promise<Transcript> {
  const model = findModel(opts.model);
  if (!model) throw Object.assign(new Error('No transcription model installed. Open Settings (Cmd+,) > Transcription to download one.'), { code: 'NO_MODEL' });
  const dir = cacheDirFor(mediaCacheRoot(opts.projectDir), quickHash(path));
  // Bump TIMING_VERSION when word-timing logic changes so cached transcripts are recomputed.
  const cacheFile = join(dir, `transcript.${model.info.id}.${opts.language ?? "auto"}.t${TIMING_VERSION}.json`);
  if (!opts.force && existsSync(cacheFile)) return JSON.parse(readFileSync(cacheFile, 'utf8')) as Transcript;
  mkdirSync(dir, { recursive: true });
  const t0 = Date.now();
  const wav = join(dir, 'speech16k.wav');
  await runJobOk({ kind: 'transcribe-prep', cmd: requireSidecar('ffmpeg'), args: ['-v', 'error', '-y', '-i', path, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav] });
  const outBase = join(dir, `whisper.${model.info.id}`);
  const lang = opts.language ?? (model.info.id.endsWith('.en') ? 'en' : 'auto');
  await runJobOk({
    kind: 'transcribe', cmd: requireSidecar('whisper-cli'),
    args: ['-m', model.path, '-f', wav, '-ojf', '-of', outBase, '-dtw', model.info.dtw, '-nfa', '-np', '-l', lang, '-t', '8'],
  });
  const json = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as { result?: { language?: string }; transcription?: [] };
  const { samples } = wavPcm16(readFileSync(wav));
  const energy = rmsFrames(samples, 16000);
  const words = wordsFromDtw(json as never, energy);
  const result: Transcript = { language: json.result?.language ?? lang, model: model.info.id, words, seconds: samples.length / 16000, elapsedMs: Date.now() - t0 };
  writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}
