import { callTool, tools, type AgentContext, type AgentHost, type ApprovalRequest, type ToolResponse } from '@director/agent';
import { findClip, timelineDuration, type HistoryEntry, type MediaRef, type Op, type Template } from '@director/engine';
import { renderThumbnail } from '@director/media';
import { invoke, onEvent } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { lib, useBrand } from '../../shell/library';
import type { WorkspaceId } from '../../shell/workspaces';
import { useProject, getHistory, refreshHistory } from '../project/store';
import { getEdit, setEdit } from '../edit/store';
import { seek, togglePlay, pause as pausePlayer, getPlayer } from '../edit/player';
import { ensureTranscripts } from '../edit/transcript/transcripts';
import { processClipAudio, addBeatMarkers } from '../edit/audio/audioTools';
import { autoReframe, removeBackground, stabilize } from '../edit/advanced/VideoTools';
import { enqueueExport, cancelExport, useExports } from '../export/queue';
import { sendToEditor, type TakeEntry } from '../record/controller';
import { useAgent, logActivity, updateActivity, agentMode, type PendingApproval } from './store';

const DECISION_TIMEOUT_MS = 10 * 60_000;
/** History entries made by agents, so they can be reverted together. */
const agentEntries = new WeakSet<HistoryEntry>();

const toast = (m: string, k: 'ok' | 'info' | 'error' = 'info') => useShell.getState().toast(m, k);
const doc = () => useProject.getState().doc;
const projectDir = () => useProject.getState().dir ?? undefined;

/** Run fn and tag every history entry it adds as made by `client`. */
async function tagged<T>(client: string, fn: () => Promise<T> | T): Promise<T> {
  const h = getHistory();
  const before = new Set(h?.applied ?? []);
  try { return await fn(); } finally {
    const now = getHistory();
    let relabel = false;
    for (const e of now?.applied ?? []) if (!before.has(e) && !agentEntries.has(e)) {
      agentEntries.add(e);
      if (!e.label.startsWith(`${client}:`)) { e.label = `${client}: ${e.label}`.slice(0, 120); relabel = true; }
    }
    if (relabel) refreshHistory();
  }
}

