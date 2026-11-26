import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync, writeSync, readdirSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { applyOps, migrateProject, parseOps, validateProject, type Op, type Project } from '@director/engine';

/**
 * A project is a folder bundle:
 *   project.json   last full snapshot
 *   state.json     { seq } sequence number the snapshot includes
 *   journal.jsonl  one line per applied transaction after the snapshot: { seq, ops }
 *   cache/         derived data (safe to delete)
 */
export interface OpenResult { doc: Project; seq: number; recoveredOps: number; migratedFrom: number | null; droppedLines: number }

const PROJECT = 'project.json';
const STATE = 'state.json';
const JOURNAL = 'journal.jsonl';

export function isProjectDir(dir: string): boolean {
  return existsSync(join(dir, PROJECT));
}

function atomicWrite(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w');
  try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

export function createProjectBundle(dir: string, doc: Project): void {
  if (existsSync(join(dir, PROJECT))) throw Object.assign(new Error(`A project already exists at ${dir}`), { code: 'EXISTS' });
  mkdirSync(join(dir, 'cache'), { recursive: true });
  mkdirSync(join(dir, 'takes'), { recursive: true });
  atomicWrite(join(dir, PROJECT), JSON.stringify(doc, null, 1));
  atomicWrite(join(dir, STATE), JSON.stringify({ seq: 0 }));
  writeFileSync(join(dir, JOURNAL), '');
}

export function readJournal(dir: string): { entries: Array<{ seq: number; ops: Op[] }>; dropped: number } {
  const p = join(dir, JOURNAL);
  if (!existsSync(p)) return { entries: [], dropped: 0 };
  const lines = readFileSync(p, 'utf8').split('\n');
  const entries: Array<{ seq: number; ops: Op[] }> = [];
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    try {
      const raw = JSON.parse(line) as { seq: unknown; ops: unknown };
      const parsed = parseOps(raw.ops);
      if (typeof raw.seq !== 'number' || !parsed.ok) { dropped++; continue; }
      entries.push({ seq: raw.seq, ops: parsed.ops });
    } catch {
      dropped++; // torn final write after a crash
    }
  }
  return { entries, dropped };
}

/** Open a bundle, migrating old schemas and replaying any journal written after the last snapshot. */
export function openProjectBundle(dir: string): OpenResult {
  const raw = JSON.parse(readFileSync(join(dir, PROJECT), 'utf8'));
  const { project, from } = migrateProject(raw);
  const state = existsSync(join(dir, STATE)) ? (JSON.parse(readFileSync(join(dir, STATE), 'utf8')) as { seq: number }) : { seq: 0 };
  let doc = project;
  let seq = state.seq;
  let recovered = 0;
  const { entries, dropped } = readJournal(dir);
  for (const e of entries) {
    if (e.seq <= seq) continue;
    try {
      doc = applyOps(doc, e.ops).doc;
      seq = e.seq;
      recovered += e.ops.length;
    } catch {
      break; // stop at the first transaction that no longer applies
    }
  }
  return { doc, seq, recoveredOps: recovered, migratedFrom: from === project.schemaVersion ? null : from, droppedLines: dropped };
}

/** Live handle on an open bundle: journals every transaction durably and snapshots periodically. */
export class ProjectSession {
  readonly dir: string;
  doc: Project;
  seq: number;
  private savedSeq: number;
  private fd: number;
  private snapshotTimer: NodeJS.Timeout | null = null;

  private snapshotDelayMs: number;
  constructor(dir: string, opened: OpenResult, snapshotDelayMs = 2000) { this.snapshotDelayMs = snapshotDelayMs;
    this.dir = dir;
    this.doc = opened.doc;
    this.seq = opened.seq;
    this.savedSeq = opened.recoveredOps > 0 ? -1 : opened.seq;
    this.fd = openSync(join(dir, JOURNAL), 'a');
    if (opened.recoveredOps > 0 || opened.migratedFrom != null) this.snapshot();
  }

  get id(): string { return this.doc.id; }
  get dirty(): boolean { return this.savedSeq !== this.seq; }

  /** Durably record a transaction. Returns the new sequence number. */
  journal(ops: Op[], expectSeq?: number): number {
    if (expectSeq != null && expectSeq !== this.seq + 1) throw Object.assign(new Error(`journal out of order: expected ${this.seq + 1}, got ${expectSeq}`), { code: 'SEQ' });
    const next = applyOps(this.doc, ops).doc; // throws if the ops do not apply: never journal garbage
    const seq = this.seq + 1;
    writeSync(this.fd, JSON.stringify({ seq, ops }) + '\n');
    fsyncSync(this.fd);
    this.doc = next;
    this.seq = seq;
    this.scheduleSnapshot();
    return seq;
  }

  private scheduleSnapshot(): void {
    if (this.snapshotTimer) return;
    this.snapshotTimer = setTimeout(() => { this.snapshotTimer = null; this.snapshot(); }, this.snapshotDelayMs);
  }

  /** Write a full snapshot and compact the journal. */
  snapshot(): void {
    const problems = validateProject(this.doc);
    if (problems.length) throw Object.assign(new Error(`refusing to save an invalid project: ${problems.slice(0, 3).join('; ')}`), { code: 'INVALID' });
    const doc = { ...this.doc, updatedAt: new Date().toISOString() };
    atomicWrite(join(this.dir, PROJECT), JSON.stringify(doc, null, 1));
    atomicWrite(join(this.dir, STATE), JSON.stringify({ seq: this.seq }));
    closeSync(this.fd);
    atomicWrite(join(this.dir, JOURNAL), '');
    this.fd = openSync(join(this.dir, JOURNAL), 'a');
    this.savedSeq = this.seq;
  }

  close(): void {
    if (this.snapshotTimer) { clearTimeout(this.snapshotTimer); this.snapshotTimer = null; }
    if (this.dirty) this.snapshot();
    closeSync(this.fd);
  }
}

export function listProjects(parent: string): Array<{ dir: string; name: string; updatedAt: string }> {
  if (!existsSync(parent)) return [];
  const out: Array<{ dir: string; name: string; updatedAt: string }> = [];
  for (const entry of readdirSync(parent)) {
    const dir = join(parent, entry);
    try {
      if (!statSync(dir).isDirectory() || !isProjectDir(dir)) continue;
      const raw = JSON.parse(readFileSync(join(dir, PROJECT), 'utf8')) as { name?: string; updatedAt?: string };
      out.push({ dir, name: raw.name ?? basename(dir), updatedAt: raw.updatedAt ?? '' });
    } catch { /* skip unreadable */ }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
