// Speaker layout: who is talking (lip movement, Apple Vision) drives close shots, side-by-side shots for quick exchanges
// and alternating framing in long answers, laid over a split-screen or single-camera clip.
import { analyzeSpeakers, planSpeakerShots, frameShots, type SpeakerAnalysis, type SpeakerShotOptions, type MouthSample } from '@director/analysis';
import { speakerLayoutOps, clipEnd, findClip, type Clip, type Effect, type Project } from '@director/engine';
import { useProject } from '../../project/store';
import { invoke } from '../../../shell/bridge';
import { useShell } from '../../../shell/store';

export interface SpeakerLayoutOptions extends SpeakerShotOptions {
  /** Timeline range (µs) to lay out; default the whole clip. */
  from?: number;
  to?: number;
  names?: string[];
  effects?: Record<number, Effect[]>;
  dryRun?: boolean;
}

export interface SpeakerSummary {
  people: number;
  panels: SpeakerAnalysis['panels'];
  talkSeconds: number[];
  confidence: number;
  turns: number;
  sampleTurns: Array<{ person: number; start: number; end: number; text: string }>;
}

const doc = () => useProject.getState().doc!;
const dir = () => useProject.getState().dir ?? undefined;

function wordsFor(d: Project, mediaId: string) {
  const t = d.transcript?.find((x) => x.mediaId === mediaId);
  return t?.words ?? null;
}

/** Analyze who speaks in the clip's source between timeline times from and to. */
export async function analyzeClipSpeakers(clip: Clip, from?: number, to?: number): Promise<{ analysis: SpeakerAnalysis; srcFrom: number; srcTo: number; words: Array<{ text: string; start: number; end: number }>; samples: MouthSample[] }> {
  const d = doc();
  const media = d.media[clip.mediaId!]!;
  const words = wordsFor(d, clip.mediaId!);
  if (!words?.length) throw Object.assign(new Error('This clip has no transcript yet; speaker detection needs the words.'), { code: 'NO_TRANSCRIPT' });
  const a = Math.max(clip.start, from ?? clip.start), b = Math.min(clipEnd(clip), to ?? clipEnd(clip));
  if (b <= a) throw Object.assign(new Error('That range is outside the clip.'), { code: 'OUTSIDE_CLIP' });
  const srcFrom = clip.in + (a - clip.start), srcTo = clip.in + (b - clip.start);
  useShell.getState().toast('Watching lips to see who is talking (first run on a long video takes a few minutes)', 'info');
  const res = await invoke('video:speakers', { path: media.path, projectDir: dir() });
  const pad = 2e6;
  const samples = res.samples.filter((s) => s.t * 1e6 >= srcFrom - pad && s.t * 1e6 <= srcTo + pad);
  const ws = words.filter((w) => w.end > srcFrom && w.start < srcTo);
  return { analysis: analyzeSpeakers(samples, ws, { content: res.content }), srcFrom, srcTo, words: ws, samples };
}

export function summarize(a: SpeakerAnalysis, max = 12): SpeakerSummary {
  return {
    people: a.panels.length, panels: a.panels, talkSeconds: a.talk, confidence: a.confidence, turns: a.turns.length,
    sampleTurns: a.turns.filter((t) => t.end - t.start >= 1.5e6).slice(0, max).map((t) => ({ person: t.panel, start: t.start, end: t.end, text: t.text.length > 90 ? `${t.text.slice(0, 87)}...` : t.text })),
  };
}

/** Lay out speaker shots over a clip. Returns what it did (or would do, with dryRun). */
export async function speakerLayout(clipId: string, o: SpeakerLayoutOptions = {}) {
  const loc = findClip(doc(), clipId);
  if (!loc || loc.clip.kind !== 'media') throw Object.assign(new Error(`No video clip "${clipId}".`), { code: 'NOT_FOUND' });
  const { analysis, srcFrom, srcTo, words, samples } = await analyzeClipSpeakers(loc.clip, o.from, o.to);
  const shots = frameShots(planSpeakerShots(analysis, words, srcFrom, srcTo, o), samples, analysis);
  const d = doc();
  const r = speakerLayoutOps(d, clipId, { panels: analysis.panels, faces: analysis.faces, shots, names: o.names, effects: o.effects });
  const kinds = { solo: shots.filter((s) => s.kind === 'solo').length, all: shots.filter((s) => s.kind === 'all').length };
  const report = { ...summarize(analysis), shots: shots.length, closeShots: kinds.solo, sideBySide: kinds.all, clips: r.clips, applied: false };
  if (o.dryRun) return report;
  const ok = useProject.getState().apply(r.ops, `Speaker layout (${shots.length} shots)`);
  return { ...report, applied: ok !== false };
}

(globalThis as Record<string, unknown>).__directorSpeakers = { speakerLayout, analyzeClipSpeakers };
