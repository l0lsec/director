import { create } from 'zustand';
import { History, type HistoryEntry, type Op, type Project } from '@director/engine';
import { invoke } from '../../shell/bridge';
import { useShell } from '../../shell/store';

interface ProjectState {
  doc: Project | null;
  dir: string | null;
  version: number; // bumps on every change so components can subscribe cheaply
  /** Counts every change (edit, undo, redo, open); agents use it to detect concurrent edits. */
  revision: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
  saving: boolean;
  lastError: string | null;
  create: (name: string, preset?: string, fps?: string) => Promise<Project>;
  open: (dir: string) => Promise<Project>;
  apply: (ops: Op[], label: string) => boolean;
  /** Apply and return the history entry (agents tag their entries). Throws on invalid ops. */
  applyEntry: (ops: Op[], label: string) => HistoryEntry;
  undo: () => void;
  redo: () => void;
  close: () => Promise<void>;
  flush: () => Promise<void>;
}

let history: History | null = null;
let seq = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Journal transactions in order; main applies and fsyncs each before acknowledging. */
function journal(projectId: string, ops: Op[]): void {
  if (!ops.length) return;
  const mySeq = ++seq;
  chain = chain
    .then(() => invoke('project:journal', { projectId, seq: mySeq, ops }))
    .catch((err: Error) => {
      useProject.setState({ lastError: err.message });
      useShell.getState().toast(`Could not save change: ${err.message}`, 'error');
    });
}

let revision = 0;
function sync(set: (p: Partial<ProjectState>) => void) {
  if (!history) return;
  set({
    revision: ++revision,
    doc: history.doc,
    version: Date.now() + Math.random(),
    canUndo: history.canUndo,
    canRedo: history.canRedo,
    undoLabel: history.undoLabel,
    redoLabel: history.redoLabel,
  });
}

export const useProject = create<ProjectState>((set, get) => ({
  doc: null,
  dir: null,
  version: 0,
  revision: 0,
  canUndo: false,
  canRedo: false,
  undoLabel: null,
  redoLabel: null,
  saving: false,
  lastError: null,
  async create(name, preset, fps) {
    const opened = await invoke('project:create', { name, preset, fps });
    history = new History(opened.doc);
    seq = opened.seq;
    set({ dir: opened.dir });
    sync(set);
    useShell.getState().setProjectName(opened.doc.name);
    void invoke('settings:set', { key: 'lastProjectDir', value: opened.dir });
    return opened.doc;
  },
  async open(dir) {
    const opened = await invoke('project:open', { dir });
    history = new History(opened.doc);
    seq = opened.seq;
    set({ dir: opened.dir });
    sync(set);
    useShell.getState().setProjectName(opened.doc.name);
    if (opened.recoveredOps > 0) useShell.getState().toast(`Recovered ${opened.recoveredOps} unsaved changes`, 'ok');
    void invoke('settings:set', { key: 'lastProjectDir', value: opened.dir });
    return opened.doc;
  },
  apply(ops, label) {
    if (!history || !ops.length) return false;
    try {
      history.apply(ops, label);
    } catch (err) {
      useShell.getState().toast(`${label} failed: ${(err as Error).message}`, 'error');
      return false;
    }
    journal(history.doc.id, ops);
    sync(set);
    return true;
  },
  applyEntry(ops, label) {
    if (!history) throw new Error('No project is open');
    const entry = history.apply(ops, label);
    if (!entry) throw new Error('Nothing to change');
    journal(history.doc.id, ops);
    sync(set);
    return entry;
  },
  undo() {
    if (!history) return;
    const e = history.undo();
    if (e) { journal(history.doc.id, e.inverses); sync(set); }
  },
  redo() {
    if (!history) return;
    const e = history.redo();
    if (e) { journal(history.doc.id, e.ops); sync(set); }
  },
  async flush() {
    await chain;
    const d = get().doc;
    if (d) { set({ saving: true }); await invoke('project:save', { projectId: d.id }); set({ saving: false }); }
  },
  async close() {
    const d = get().doc;
    await chain;
    if (d) await invoke('project:close', { projectId: d.id });
    history = null;
    set({ doc: null, dir: null, canUndo: false, canRedo: false });
    useShell.getState().setProjectName(null);
  },
}));

/** Make sure a project is open, creating one if needed. */
export async function ensureProject(name = 'Untitled reel'): Promise<Project> {
  const s = useProject.getState();
  if (s.doc) return s.doc;
  const last = (await invoke('settings:get', { key: 'lastProjectDir' })) as string | null;
  if (last && (await invoke('file:exists', { path: last }))) {
    try { return await s.open(last); } catch { /* fall through to create */ }
  }
  return s.create(name);
}

/** The live undo history (agents read labels and tag their entries). */
export function getHistory(): History | null { return history; }
/** Re-publish labels after an entry's label changed. */
export function refreshHistory(): void { sync(useProject.setState); }

(globalThis as Record<string, unknown>).__directorProject = () => ({ doc: useProject.getState().doc, dir: useProject.getState().dir, seq, canUndo: useProject.getState().canUndo, undoLabel: useProject.getState().undoLabel, revision: useProject.getState().revision });
(globalThis as Record<string, unknown>).__directorProjectApply = (ops: Op[], label: string) => useProject.getState().apply(ops, label);
(globalThis as Record<string, unknown>).__directorUndo = () => useProject.getState().undo();
(globalThis as Record<string, unknown>).__directorRedo = () => useProject.getState().redo();
