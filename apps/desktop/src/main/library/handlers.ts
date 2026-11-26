import { app, BrowserWindow } from 'electron';
import { mkdirSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Library, LibraryError } from '@director/library';
import { parseScdet, detectCuts, shotsFromCuts, scdetArgs, computePacing, type Pacing, type Shot } from '@director/analysis';
import { runJobOk } from '../jobs/runner';
import { requireSidecar, resolveSidecar } from '../jobs/sidecars';
import { probeMedia } from '../jobs/probe';
import { transcribeFile } from '../transcribe/transcribe';
import { findModel } from '../transcribe/models';

let lib: Library | null = null;
export const userDataDir = () => process.env.DIRECTOR_USER_DATA ?? app.getPath('userData');

/** The local library database (one SQLite file in userData). */
export function library(): Library {
  if (!lib) {
    mkdirSync(userDataDir(), { recursive: true });
    lib = new Library(join(userDataDir(), 'library.sqlite'));
    lib.brands.ensureDefault();
  }
  return lib;
}
export function closeLibrary(): void { lib?.close(); lib = null; }

/** Methods the renderer may call through `library:call`. Each one takes the brand id first, so scoping lives in the library. */
export const LIBRARY_METHODS = {
  'brands.list': (l: Library, includeArchived?: boolean) => l.brands.list(!!includeArchived),
  'brands.create': (l: Library, name: string, color?: string) => l.brands.create(name, color),
  'brands.update': (l: Library, id: string, patch: { name?: string; color?: string | null; archived?: boolean }) => l.brands.update(id, patch),
  'brands.presets': (l: Library, b: string) => l.brands.presets(b),
  'brands.savePreset': (l: Library, b: string, name: string, style: Record<string, unknown>, id?: string) => l.brands.savePreset(b, name, style, id),
  'brands.deletePreset': (l: Library, b: string, id: string) => l.brands.deletePreset(b, id),
  'swipe.list': (l: Library, b: string, q?: Parameters<Library['swipe']['list']>[1]) => l.swipe.list(b, q),
  'swipe.get': (l: Library, b: string, id: string) => l.swipe.get(b, id),
  'swipe.update': (l: Library, b: string, id: string, patch: Parameters<Library['swipe']['update']>[2]) => l.swipe.update(b, id, patch),
  'swipe.setTags': (l: Library, b: string, id: string, tags: string[]) => l.swipe.setTags(b, id, tags),
  'swipe.tags': (l: Library, b: string) => l.swipe.tags(b),
  'swipe.folders': (l: Library, b: string) => l.swipe.folders(b),
  'swipe.kits': (l: Library, b: string) => l.swipe.kits(b),
  'swipe.createKit': (l: Library, b: string, name: string) => l.swipe.createKit(b, name),
  'swipe.deleteKit': (l: Library, b: string, id: string) => l.swipe.deleteKit(b, id),
  'swipe.remove': (l: Library, b: string, id: string) => l.swipe.remove(b, id),
  'swipe.restore': (l: Library, b: string, id: string) => l.swipe.restore(b, id),
  'swipe.transcript': (l: Library, b: string, id: string) => l.swipe.transcript(b, id),
  'studio.voices': (l: Library, b: string, includeDeleted?: boolean) => l.studio.voices(b, !!includeDeleted),
  'studio.createVoice': (l: Library, b: string, v: Parameters<Library['studio']['createVoice']>[1]) => l.studio.createVoice(b, v),
  'studio.updateVoice': (l: Library, b: string, id: string, patch: Parameters<Library['studio']['updateVoice']>[2]) => l.studio.updateVoice(b, id, patch),
  'studio.deleteVoice': (l: Library, b: string, id: string) => l.studio.deleteVoice(b, id),
  'studio.restoreVoice': (l: Library, b: string, id: string) => l.studio.restoreVoice(b, id),
  'studio.hooks': (l: Library, b: string, q?: Parameters<Library['studio']['hooks']>[1]) => l.studio.hooks(b, q),
  'studio.addHook': (l: Library, b: string, h: Parameters<Library['studio']['addHook']>[1]) => l.studio.addHook(b, h),
  'studio.updateHook': (l: Library, b: string, id: string, patch: Parameters<Library['studio']['updateHook']>[2]) => l.studio.updateHook(b, id, patch),
  'studio.markHookUsed': (l: Library, b: string, id: string) => { l.studio.markHookUsed(b, id); return true; },
  'studio.deleteHook': (l: Library, b: string, id: string) => l.studio.deleteHook(b, id),
  'studio.restoreHook': (l: Library, b: string, id: string) => l.studio.restoreHook(b, id),
  'studio.scripts': (l: Library, b: string, includeDeleted?: boolean) => l.studio.scripts(b, !!includeDeleted),
  'studio.script': (l: Library, b: string, id: string) => l.studio.script(b, id),
  'studio.createScript': (l: Library, b: string, s: Parameters<Library['studio']['createScript']>[1]) => l.studio.createScript(b, s),
  'studio.saveVersion': (l: Library, b: string, id: string, v: Parameters<Library['studio']['saveVersion']>[2]) => l.studio.saveVersion(b, id, v),
  'studio.versions': (l: Library, b: string, id: string) => l.studio.versions(b, id),
  'studio.restoreVersion': (l: Library, b: string, id: string, n: number) => l.studio.restoreVersion(b, id, n),
  'studio.deleteScript': (l: Library, b: string, id: string) => l.studio.deleteScript(b, id),
  'studio.restoreScript': (l: Library, b: string, id: string) => l.studio.restoreScript(b, id),
  'usage.summary': (l: Library, since?: string) => l.usage.summary(since),
} as const;
export type LibraryMethod = keyof typeof LIBRARY_METHODS;
export type LibraryResult<M extends LibraryMethod> = ReturnType<(typeof LIBRARY_METHODS)[M]>;

