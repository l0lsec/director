import { create } from 'zustand';
import { parseScript, estimateSeconds, WpmScroller, cuesCrossed, takeToOps, formatDuration, type ParsedScript, type Take, type MediaRef } from '@director/engine';
import { SpeechFollower } from '@director/analysis';
import { invoke, onEvent } from '../../shell/bridge';
import { useShell } from '../../shell/store';
import { useProject, ensureProject } from '../project/store';
import { tapAudio, type AudioTap } from './capture/audio';
import { TakeRecorder } from './capture/recorder';
import { DEFAULT_PROMPTER, type PrompterSettings, type PrompterState } from './prompter/types';

export type ScrollMode = 'follow' | 'wpm' | 'manual';
export type Phase = 'idle' | 'countdown' | 'recording' | 'stopping';

export interface DeviceOption { id: string; label: string }
export interface TakeEntry { take: Take; dir: string }

interface RecordState {
  scriptText: string;
  /** The Script studio version this text came from; cleared when the text is edited here. */
  scriptRef: { scriptId: string; version: number; title?: string } | null;
  script: ParsedScript;
  wpm: number;
  mode: ScrollMode;
  prompter: PrompterSettings;
  prompterOpen: boolean;
  windowMode: 'overlay' | 'display' | 'glass';
  cursor: number;
  playing: boolean;
  phase: Phase;
  countdown: number | null;
  cameras: DeviceOption[];
  mics: DeviceOption[];
  cameraId: string;
  micId: string;
  resolution: '720p' | '1080p' | '4k' | 'vertical';
  fps: number;
  screenOn: boolean;
  displayId: number | null;
  stream: MediaStream | null;
  level: number;
  elapsedUs: number;
  takes: TakeEntry[];
  overlays: { safe: boolean; thirds: boolean; eyeline: boolean };
  error: string | null;
  countdownSeconds: number;
  audioOffsetMs: number;
}

const initialScript = `[HOOK] Stop typing plain prompts into Claude.
Ask me questions before you answer.
[ZOOM] Give me three options and pick the best one.
Write this for a busy owner who reads on their phone.
[PAUSE]
[CTA] Save this before your next prompt.`;

export const useRecord = create<RecordState>(() => ({
  scriptText: initialScript,
  scriptRef: null,
  script: parseScript(initialScript),
  wpm: 160,
  mode: 'follow',
  prompter: DEFAULT_PROMPTER,
  prompterOpen: false,
  windowMode: 'overlay',
  cursor: 0,
  playing: false,
  phase: 'idle',
  countdown: null,
  cameras: [],
  mics: [],
  cameraId: '',
  micId: '',
  resolution: '1080p',
  fps: 30,
  screenOn: false,
  displayId: null,
  stream: null,
  level: 0,
  elapsedUs: 0,
  takes: [],
  overlays: { safe: true, thirds: false, eyeline: true },
  error: null,
  countdownSeconds: 3,
  audioOffsetMs: 0,
}));

const set = useRecord.setState;
const get = useRecord.getState;

let tap: AudioTap | null = null;
let follower: SpeechFollower | null = null;
let scroller: WpmScroller | null = null;
let recorder: TakeRecorder | null = null;
let following = false;
let raf = 0;
let lastTick = 0;
let unsub: Array<() => void> = [];
let publishPending = false;

const RES: Record<RecordState['resolution'], { width: number; height: number }> = {
  '720p': { width: 1280, height: 720 }, '1080p': { width: 1920, height: 1080 }, '4k': { width: 3840, height: 2160 }, vertical: { width: 1080, height: 1920 },
};

export function prompterState(): PrompterState {
  const s = get();
  return {
    lines: s.script.lines.map((l) => ({ text: l.text, firstWord: l.firstWord, wordCount: l.wordCount, cues: l.cues.map((c) => ({ kind: c.kind, label: c.label, wordIndex: c.wordIndex })) })),
    words: s.script.words.map((w) => w.text),
    cursor: s.cursor,
    settings: s.prompter,
    mode: s.mode,
    playing: s.playing,
    recording: s.phase === 'recording',
    countdown: s.countdown,
    elapsed: formatDuration(s.elapsedUs),
    windowMode: s.windowMode,
  };
}

