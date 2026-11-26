import * as MediaLib from '@director/media';
import * as AnalysisLib from '@director/analysis';
import * as EngineLib from '@director/engine';
import { applyOps as applyOpsPure, type Op as OpT } from '@director/engine';
import { Player, frameStats } from '@director/media';

(globalThis as Record<string, unknown>).__directorMedia = { frameStats, lib: MediaLib };
(globalThis as Record<string, unknown>).__directorAnalysis = AnalysisLib;
(globalThis as Record<string, unknown>).__directorEngine = EngineLib;
(globalThis as Record<string, unknown>).__directorAnalysisApply = (doc: Project, ops: OpT[]) => applyOpsPure(doc, ops).doc;
import type { Project } from '@director/engine';
import { useProject } from '../project/store';
import { setEdit, getEdit } from './store';

let player: Player | null = null;
let canvas: HTMLCanvasElement | null = null;
let preparedVersion = -1;

/** One player for the app, bound to the preview canvas once it mounts. */
export function attachPlayer(c: HTMLCanvasElement): Player {
  if (player && canvas === c) return player;
  player?.dispose();
  canvas = c;
  player = new Player(c);
  player.scale = getEdit().previewScale;
  player.onTime((t, playing) => setEdit({ t, playing }));
  const doc = useProject.getState().doc;
  if (doc) void sync(doc);
  (globalThis as Record<string, unknown>).__directorPlayer = player;
  return player;
}

export function getPlayer(): Player | null { return player; }

async function sync(doc: Project): Promise<void> {
  if (!player) return;
  const v = useProject.getState().version;
  if (v !== preparedVersion) { preparedVersion = v; await player.prepare(doc).catch(() => undefined); }
  player.setDoc(doc);
}

useProject.subscribe((s, prev) => { if (s.doc && s.doc !== prev.doc) void sync(s.doc); });

export function seek(t: number): void {
  setEdit({ t: Math.max(0, t) });
  void player?.seek(Math.max(0, t));
}
export function togglePlay(): void { player?.toggle(); }
export function pause(): void { player?.pause(); }