export interface RefAnalysis { durationSec: number; fps: number | null; shots: Shot[]; cuts: number[]; pacing: Pacing; transcribed: boolean; analyzedAt: string; structure?: unknown }

/** Shot detection, pacing and (when a model is installed) a transcript for one reference. */
export async function analyzeReference(brandId: string, id: string, opts: { transcribe?: boolean } = {}): Promise<RefAnalysis> {
  const l = library();
  const ref = l.swipe.require(brandId, id);
  if (!existsSync(ref.path)) throw Object.assign(new Error('The reference file is missing. Re-import it.'), { code: 'MISSING' });
  const probe = await probeMedia(ref.path);
  const durationSec = probe.durationUs / 1e6;
  const res = await runJobOk({ kind: 'shots', cmd: requireSidecar('ffmpeg'), args: scdetArgs(ref.path) });
  const cuts = detectCuts(parseScdet(res.stdout));
  const shots = shotsFromCuts(cuts, durationSec);
  let words: Array<{ text: string; start: number; end: number }> = [];
  let transcribed = false;
  if (opts.transcribe !== false && probe.audio && findModel(undefined)) {
    const t = await transcribeFile(ref.path);
    words = t.words.map((w) => ({ text: w.text, start: w.start / 1e6, end: w.end / 1e6 }));
    l.swipe.setTranscript(brandId, id, { words, language: t.language, model: t.model });
    transcribed = true;
  } else {
    const prior = l.swipe.transcript<{ words: typeof words }>(brandId, id);
    if (prior?.words) { words = prior.words; transcribed = true; }
  }
  const prev = (ref.analysis ?? {}) as { structure?: unknown };
  const analysis: RefAnalysis = {
    durationSec, fps: probe.video ? probe.video.fps.num / probe.video.fps.den : null, shots, cuts, pacing: computePacing(shots, durationSec, words), transcribed, analyzedAt: new Date().toISOString(),
    ...(prev.structure ? { structure: prev.structure } : {}),
  };
  l.swipe.setAnalysis(brandId, id, analysis);
  return analysis;
}

/** Download a reel with yt-dlp, only when the user asks for it by URL. */
export async function importFromUrl(brandId: string, url: string): Promise<ReturnType<Library['swipe']['importPaths']>> {
  const bin = resolveSidecar('yt-dlp');
  if (!bin) throw Object.assign(new Error('Importing by link needs yt-dlp. Install it (brew install yt-dlp) or download the video and import the file.'), { code: 'NO_YTDLP' });
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw Object.assign(new Error('Only http and https links can be imported'), { code: 'INVALID' });
  const dir = join(userDataDir(), 'swipe', brandId);
  mkdirSync(dir, { recursive: true });
  const before = new Set(readdirSync(dir));
  const res = await runJobOk({ kind: 'yt-dlp', cmd: bin, args: ['--no-playlist', '--no-progress', '-f', 'mp4/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best', '--merge-output-format', 'mp4', '-o', join(dir, '%(extractor)s-%(id)s.%(ext)s'), '--print', 'after_move:filepath', url] });
  const printed = res.stdout.trim().split('\n').filter(Boolean).pop();
  const path = printed && existsSync(printed) ? printed : readdirSync(dir).filter((f) => !before.has(f)).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (!path) throw Object.assign(new Error('yt-dlp finished but no video file was found'), { code: 'JOB_FAILED' });
  return library().swipe.importPaths(brandId, [{ path, sourceUrl: url }], { probe: probeInfo });
}

async function probeInfo(path: string) {
  try {
    const p = await probeMedia(path);
    return { durationUs: p.durationUs, width: p.video?.displayWidth ?? p.video?.width ?? null, height: p.video?.displayHeight ?? p.video?.height ?? null };
  } catch { return null; }
}

const READS = new Set(['brands.list', 'brands.presets', 'swipe.list', 'swipe.get', 'swipe.tags', 'swipe.folders', 'swipe.kits', 'swipe.transcript', 'studio.voices', 'studio.hooks', 'studio.scripts', 'studio.script', 'studio.versions', 'usage.summary']);
/** Every window refreshes its library views after a write, wherever it came from. */
export function libraryChangedEvent(): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('director:event:library:changed', {});
}
const writes = <A extends unknown[], R>(fn: (...a: A) => Promise<R>) => async (...a: A): Promise<R> => { const r = await fn(...a); libraryChangedEvent(); return r; };

function mapError(e: unknown): never {
  if (e instanceof LibraryError) throw Object.assign(new Error(e.message), { code: e.code });
  throw e;
}

export const libraryHandlers = {
  'library:call': ({ method, args }: { method: string; args: unknown[] }) => {
    const fn = (LIBRARY_METHODS as Record<string, (l: Library, ...a: unknown[]) => unknown>)[method];
    if (!fn) throw Object.assign(new Error(`unknown library method ${method}`), { code: 'INVALID' });
    let r: unknown;
    try { r = fn(library(), ...args); } catch (e) { return mapError(e); }
    if (!READS.has(method)) libraryChangedEvent();
    return r;
  },
  'swipe:import': writes(async ({ brandId, paths, folder }: { brandId: string; paths: string[]; folder?: string }) => {
    try { return await library().swipe.importPaths(brandId, paths, { folder, probe: probeInfo }); } catch (e) { return mapError(e); }
  }),
  'swipe:importUrl': writes(({ brandId, url }: { brandId: string; url: string }) => importFromUrl(brandId, url)),
  'swipe:analyze': writes(({ brandId, id, transcribe }: { brandId: string; id: string; transcribe?: boolean }) => analyzeReference(brandId, id, { transcribe })),
};