/** Push state to the prompter window at most once per frame. */
function publish(): void {
  if (publishPending) return;
  publishPending = true;
  requestAnimationFrame(() => {
    publishPending = false;
    if (get().prompterOpen) void invoke('prompter:update', { state: prompterState() });
  });
}
useRecord.subscribe((s, prev) => {
  if (s.cursor !== prev.cursor || s.prompter !== prev.prompter || s.script !== prev.script || s.mode !== prev.mode || s.playing !== prev.playing || s.phase !== prev.phase || s.countdown !== prev.countdown || Math.floor(s.elapsedUs / 1e6) !== Math.floor(prev.elapsedUs / 1e6)) publish();
});

async function persist(key: string, value: unknown) { try { await invoke('settings:set', { key: `record.${key}`, value }); } catch { /* non-fatal */ } }

export async function initRecord(): Promise<void> {
  const keys = ['scriptText', 'scriptRef', 'wpm', 'mode', 'prompter', 'cameraId', 'micId', 'resolution', 'fps', 'windowMode', 'overlays', 'countdownSeconds', 'audioOffsetMs'] as const;
  const patch: Partial<RecordState> = {};
  for (const k of keys) {
    const v = await invoke('settings:get', { key: `record.${k}` });
    if (v != null) (patch as Record<string, unknown>)[k] = k === 'prompter' ? { ...DEFAULT_PROMPTER, ...(v as object) } : v;
  }
  if (patch.scriptText) patch.script = parseScript(patch.scriptText);
  set(patch);
  if (!unsub.length) {
    unsub.push(onEvent('follow:event', (e) => onFollowEvent(e)));
    unsub.push(onEvent('hotkey', (e) => handleKey(e.key)));
    unsub.push(onEvent('prompter:command', (c) => {
      if (c.command.startsWith('key:')) handleKey(c.command.slice(4));
      else if (c.command === 'ready') publish();
      else if (c.command === 'nudge') nudge(c.value ?? 0);
      else if (c.command === 'closed') set({ prompterOpen: false });
    }));
  }
  await refreshDevices();
  await refreshTakes();
}

export async function refreshDevices(): Promise<void> {
  try {
    const list = await navigator.mediaDevices.enumerateDevices();
    const cameras = list.filter((d) => d.kind === 'videoinput').map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
    const mics = list.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'communications').map((d, i) => ({ id: d.deviceId, label: d.deviceId === 'default' ? `System default${d.label ? ` (${d.label.replace(/^Default - /, '')})` : ''}` : d.label || `Microphone ${i + 1}` }));
    const s = get();
    set({ cameras, mics, cameraId: cameras.some((c) => c.id === s.cameraId) ? s.cameraId : cameras[0]?.id ?? '', micId: mics.some((m) => m.id === s.micId) ? s.micId : mics[0]?.id ?? '' });
  } catch (err) {
    set({ error: `Could not list devices: ${(err as Error).message}` });
  }
}

let previewInFlight: Promise<void> | null = null;
/** Start the camera preview unless one is running or already starting (never restarts a live preview). */
export function ensurePreview(): Promise<void> {
  if (get().stream?.getVideoTracks().some((t) => t.readyState === 'live')) return Promise.resolve();
  return previewInFlight ?? startPreview();
}

export function startPreview(): Promise<void> {
  const p = openPreview().finally(() => { if (previewInFlight === p) previewInFlight = null; });
  previewInFlight = p;
  return p;
}

async function openPreview(): Promise<void> {
  stopPreview();
  const s = get();
  const r = RES[s.resolution];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { deviceId: s.cameraId ? { exact: s.cameraId } : undefined, width: { ideal: r.width }, height: { ideal: r.height }, frameRate: { ideal: s.fps } },
      audio: { deviceId: s.micId ? { exact: s.micId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 48000, channelCount: 1 },
    });
    tap = await tapAudio(stream, (pcm, rms) => {
      if (following) void invoke('follow:audio', { data: new Uint8Array(pcm.buffer as ArrayBuffer, pcm.byteOffset, pcm.byteLength) });
      set({ level: rms });
    });
    set({ stream, error: null });
    if (!get().cameras.some((c) => c.label && !c.label.startsWith('Camera '))) await refreshDevices();
  } catch (err) {
    const e = err as Error;
    set({ error: e.name === 'NotAllowedError' ? 'Camera or microphone access was denied. Allow Director in System Settings > Privacy & Security, then try again.' : `Camera error: ${e.message}` });
  }
}

