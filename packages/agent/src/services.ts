import type { MediaRef, Project, Template } from '@director/engine';

/** Everything outside the pure project model that agent tools use. The desktop app implements it in the window. */
export interface AgentHost {
  info(): { app: string; version: string; mode: 'ask' | 'auto'; projectDir: string | null; workspace: string };
  state(): { playhead: number; playing: boolean; selection: string[]; inPoint: number | null; outPoint: number | null; workspace: string };
  history(): { undo: string[]; redo: string[]; agentSteps: number };
  undo(steps: number): number;
  redo(steps: number): number;
  revertAgentChanges(): { reverted: number };

  importMedia(paths: string[], role?: MediaRef['role']): Promise<{ added: MediaRef[]; existing: MediaRef[]; failed: Array<{ path: string; error: string }> }>;
  /** Transcribe speech media; returns per-media word counts. */
  transcribe(opts: { mediaIds?: string[]; force?: boolean; model?: string }): Promise<Array<{ mediaId: string; words: number; language: string }>>;
  processAudio(clipId: string, opts: { denoise?: boolean; enhance?: boolean }): Promise<boolean>;
  detectBeats(clipId: string): Promise<number>;
  autoReframe(clipId: string): Promise<boolean>;
  /** Who speaks when in a clip (lip movement), between timeline times. */
  detectSpeakers(clipId: string, fromUs?: number, toUs?: number): Promise<SpeakerReport>;
  /** Close shots of whoever is talking, side by side for quick exchanges, laid over the clip on Speakers lanes. */
  speakerLayout(clipId: string, opts: SpeakerLayoutRequest): Promise<SpeakerReport & { shots: number; closeShots: number; sideBySide: number; clips: number; applied: boolean }>;
  removeBackground(clipId: string): Promise<boolean>;
  stabilize(clipId: string, smoothing?: number): Promise<boolean>;

  renderFrame(tUs: number, width: number): Promise<{ png: Uint8Array; width: number; height: number }>;
  contactSheet(timesUs: number[], width: number, columns: number): Promise<{ png: Uint8Array; width: number; height: number }>;

  exportVideo(opts: { preset: string; fileName?: string; fromUs?: number; toUs?: number; loudness: boolean }): Promise<{ jobId: string; path: string }>;
  exportJobs(): Array<{ id: string; status: string; progress: number; path: string; error?: string; result?: unknown }>;
  cancelExport(jobId: string): Promise<boolean>;
  writeExportFile(fileName: string, kind: 'text' | 'image', data: string | Uint8Array): Promise<string>;
  exportDir(): Promise<string>;

  save(): Promise<void>;
  listProjects(): Promise<Array<{ dir: string; name: string; updatedAt: string }>>;
  openProject(dir: string): Promise<Project>;
  createProject(name: string, preset?: string, fps?: string): Promise<Project>;

  seek(tUs: number): void;
  play(): Promise<void>;
  pause(): void;
  select(clipIds: string[]): void;
  showWorkspace(id: string): void;

  /** Recorded takes for the open project (newest first). */
  listTakes(): Promise<Array<{ id: string; title: string; dir: string; createdAt: string; durationUs: number; rating: number; markers: number; hasScreen: boolean; hasScript: boolean }>>;
  /** Put a take on the timeline (camera, voice and screen in sync, markers, script). */
  addTake(dir: string): Promise<boolean>;
  templates(): Promise<Template[]>;
  saveTemplates(t: Template[]): Promise<void>;
  audioLibrary(): Promise<Array<{ path: string; name: string; folder: string; durationUs: number; kind: 'music' | 'sfx' }>>;
  /** Swipe library and scripts (brand-scoped calls into the shared library). */
  library(method: string, ...args: unknown[]): Promise<unknown>;
  activeBrand(): string | null;
}

export interface SpeakerReport {
  people: number;
  panels: Array<{ x: number; y: number; w: number; h: number }>;
  talkSeconds: number[];
  confidence: number;
  turns: number;
  sampleTurns: Array<{ person: number; start: number; end: number; text: string }>;
}
export interface SpeakerLayoutRequest {
  from?: number; to?: number; minShot?: number; maxShot?: number; punchIn?: number; splitOnExchange?: boolean; reactionEvery?: number; names?: string[]; dryRun?: boolean;
}
