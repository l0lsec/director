import { create } from 'zustand';
import { timelineDuration, exportFps, type Project } from '@director/engine';
import { AudioCache, MediaPool, buildMix, EXPORT_PRESETS, type ExportSpec, type MixedAudio } from '@director/media';
import { invoke } from '../../shell/bridge';
import { useShell } from '../../shell/store';

export interface ExportJob {
  id: string;
  name: string;
  preset: string;
  path: string;
  status: 'queued' | 'audio' | 'rendering' | 'finishing' | 'done' | 'error' | 'cancelled';
  progress: number;
  frames: number;
  startedAt: number;
  finishedAt?: number;
  error?: string;
  result?: { path: string; sizeBytes: number; loudness: { integrated: number; truePeak: number } | null; seconds: number };
  doc: Project;
  range?: { from: number; to: number };
  loudness: boolean;
}

interface QueueState { jobs: ExportJob[] }
export const useExports = create<QueueState>(() => ({ jobs: [] }));
const patch = (id: string, p: Partial<ExportJob>) => useExports.setState((s) => ({ jobs: s.jobs.map((j) => (j.id === id ? { ...j, ...p } : j)) }));

let running = false;
let current: { id: string; worker: Worker; exportId: string | null } | null = null;

/** Offline mix through the same audio graph as playback. */
export async function mixAudio(doc: Project, from: number, to: number): Promise<MixedAudio | null> {
  const seconds = Math.max(0.05, (to - from) / 1e6);
  const ctx = new OfflineAudioContext(2, Math.ceil(seconds * 48000), 48000);
  const cache = new AudioCache(new MediaPool(), (c, l, r) => new AudioBuffer({ numberOfChannels: c, length: l, sampleRate: r }));
  const nodes = await buildMix(ctx, doc, cache, { fromUs: from, toUs: to, startAt: 0 });
  if (!nodes.length) return null;
  const buf = await ctx.startRendering();
  return { channels: [buf.getChannelData(0).slice(), buf.getChannelData(1).slice()], sampleRate: 48000 };
}

export function enqueueExport(doc: Project, preset: string, path: string, opts: { range?: { from: number; to: number }; loudness?: boolean } = {}): string {
  const id = `exp_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const job: ExportJob = { id, name: doc.name, preset, path, status: 'queued', progress: 0, frames: 0, startedAt: Date.now(), doc: structuredClone(doc), range: opts.range, loudness: opts.loudness !== false };
  useExports.setState((s) => ({ jobs: [job, ...s.jobs] }));
  void pump();
  return id;
}

export async function cancelExport(id: string): Promise<void> {
  if (current?.id === id) {
    current.worker.postMessage({ type: 'cancel' });
  } else patch(id, { status: 'cancelled' });
}

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  try {
    for (;;) {
      const next = [...useExports.getState().jobs].reverse().find((j) => j.status === 'queued');
      if (!next) break;
      await runJob(next);
    }
  } finally { running = false; }
}

async function runJob(job: ExportJob): Promise<void> {
  const p = EXPORT_PRESETS[job.preset]!;
  const doc = job.doc;
  const from = job.range?.from ?? 0;
  const to = job.range?.to ?? timelineDuration(doc);
  // Match the project's aspect: presets set the long edge, the project decides the shape.
  const scale = Math.min(p.width / doc.canvas.width, p.height / doc.canvas.height);
  const spec: ExportSpec = { width: Math.round(doc.canvas.width * scale), height: Math.round(doc.canvas.height * scale), fps: exportFps(p.fps, doc.canvas.fps), codec: p.codec, videoBitrate: p.videoBitrate, audioBitrate: 192_000, fromUs: from, toUs: to };
  let exportId: string | null = null;
  try {
    patch(job.id, { status: 'audio' });
    const audio = await mixAudio(doc, from, to);
    const begun = await invoke('export:begin', { path: job.path });
    exportId = begun.id;
    patch(job.id, { status: 'rendering' });
    const worker = new Worker(new URL('./export.worker.ts', import.meta.url), { type: 'module' });
    current = { id: job.id, worker, exportId };
    const result = await new Promise<{ frames: number; seconds: number; codec: string; width: number; height: number }>((resolve, reject) => {
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data as { type: string; id?: number; position?: number; data?: Uint8Array<ArrayBuffer>; ratio?: number; frames?: number; result?: never; name?: string; message?: string };
        if (m.type === 'write') {
          void invoke('export:write', { id: exportId!, position: m.position!, data: m.data! }).then(() => worker.postMessage({ type: 'ack', ack: m.id })).catch((err: Error) => reject(err));
        } else if (m.type === 'progress') patch(job.id, { progress: m.ratio!, frames: m.frames! });
        else if (m.type === 'done') resolve(m.result!);
        else if (m.type === 'error') reject(Object.assign(new Error(m.message), { name: m.name }));
      };
      worker.onerror = (e) => reject(new Error(e.message));
      const transfer = audio ? audio.channels.map((c) => c.buffer) : [];
      worker.postMessage({ type: 'start', doc, spec, audio }, transfer);
    });
    worker.terminate();
    current = null;
    patch(job.id, { status: 'finishing', progress: 1 });
    const rec = await invoke('export:finish', { id: exportId, codec: result.codec as 'avc' | 'hevc', targetI: job.loudness ? -14 : null, truePeak: -1, audioBitrate: 192_000, record: { preset: job.preset, projectName: job.name, seconds: result.seconds, codec: result.codec, width: result.width, height: result.height } });
    patch(job.id, { status: 'done', finishedAt: Date.now(), result: { path: rec.path, sizeBytes: rec.sizeBytes, loudness: rec.loudness, seconds: rec.seconds } });
    useShell.getState().toast(`Exported ${rec.path.split('/').pop()}`, 'ok');
  } catch (err) {
    current?.worker.terminate();
    current = null;
    if (exportId) await invoke('export:cancel', { id: exportId }).catch(() => undefined);
    const e = err as Error;
    const cancelled = e.name === 'AbortError';
    patch(job.id, { status: cancelled ? 'cancelled' : 'error', error: cancelled ? undefined : e.message, finishedAt: Date.now() });
    if (!cancelled) useShell.getState().toast(`Export failed: ${e.message}`, 'error');
  }
}

(globalThis as Record<string, unknown>).__directorExport = { enqueueExport, cancelExport, jobs: () => useExports.getState().jobs.map(({ doc: _d, ...j }) => j), mixAudio };
