import { LibraryDb } from './db';

export interface UsageRecord { task: string; model: string; input: number; output: number; cacheRead: number; cacheWrite: number; costUsd: number; brandId?: string | null; at?: string }
export interface UsageSummary { calls: number; costUsd: number; byTask: Array<{ task: string; calls: number; costUsd: number }>; input: number; output: number }

/** Persistent log of Claude usage for the cost meter. */
export class Usage {
  private lib: LibraryDb;
  constructor(lib: LibraryDb) { this.lib = lib;}
  record(u: UsageRecord): void {
    this.lib.run('INSERT INTO usage (id, at, task, model, input, output, cache_read, cache_write, cost_usd, brand_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      this.lib.id('use'), u.at ?? this.lib.stamp(), u.task, u.model, u.input, u.output, u.cacheRead, u.cacheWrite, u.costUsd, u.brandId ?? null);
  }
  /** Totals since an ISO timestamp (default: the start of the current calendar month, UTC). */
  summary(since?: string): UsageSummary {
    const d = new Date();
    const from = since ?? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString();
    const rows = this.lib.all('SELECT task, count(*) n, sum(cost_usd) c, sum(input) i, sum(output) o FROM usage WHERE at >= ? GROUP BY task ORDER BY c DESC', from);
    const byTask = rows.map((r) => ({ task: String(r.task), calls: Number(r.n), costUsd: Number(r.c) }));
    return { calls: byTask.reduce((s, t) => s + t.calls, 0), costUsd: byTask.reduce((s, t) => s + t.costUsd, 0), byTask, input: rows.reduce((s, r) => s + Number(r.i), 0), output: rows.reduce((s, r) => s + Number(r.o), 0) };
  }
}