export function stopPreview(): void {
  tap?.stop();
  tap = null;
  get().stream?.getTracks().forEach((t) => t.stop());
  set({ stream: null, level: 0 });
}

export function setScript(text: string, ref: RecordState['scriptRef'] = null): void {
  set({ scriptText: text, script: parseScript(text), cursor: 0, scriptRef: ref });
  void persist('scriptText', text);
  void persist('scriptRef', ref);
}

export function updatePrompter(patch: Partial<PrompterSettings>): void {
  const prompter = { ...get().prompter, ...patch };
  set({ prompter });
  void persist('prompter', prompter);
}

export function setOption<K extends 'wpm' | 'mode' | 'cameraId' | 'micId' | 'resolution' | 'fps' | 'windowMode' | 'overlays' | 'screenOn' | 'displayId' | 'countdownSeconds' | 'audioOffsetMs'>(k: K, v: RecordState[K]): void {
  set({ [k]: v } as Partial<RecordState>);
  void persist(k, v);
  if (k === 'cameraId' || k === 'micId' || k === 'resolution' || k === 'fps') if (get().stream) void startPreview();
  if (k === 'wpm' && scroller) scroller.wpm = v as number;
}

export async function openPrompter(windowMode = get().windowMode): Promise<void> {
  await invoke('prompter:open', { mode: windowMode });
  set({ prompterOpen: true, windowMode });
  setTimeout(publish, 300);
}

export async function closePrompter(): Promise<void> {
  await invoke('prompter:close', {});
  set({ prompterOpen: false });
}

export function estimate(): string {
  const s = get();
  return formatDuration(estimateSeconds(s.script, s.wpm) * 1e6);
}

function moveCursor(next: number, recordAlign = false): void {
  const s = get();
  const clamped = Math.max(0, Math.min(s.script.wordCount, next));
  if (recorder && get().phase === 'recording') {
    for (const c of cuesCrossed(s.script, s.cursor, clamped)) recorder.mark('cue', `${c.kind.toUpperCase()}${c.label && c.label.toUpperCase() !== c.kind.toUpperCase() ? `: ${c.label}` : ''}`, { line: c.line, wordIndex: c.wordIndex });
    if (recordAlign) recorder.align(Math.floor(clamped));
  }
  set({ cursor: clamped });
}

function onFollowEvent(e: { type: string; text?: string; rms?: number; recvMs: number; error?: string }): void {
  if (!follower || get().mode !== 'follow' || !get().playing) return;
  if (e.error) { useShell.getState().toast(`Voice follow: ${e.error}`, 'error'); return; }
  const st = follower.push(e as never, e.recvMs / 1000);
  if (st) moveCursor(st.cursor, st.confirmed === st.cursor);
}

function tick(t: number): void {
  const dt = lastTick ? (t - lastTick) / 1000 : 0;
  lastTick = t;
  const s = get();
  if (s.playing && s.mode === 'wpm' && scroller) moveCursor(scroller.tick(dt), true);
  if (recorder && s.phase === 'recording') set({ elapsedUs: recorder.elapsedUs });
  raf = requestAnimationFrame(tick);
}

function ensureTicker(): void { if (!raf) { lastTick = 0; raf = requestAnimationFrame(tick); } }

export async function startFollowing(): Promise<void> {
  follower = new SpeechFollower(get().script);
  follower.aligner.reset(Math.floor(get().cursor));
  scroller = new WpmScroller(get().script, get().wpm);
  scroller.seekWord(get().cursor);
  if (get().mode === 'follow') { await invoke('follow:start', {}); following = true; }
  set({ playing: true });
  ensureTicker();
}

export async function stopFollowing(): Promise<void> {
  following = false;
  set({ playing: false });
  await invoke('follow:stop', {});
}

/** Rehearse without recording. */
export async function togglePlay(): Promise<void> {
  if (get().playing) await stopFollowing(); else await startFollowing();
}