function approve(client: string, req: ApprovalRequest): Promise<{ ok: boolean; reason?: string }> {
  if (agentMode() === 'auto' && !req.alwaysAsk) return Promise.resolve({ ok: true });
  return new Promise((resolve) => {
    const id = `ap_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    let done = false;
    const finish = (r: { ok: boolean; reason?: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      useAgent.setState((s) => ({ queue: s.queue.filter((q) => q.id !== id) }));
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, reason: 'No answer within 10 minutes. Nothing changed.' }), DECISION_TIMEOUT_MS);
    const p: PendingApproval = { ...req, id, client, at: Date.now(), resolve: finish };
    useAgent.setState((s) => ({ queue: [...s.queue, p] }));
  });
}

/** Undo every change agents made (newest first), as one new step that keeps the person's own edits. */
export function revertAgentChanges(): { reverted: number } {
  const h = getHistory();
  if (!h) return { reverted: 0 };
  const mine = h.applied.filter((e) => agentEntries.has(e));
  if (!mine.length) return { reverted: 0 };
  const ops: Op[] = [...mine].reverse().flatMap((e) => e.inverses);
  try { useProject.getState().applyEntry(ops, `Revert agent changes (${mine.length})`); } catch (e) {
    throw new Error(`Could not revert: your own edits changed the same clips (${(e as Error).message}). Undo step by step instead.`);
  }
  for (const e of mine) agentEntries.delete(e);
  return { reverted: mine.length };
}

async function renderPng(t: number, width: number): Promise<{ png: Uint8Array; width: number; height: number }> {
  const d = doc()!;
  const height = Math.max(2, Math.round((width * d.canvas.height) / d.canvas.width / 2) * 2);
  const blob = await renderThumbnail(d, Math.round(t), { width, height, format: 'png' });
  return { png: new Uint8Array(await blob.arrayBuffer()), width, height };
}

async function contactSheet(times: number[], width: number, columns: number) {
  const d = doc()!;
  const cols = Math.max(1, Math.min(columns, times.length));
  const cw = Math.floor(width / cols / 2) * 2;
  const ch = Math.max(2, Math.round((cw * d.canvas.height) / d.canvas.width / 2) * 2);
  const rows = Math.ceil(times.length / cols);
  const sheet = new OffscreenCanvas(cw * cols, ch * rows);
  const g = sheet.getContext('2d')!;
  g.fillStyle = '#111';
  g.fillRect(0, 0, sheet.width, sheet.height);
  for (let i = 0; i < times.length; i++) {
    const blob = await renderThumbnail(d, times[i]!, { width: cw, height: ch, format: 'png' });
    const bmp = await createImageBitmap(blob);
    const x = (i % cols) * cw, y = Math.floor(i / cols) * ch;
    g.drawImage(bmp, x, y, cw, ch);
    bmp.close();
    // Time label in the bottom-left corner of each cell.
    const label = `${(times[i]! / 1e6).toFixed(2)} s`;
    const fs = Math.max(11, Math.round(cw / 14));
    g.font = `600 ${fs}px Inter, system-ui, sans-serif`;
    const tw = g.measureText(label).width;
    g.fillStyle = 'rgba(0,0,0,0.7)';
    g.fillRect(x + 4, y + ch - fs - 12, tw + 10, fs + 8);
    g.fillStyle = '#fff';
    g.textBaseline = 'top';
    g.fillText(label, x + 9, y + ch - fs - 8);
  }
  const out = await sheet.convertToBlob({ type: 'image/png' });
  return { png: new Uint8Array(await out.arrayBuffer()), width: sheet.width, height: sheet.height };
}

async function exportPath(fileName: string): Promise<string> {
  const dir = (await invoke('export:defaultDir', {})).replace(/\/+$/, '');
  if (/[/\\]/.test(fileName) || fileName.includes('..') || fileName.startsWith('.')) throw new Error('File names cannot contain folders.');
  const dot = fileName.lastIndexOf('.');
  const stem = fileName.slice(0, dot), ext = fileName.slice(dot);
  let path = `${dir}/${fileName}`;
  for (let n = 2; await invoke('file:exists', { path }); n++) path = `${dir}/${stem} (${n})${ext}`;
  if (!path.startsWith(`${dir}/`)) throw new Error('Exports stay in the export folder.');
  return path;
}

const safeName = (s: string) => s.replace(/[^\w .()-]+/g, '_').replace(/^\.+/, '').slice(0, 120) || 'Director export';

function makeHost(client: string): AgentHost {
  return {
    info: () => ({ app: 'Director', version: '0.1.0', mode: agentMode(), projectDir: useProject.getState().dir, workspace: useShell.getState().workspace }),
    state: () => { const e = getEdit(); return { playhead: e.t, playing: !!getPlayer()?.isPlaying, selection: e.selection, inPoint: e.inPoint, outPoint: e.outPoint, workspace: useShell.getState().workspace }; },
    history: () => { const h = getHistory(); return { undo: [...(h?.applied ?? [])].reverse().slice(0, 50).map((e) => e.label), redo: [...(h?.undone ?? [])].reverse().slice(0, 50).map((e) => e.label), agentSteps: (h?.applied ?? []).filter((e) => agentEntries.has(e)).length }; },
    undo: (n) => { let k = 0; for (; k < n && useProject.getState().canUndo; k++) useProject.getState().undo(); return k; },
    redo: (n) => { let k = 0; for (; k < n && useProject.getState().canRedo; k++) useProject.getState().redo(); return k; },
    revertAgentChanges,
    fileRoots: () => invoke('files:roots', {}),
    listFolder: (dir) => invoke('files:list', { dir }),
    searchFolder: (dir, query, kind) => invoke('files:search', { dir, q: query, kinds: kind ? [kind] : undefined, limit: 300 }),
    importMedia: (paths, role) => tagged(client, async () => {
      const res = await invoke('media:import', { paths, projectDir: projectDir(), role });
      const d = doc()!;
      const byHash = new Map(Object.values(d.media).map((m) => [m.hash, m]));
      const added: MediaRef[] = [], existing: MediaRef[] = [], failed: Array<{ path: string; error: string }> = [];
      const ops: Op[] = [];
      for (const r of res) {
        if (!r.ok) { failed.push({ path: r.path, error: r.error }); continue; }
        const have = byHash.get(r.media.hash);
        if (have) { existing.push(have); continue; }
        byHash.set(r.media.hash, r.media);
        ops.push({ op: 'addMedia', media: r.media });
        added.push(r.media);
      }
      // Paths the importer skipped silently (not media, or an empty folder) are reported too.
      const seen = res.map((r) => (r.ok ? r.media.path : r.path));
      for (const p of paths) if (!seen.some((x) => x === p || x.startsWith(`${p.replace(/\/+$/, '')}/`))) failed.push({ path: p, error: 'Not a video, audio or image file (or a folder with none)' });
      if (ops.length) useProject.getState().applyEntry(ops, `Import ${ops.length} item${ops.length > 1 ? 's' : ''}`);
      return { added, existing, failed };
    }),
    transcribe: (o) => tagged(client, async () => {
      await ensureTranscripts({ force: o.force, model: o.model, only: o.mediaIds });
      return (doc()!.transcript ?? []).filter((t) => !o.mediaIds?.length || o.mediaIds.includes(t.mediaId)).map((t) => ({ mediaId: t.mediaId, words: t.words.length, language: t.language }));
    }),
    processAudio: (id, o) => tagged(client, () => processClipAudio(findClip(doc()!, id)!.clip, o)),
    detectBeats: (id) => tagged(client, () => addBeatMarkers(findClip(doc()!, id)!.clip)),
    autoReframe: (id) => tagged(client, () => autoReframe(findClip(doc()!, id)!.clip)),
    detectSpeakers: async (id, from, to) => { const { analyzeClipSpeakers, summarize } = await import('../edit/advanced/speakers'); return summarize((await analyzeClipSpeakers(findClip(doc()!, id)!.clip, from, to)).analysis); },
    speakerLayout: async (id, o) => { const { speakerLayout } = await import('../edit/advanced/speakers'); return tagged(client, () => speakerLayout(id, o)); },
    removeBackground: (id) => tagged(client, () => removeBackground(findClip(doc()!, id)!.clip)),
    stabilize: (id, s) => tagged(client, () => stabilize(findClip(doc()!, id)!.clip, s)),
    renderFrame: renderPng,
    contactSheet,
    exportVideo: async (o) => {
      const d = doc()!;
      const path = await exportPath(o.fileName ?? `${safeName(d.name)}.mp4`);
      const jobId = enqueueExport(d, o.preset, path, { range: o.fromUs != null || o.toUs != null ? { from: o.fromUs ?? 0, to: o.toUs ?? timelineDuration(d) } : undefined, loudness: o.loudness });
      return { jobId, path };
    },
    exportJobs: () => useExports.getState().jobs.map((j) => ({ id: j.id, status: j.status, progress: Math.round(j.progress * 1000) / 1000, path: j.path, ...(j.error ? { error: j.error } : {}), ...(j.result ? { result: { sizeBytes: j.result.sizeBytes, seconds: j.result.seconds, loudness: j.result.loudness } } : {}) })),
    cancelExport: async (id) => { if (!useExports.getState().jobs.some((j) => j.id === id)) return false; await cancelExport(id); return true; },
    writeExportFile: async (name, kind, data) => {
      const path = await exportPath(name);
      if (kind === 'text') await invoke('file:writeText', { path, text: data as string });
      else await invoke('file:writeImage', { path, data: new Uint8Array(data as Uint8Array) });
      return path;
    },
    exportDir: () => invoke('export:defaultDir', {}),
    save: () => useProject.getState().flush(),
    listProjects: () => invoke('project:list', {}),
    openProject: async (dir) => useProject.getState().open(dir),
    createProject: async (name, preset, fps) => { const r = await invoke('project:create', { name, preset: preset ?? 'vertical-1080', fps }); return useProject.getState().open(r.dir); },
    seek: (t) => { pausePlayer(); seek(t); },
    play: async () => { if (!getPlayer()?.isPlaying) togglePlay(); },
    pause: () => pausePlayer(),
    select: (ids) => setEdit({ selection: ids }),
    showWorkspace: (id) => useShell.getState().setWorkspace(id as WorkspaceId),
    listTakes: async () => {
      const list = await invoke('take:list', { projectDir: projectDir() });
      return list.filter((e) => e.take.status === 'ok').map((e) => ({ id: e.take.id, title: e.take.title, dir: e.dir, createdAt: e.take.createdAt, durationUs: e.take.durationUs, rating: e.take.rating, markers: e.take.markers.filter((m) => m.kind === 'retake' || m.kind === 'cue').length, hasScreen: !!e.take.files.screen, hasScript: !!e.take.script?.text }));
    },
    addTake: (dir) => tagged(client, async () => {
      const list = await invoke('take:list', { projectDir: projectDir() });
      const entry = list.find((e) => e.dir === dir) as TakeEntry | undefined;
      return entry ? sendToEditor(entry) : false;
    }),
    templates: async () => ((await invoke('settings:get', { key: 'templates' })) as Template[] | null) ?? [],
    saveTemplates: async (t) => { await invoke('settings:set', { key: 'templates', value: t }); },
    audioLibrary: () => invoke('audiolib:scan', {}),
    library: (method, ...args) => lib(method as never, ...(args as never[])) as Promise<unknown>,
    activeBrand: () => useBrand.getState().activeId,
  };
}

/** Paths a call names (LUT files) checked up front, since tool planning is synchronous. */
async function existingPaths(args: unknown): Promise<Set<string>> {
  const found = new Set<string>();
  const walk = async (x: unknown): Promise<void> => {
    if (typeof x === 'string' && x.startsWith('/') && x.length < 4096) { if (await invoke('file:exists', { path: x })) found.add(x); }
    else if (Array.isArray(x)) for (const y of x) await walk(y);
    else if (x && typeof x === 'object') for (const y of Object.values(x)) await walk(y);
  };
  await walk(args);
  return found;
}

export async function makeContext(client: string, args: unknown): Promise<AgentContext> {
  const host = makeHost(client);
  const [templates, paths] = await Promise.all([host.templates(), existingPaths(args)]);
  const ctx: AgentContext = {
    client,
    getDoc: doc,
    revision: () => useProject.getState().revision,
    apply(ops, label) {
      const entry = useProject.getState().applyEntry(ops, label);
      agentEntries.add(entry);
      return useProject.getState().revision;
    },
    approve: (req) => approve(client, req),
    env: { templates, fileExists: (p) => paths.has(p) },
    host,
  };
  return ctx;
}

/** Execute one forwarded tool call and log it in the activity panel. */
export async function runAgentCall(client: string, tool: string, args: unknown): Promise<ToolResponse> {
  const def = tools().get(tool);
  const id = `act_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const started = performance.now();
  logActivity({ id, client, tool, kind: def?.access ?? 'read', status: 'running', summary: def?.title ?? tool, at: Date.now() });
  let waiting = false;
  const unsub = useAgent.subscribe((s) => {
    if (waiting || !s.queue.some((q) => q.client === client && q.tool === tool)) return;
    waiting = true;
    updateActivity(id, { status: 'waiting' });
  });
  let res: ToolResponse;
  try {
    const ctx = await makeContext(client, args);
    res = await callTool(ctx, tool, args);
  } catch (e) { res = { ok: false, error: { code: 'FAILED', message: (e as Error).message } }; }
  unsub();
  const data = res.ok ? (res.data as Record<string, unknown> | null) : null;
  const status = !res.ok ? 'error' : data?.rejected ? 'rejected' : data?.applied === true ? 'applied' : 'done';
  const summary = !res.ok ? res.error.message : typeof data?.summary === 'string' ? data.summary : def?.title ?? tool;
  updateActivity(id, { status, summary: summary.slice(0, 200), ms: Math.round(performance.now() - started), ...(res.ok ? {} : { error: res.error.message.slice(0, 300) }) });
  if (status === 'applied' && agentMode() === 'auto') toast(`${client}: ${summary.slice(0, 80)}`, 'info');
  return res;
}
