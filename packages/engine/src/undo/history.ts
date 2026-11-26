import type { Project } from '../schema/project';
import { applyOps, type Op } from '../ops/primitives';

export interface HistoryEntry { label: string; ops: Op[]; inverses: Op[]; at: number }

/** Linear undo/redo over transactions of primitive ops. */
export class History {
  doc: Project;
  private past: HistoryEntry[] = [];
  private future: HistoryEntry[] = [];
  private listeners = new Set<(doc: Project, entry: HistoryEntry | null, kind: 'do' | 'undo' | 'redo' | 'reset') => void>();
  private limit: number;
  constructor(doc: Project, limit = 1000) { this.limit = limit; this.doc = doc; }

  subscribe(fn: (doc: Project, entry: HistoryEntry | null, kind: 'do' | 'undo' | 'redo' | 'reset') => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private emit(entry: HistoryEntry | null, kind: 'do' | 'undo' | 'redo' | 'reset') { for (const l of this.listeners) l(this.doc, entry, kind); }

  apply(ops: Op[], label: string): HistoryEntry | null {
    if (ops.length === 0) return null;
    const { doc, inverses } = applyOps(this.doc, ops);
    this.doc = doc;
    const entry: HistoryEntry = { label, ops, inverses, at: Date.now() };
    this.past.push(entry);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.emit(entry, 'do');
    return entry;
  }

  undo(): HistoryEntry | null {
    const entry = this.past.pop();
    if (!entry) return null;
    this.doc = applyOps(this.doc, entry.inverses).doc;
    this.future.push(entry);
    this.emit(entry, 'undo');
    return entry;
  }

  redo(): HistoryEntry | null {
    const entry = this.future.pop();
    if (!entry) return null;
    this.doc = applyOps(this.doc, entry.ops).doc;
    this.past.push(entry);
    this.emit(entry, 'redo');
    return entry;
  }

  reset(doc: Project): void { this.doc = doc; this.past = []; this.future = []; this.emit(null, 'reset'); }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get undoLabel(): string | null { return this.past[this.past.length - 1]?.label ?? null; }
  get redoLabel(): string | null { return this.future[this.future.length - 1]?.label ?? null; }
  get depth(): number { return this.past.length; }
  /** Applied entries, oldest first (read-only view). */
  get applied(): readonly HistoryEntry[] { return this.past; }
  /** Undone entries that can be redone, next one last. */
  get undone(): readonly HistoryEntry[] { return this.future; }
}