function lineStartOf(cursor: number): { line: number; first: number } {
  const s = get().script;
  const w = s.words[Math.min(Math.floor(cursor), s.wordCount - 1)];
  const line = w ? w.line : 0;
  const l = s.lines.find((x) => x.index === line);
  return { line, first: l?.firstWord ?? 0 };
}

function nudge(words: number): void {
  moveCursor(get().cursor + words);
  follower?.aligner.reset(Math.floor(get().cursor));
  scroller?.seekWord(get().cursor);
}

function moveLine(delta: number): void {
  const s = get().script;
  const { line } = lineStartOf(get().cursor);
  const spoken = s.lines.filter((l) => l.wordCount > 0);
  const idx = Math.max(0, Math.min(spoken.length - 1, spoken.findIndex((l) => l.index === line) + delta));
  const target = spoken[idx];
  if (!target) return;
  moveCursor(target.firstWord);
  follower?.retakeLine(target.index);
  scroller?.seekWord(target.firstWord);
}

/** Shared hotkey handling for the studio window, the prompter window and global shortcuts. */
export function handleKey(key: string): void {
  const s = get();
  const k = key === ' ' ? 'Space' : key.length === 1 ? key.toUpperCase() : key.replace(/^Arrow/, '');
  (globalThis as Record<string, unknown>).__directorLastKey = k;
  switch (k) {
    case 'Space': void togglePlay(); break;
    case 'Up': if (s.mode === 'wpm') setOption('wpm', Math.min(320, s.wpm + 10)); else moveLine(-1); break;
    case 'Down': if (s.mode === 'wpm') setOption('wpm', Math.max(60, s.wpm - 10)); else moveLine(1); break;
    case 'R': {
      const { line, first } = lineStartOf(s.cursor);
      recorder?.mark('retake', `Retake line ${line + 1}`, { line, wordIndex: first });
      moveCursor(first);
      follower?.retakeLine(line);
      scroller?.seekWord(first);
      break;
    }
    case 'M': recorder?.mark('note', 'Marker', { wordIndex: Math.floor(s.cursor) }); break;
    case 'G': case 'B': {
      const { line } = lineStartOf(Math.max(0, s.cursor - 1));
      recorder?.mark(k === 'G' ? 'good' : 'bad', `${k === 'G' ? 'Good' : 'Bad'} line ${line + 1}`, { line });
      break;
    }
    case 'Escape': if (s.phase === 'recording') void stopRecording(); else if (s.phase === 'countdown') cancelCountdown = true; break;
    default: return;
  }
  useShell.getState().toast(k === 'R' ? 'Retake: back to line start' : k === 'M' ? 'Marker added' : k === 'G' ? 'Marked good' : k === 'B' ? 'Marked bad' : `${k}`, 'info');
}

let cancelCountdown = false;

export async function startRecording(): Promise<void> {
  const s = get();
  if (s.phase !== 'idle') return;
  if (!s.stream) await startPreview();
  const stream = get().stream;
  if (!stream) return;
  set({ phase: 'countdown', cursor: 0 });
  cancelCountdown = false;
  // The listener starts with the countdown so recognition is warm by the first word.
  following = false;
  if (get().mode === 'follow') { await invoke('follow:start', {}); following = true; }
  for (let n = get().countdownSeconds; n > 0; n--) {
    if (cancelCountdown) { set({ phase: 'idle', countdown: null }); await invoke('follow:stop', {}); following = false; return; }
    set({ countdown: n });
    await new Promise((r) => setTimeout(r, 1000));
  }
  set({ countdown: null });
  const vt = stream.getVideoTracks()[0];
  const at = stream.getAudioTracks()[0];
  const vs = vt?.getSettings() ?? {};
  // A stream that just opened can refuse a MediaRecorder for a moment; try once more before giving up.
  const begin = async (attempt: number): Promise<void> => {
    recorder = new TakeRecorder();
    recorder.audioOffsetUs = Math.round(get().audioOffsetMs * 1000);
    try { await startTake(stream, vt, at, vs); } catch (err) {
      if (attempt === 0 && /MediaRecorder/.test((err as Error).message)) { await new Promise((r) => setTimeout(r, 400)); return begin(1); }
      throw err;
    }
  };
  try {
    await begin(0);
  } catch (err) {
    set({ phase: 'idle', error: `Could not start recording: ${(err as Error).message}` });
    await invoke('follow:stop', {});
    return;
  }
  follower = new SpeechFollower(get().script);
  scroller = new WpmScroller(get().script, get().wpm);
  set({ phase: 'recording', playing: true, elapsedUs: 0 });
  await invoke('hotkeys:arm', { on: true });
  ensureTicker();
}

