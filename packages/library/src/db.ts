import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/** Schema migrations, applied in order. Never edit a shipped entry; append a new one. */
const MIGRATIONS: string[] = [
  `CREATE TABLE brands (id TEXT PRIMARY KEY, name TEXT NOT NULL, color TEXT, created TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE refs (
     id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), hash TEXT NOT NULL, path TEXT NOT NULL,
     title TEXT NOT NULL, source_url TEXT, creator TEXT, platform TEXT, folder TEXT NOT NULL DEFAULT '', kit_id TEXT,
     duration_us INTEGER, width INTEGER, height INTEGER, size INTEGER,
     views INTEGER, likes INTEGER, comments INTEGER, shares INTEGER, posted TEXT,
     notes TEXT NOT NULL DEFAULT '', added TEXT NOT NULL, analysis TEXT, transcript TEXT, deleted_at TEXT,
     UNIQUE (brand_id, hash));
   CREATE TABLE ref_tags (ref_id TEXT NOT NULL REFERENCES refs(id) ON DELETE CASCADE, tag TEXT NOT NULL, PRIMARY KEY (ref_id, tag));
   CREATE TABLE kits (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL, created TEXT NOT NULL);
   CREATE TABLE voices (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL,
     description TEXT NOT NULL DEFAULT '', rules TEXT NOT NULL DEFAULT '[]', examples TEXT NOT NULL DEFAULT '[]', banned TEXT NOT NULL DEFAULT '[]',
     wpm INTEGER NOT NULL DEFAULT 160, updated TEXT NOT NULL, deleted_at TEXT);
   CREATE TABLE hooks (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]',
     score REAL, source TEXT NOT NULL DEFAULT 'manual', ref_id TEXT, created TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0, deleted_at TEXT);
   CREATE TABLE scripts (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), title TEXT NOT NULL, voice_id TEXT, ref_id TEXT,
     created TEXT NOT NULL, updated TEXT NOT NULL, deleted_at TEXT);
   CREATE TABLE script_versions (id TEXT PRIMARY KEY, script_id TEXT NOT NULL REFERENCES scripts(id) ON DELETE CASCADE, n INTEGER NOT NULL,
     text TEXT NOT NULL, wpm INTEGER NOT NULL, target_sec REAL, note TEXT NOT NULL DEFAULT '', created TEXT NOT NULL, UNIQUE (script_id, n));
   CREATE TABLE caption_presets (id TEXT PRIMARY KEY, brand_id TEXT NOT NULL REFERENCES brands(id), name TEXT NOT NULL, style TEXT NOT NULL, created TEXT NOT NULL);
   CREATE TABLE usage (id TEXT PRIMARY KEY, at TEXT NOT NULL, task TEXT NOT NULL, model TEXT NOT NULL, input INTEGER NOT NULL, output INTEGER NOT NULL,
     cache_read INTEGER NOT NULL, cache_write INTEGER NOT NULL, cost_usd REAL NOT NULL, brand_id TEXT);
   CREATE INDEX refs_brand ON refs(brand_id, deleted_at);
   CREATE INDEX hooks_brand ON hooks(brand_id, deleted_at);
   CREATE INDEX usage_at ON usage(at);`,
];

export type Row = Record<string, unknown>;

export class LibraryDb {
  readonly db: DatabaseSync;
  private now: () => string;
  constructor(path: string, now: () => string = () => new Date().toISOString()) { this.now = now;
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;');
    this.migrate();
  }
  private migrate(): void {
    const v = (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    for (let i = v; i < MIGRATIONS.length; i++) {
      this.tx(() => { this.db.exec(MIGRATIONS[i]!); this.db.exec(`PRAGMA user_version = ${i + 1}`); });
    }
  }
  get version(): number { return (this.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version; }
  stamp(): string { return this.now(); }
  id(prefix: string): string { return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 16)}`; }
  tx<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const r = fn(); this.db.exec('COMMIT'); return r; } catch (e) { this.db.exec('ROLLBACK'); throw e; }
  }
  all(sql: string, ...params: unknown[]): Row[] { return this.db.prepare(sql).all(...(params as never[])) as Row[]; }
  get(sql: string, ...params: unknown[]): Row | undefined { return this.db.prepare(sql).get(...(params as never[])) as Row | undefined; }
  run(sql: string, ...params: unknown[]): { changes: number } {
    const r = this.db.prepare(sql).run(...(params as never[]));
    return { changes: Number(r.changes) };
  }
  close(): void { this.db.close(); }
}

export class LibraryError extends Error {
  public code: string;
  constructor(message: string, code = 'LIBRARY') { super(message); this.code = code; }
}

export const json = <T>(v: unknown, fallback: T): T => { try { return v == null ? fallback : JSON.parse(String(v)) as T; } catch { return fallback; } };