async function startTake(stream: MediaStream, vt: MediaStreamTrack | undefined, at: MediaStreamTrack | undefined, vs: MediaTrackSettings): Promise<void> {
  const project = useProject.getState();
  {
    await recorder!.start({
      stream,
      title: get().script.lines[0]?.text.split(' ').slice(0, 6).join(' ') || 'Take',
      projectDir: project.dir,
      projectId: project.doc?.id,
      script: { text: get().scriptText, ...(get().scriptRef ? { scriptId: get().scriptRef!.scriptId, version: get().scriptRef!.version } : {}) },
      devices: {
        camera: vt ? { id: vt.getSettings().deviceId ?? '', label: vt.label, width: vs.width ?? 0, height: vs.height ?? 0, fps: vs.frameRate ?? 0 } : undefined,
        mic: at ? { id: at.getSettings().deviceId ?? '', label: at.label } : undefined,
      },
      screen: get().screenOn ? { displayId: get().displayId ?? undefined } : null,
    });
  }
}

export async function stopRecording(): Promise<TakeEntry | null> {
  if (get().phase !== 'recording' || !recorder) return null;
  set({ phase: 'stopping', playing: false });
  await invoke('hotkeys:arm', { on: false });
  following = false;
  void invoke('follow:stop', {});
  try {
    const res = await recorder.stop();
    recorder = null;
    set({ phase: 'idle' });
    useShell.getState().toast(`Saved take: ${res.take.title}`, 'ok');
    await refreshTakes();
    return res;
  } catch (err) {
    set({ phase: 'idle', error: (err as Error).message });
    return null;
  }
}

export async function refreshTakes(): Promise<void> {
  const dir = useProject.getState().dir;
  const takes = await invoke('take:list', { projectDir: dir ?? undefined });
  set({ takes });
}

async function mediaRefFor(path: string, role: MediaRef['role'], takeId: string): Promise<MediaRef> {
  const [res] = await invoke('media:import', { paths: [path], projectDir: useProject.getState().dir ?? undefined, role });
  if (!res || !res.ok) throw new Error(res && !res.ok ? res.error : `could not import ${path}`);
  return { ...res.media, takeId, role };
}

/** Put a take on the timeline (camera, voice and screen lanes in sync) and switch to Edit. */
export async function sendToEditor(entry: TakeEntry): Promise<boolean> {
  const doc = await ensureProject(entry.take.title);
  const cameraPath = `${entry.dir}/${entry.take.files.camera}`;
  const camera = await mediaRefFor(cameraPath, 'camera', entry.take.id);
  const screen = entry.take.files.screen ? await mediaRefFor(`${entry.dir}/${entry.take.files.screen}`, 'screen', entry.take.id) : undefined;
  const ops = takeToOps(useProject.getState().doc ?? doc, entry.take, { camera, screen });
  const ok = useProject.getState().apply(ops, `Add take "${entry.take.title}"`);
  if (ok) useShell.getState().setWorkspace('edit');
  return ok;
}

export async function rateTake(entry: TakeEntry, rating: number): Promise<void> { await invoke('take:update', { dir: entry.dir, patch: { rating } }); await refreshTakes(); }
export async function renameTake(entry: TakeEntry, title: string): Promise<void> { await invoke('take:update', { dir: entry.dir, patch: { title } }); await refreshTakes(); }
export async function trashTake(entry: TakeEntry): Promise<void> { await invoke('take:update', { dir: entry.dir, patch: { status: 'trashed' } }); await refreshTakes(); }
export async function restoreTake(entry: TakeEntry): Promise<void> { await invoke('take:update', { dir: entry.dir, patch: { status: 'ok' } }); await refreshTakes(); }

(globalThis as Record<string, unknown>).__directorRecord = { get, ensurePreview, startRecording, stopRecording, sendToEditor, handleKey, openPrompter, closePrompter, setScript, setOption, startPreview, refreshTakes, trashTake, restoreTake, rateTake, renameTake, prompterState };
