import { statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { LibraryDb, LibraryError, json, type Row } from '../db';
import { hashFile, expandPaths } from './hash';

export { hashFile, expandPaths, VIDEO_EXT } from './hash';

export interface RefStats { views: number | null; likes: number | null; comments: number | null; shares: number | null; posted: string | null }
export interface Reference extends RefStats {
  id: string; brandId: string; hash: string; path: string; title: string; sourceUrl: string | null; creator: string | null; platform: string | null;
  folder: string; kitId: string | null; durationUs: number | null; width: number | null; height: number | null; size: number | null;
  notes: string; added: string; tags: string[]; engagement: number | null; analysis: unknown; hasTranscript: boolean;
}
export interface ProbeInfo { durationUs?: number | null; width?: number | null; height?: number | null }
export interface ImportItem { path: string; hash?: string; sourceUrl?: string; title?: string; probe?: ProbeInfo }
export interface ImportResult { added: Reference[]; duplicates: Array<{ path: string; existingId: string }>; restored: Reference[]; failed: Array<{ path: string; error: string }> }
export type RefSort = 'added' | 'title' | 'views' | 'likes' | 'engagement' | 'duration' | 'posted';
export interface RefQuery { folder?: string; tag?: string; kitId?: string | null; q?: string; sort?: RefSort; dir?: 'asc' | 'desc'; includeDeleted?: boolean }
export type RefPatch = Partial<Pick<Reference, 'title' | 'sourceUrl' | 'creator' | 'platform' | 'folder' | 'kitId' | 'notes' | 'views' | 'likes' | 'comments' | 'shares' | 'posted'>>;

const num = (v: unknown) => (v == null ? null : Number(v));
const engagement = (r: Row): number | null => {
  const views = num(r.views);
  if (!views) return null;
  return ((num(r.likes) ?? 0) + (num(r.comments) ?? 0) + (num(r.shares) ?? 0)) / views;
};

export function platformFromUrl(url: string | undefined | null): string | null {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.replace(/^www\./, '');
    if (/instagram\.com$/.test(h)) return 'instagram';
    if (/tiktok\.com$/.test(h)) return 'tiktok';
    if (/youtube\.com$|youtu\.be$/.test(h)) return 'youtube';
    if (/x\.com$|twitter\.com$/.test(h)) return 'x';
    return h;
  } catch { return null; }
}

/** The swipe file: reference videos with stats, tags, folders and kits, scoped to one brand per call. */
export class Swipe {
  private lib: LibraryDb;
  constructor(lib: LibraryDb) { this.lib = lib;}

  private toRef(r: Row): Reference {
    const tags = this.lib.all('SELECT tag FROM ref_tags WHERE ref_id = ? ORDER BY tag', r.id).map((t) => String(t.tag));
    return {
      id: String(r.id), brandId: String(r.brand_id), hash: String(r.hash), path: String(r.path), title: String(r.title),
      sourceUrl: (r.source_url as string) ?? null, creator: (r.creator as string) ?? null, platform: (r.platform as string) ?? null,
      folder: String(r.folder ?? ''), kitId: (r.kit_id as string) ?? null, durationUs: num(r.duration_us), width: num(r.width), height: num(r.height), size: num(r.size),
      views: num(r.views), likes: num(r.likes), comments: num(r.comments), shares: num(r.shares), posted: (r.posted as string) ?? null,
      notes: String(r.notes ?? ''), added: String(r.added), tags, engagement: engagement(r), analysis: json(r.analysis, null), hasTranscript: r.transcript != null,
    };
  }
  private brandExists(brandId: string): void {
    if (!this.lib.get('SELECT 1 FROM brands WHERE id = ?', brandId)) throw new LibraryError(`brand ${brandId} not found`, 'NOT_FOUND');
  }

  /** Import files and folders. Each distinct content hash is added once per brand; re-importing a deleted one restores it. */
  async importPaths(brandId: string, items: Array<string | ImportItem>, opts: { folder?: string; probe?: (path: string) => Promise<ProbeInfo | null> } = {}): Promise<ImportResult> {
    this.brandExists(brandId);
    const res: ImportResult = { added: [], duplicates: [], restored: [], failed: [] };
    const expanded: ImportItem[] = [];
    for (const it of items) {
      const item = typeof it === 'string' ? { path: it } : it;
      const files = expandPaths([item.path]);
      if (!files.length) { res.failed.push({ path: item.path, error: 'not a video file or folder' }); continue; }
      for (const f of files) expanded.push(f === item.path ? item : { path: f });
    }
    const seen = new Map<string, string>();
    for (const item of expanded) {
      try {
        const hash = item.hash ?? await hashFile(item.path);
        const prior = seen.get(hash);
        if (prior) { res.duplicates.push({ path: item.path, existingId: prior }); continue; }
        const existing = this.lib.get('SELECT * FROM refs WHERE brand_id = ? AND hash = ?', brandId, hash);
        if (existing && existing.deleted_at == null) { seen.set(hash, String(existing.id)); res.duplicates.push({ path: item.path, existingId: String(existing.id) }); continue; }
        if (existing) {
          this.lib.run('UPDATE refs SET deleted_at = NULL, path = ? WHERE id = ?', item.path, existing.id);
          seen.set(hash, String(existing.id));
          res.restored.push(this.require(brandId, String(existing.id)));
          continue;
        }
        const probe = item.probe ?? (opts.probe ? await opts.probe(item.path) : null) ?? {};
        const id = this.lib.id('ref');
        this.lib.run(
          `INSERT INTO refs (id, brand_id, hash, path, title, source_url, platform, folder, duration_us, width, height, size, added)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, brandId, hash, item.path, item.title ?? basename(item.path, extname(item.path)), item.sourceUrl ?? null, platformFromUrl(item.sourceUrl),
          opts.folder ?? '', probe.durationUs ?? null, probe.width ?? null, probe.height ?? null, statSync(item.path).size, this.lib.stamp(),
        );
        seen.set(hash, id);
        res.added.push(this.require(brandId, id));
      } catch (e) {
        res.failed.push({ path: item.path, error: (e as Error).message });
      }
    }
    return res;
  }

  get(brandId: string, id: string): Reference | null {
    const r = this.lib.get('SELECT * FROM refs WHERE id = ? AND brand_id = ?', id, brandId);
    return r ? this.toRef(r) : null;
  }
  require(brandId: string, id: string): Reference {
    const r = this.get(brandId, id);
    if (!r) throw new LibraryError(`reference ${id} not found in this brand`, 'NOT_FOUND');
    return r;
  }

  list(brandId: string, q: RefQuery = {}): Reference[] {
    const where = ['r.brand_id = ?'];
    const params: unknown[] = [brandId];
    if (!q.includeDeleted) where.push('r.deleted_at IS NULL');
    if (q.folder !== undefined) {
      // A folder includes its subfolders ("Hooks" matches "Hooks/Questions").
      where.push("(r.folder = ? OR r.folder LIKE ? ESCAPE '\\')");
      params.push(q.folder, `${q.folder.replace(/[\\%_]/g, (m) => `\\${m}`)}/%`);
    }
    if (q.kitId !== undefined) { where.push(q.kitId === null ? 'r.kit_id IS NULL' : 'r.kit_id = ?'); if (q.kitId !== null) params.push(q.kitId); }
    if (q.tag) { where.push('EXISTS (SELECT 1 FROM ref_tags t WHERE t.ref_id = r.id AND t.tag = ?)'); params.push(q.tag.toLowerCase()); }
    if (q.q) {
      where.push("(r.title LIKE ? ESCAPE '\\' OR r.notes LIKE ? ESCAPE '\\' OR r.creator LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM ref_tags t WHERE t.ref_id = r.id AND t.tag LIKE ? ESCAPE '\\'))");
      const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      params.push(like, like, like, like);
    }
    const rows = this.lib.all(`SELECT r.* FROM refs r WHERE ${where.join(' AND ')}`, ...params).map((r) => this.toRef(r));
    const sort = q.sort ?? 'added';
    const dir = (q.dir ?? (sort === 'title' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
    const key = (r: Reference): number | string | null => {
      switch (sort) {
        case 'title': return r.title.toLowerCase();
        case 'views': return r.views;
        case 'likes': return r.likes;
        case 'engagement': return r.engagement;
        case 'duration': return r.durationUs;
        case 'posted': return r.posted;
        default: return r.added;
      }
    };
    // Missing values always sort last, whatever the direction; ties break by id for stable order.
    return rows.sort((a, b) => {
      const ka = key(a), kb = key(b);
      if (ka == null && kb == null) return a.id.localeCompare(b.id);
      if (ka == null) return 1;
      if (kb == null) return -1;
      const c = ka < kb ? -1 : ka > kb ? 1 : 0;
      return c * dir || a.id.localeCompare(b.id);
    });
  }

  update(brandId: string, id: string, patch: RefPatch): Reference {
    this.require(brandId, id);
    const cols: Record<string, string> = { title: 'title', sourceUrl: 'source_url', creator: 'creator', platform: 'platform', folder: 'folder', kitId: 'kit_id', notes: 'notes', views: 'views', likes: 'likes', comments: 'comments', shares: 'shares', posted: 'posted' };
    const sets: string[] = [];
    const params: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      const col = cols[k];
      if (!col) throw new LibraryError(`unknown field ${k}`, 'INVALID');
      if (['views', 'likes', 'comments', 'shares'].includes(k) && v != null && (!Number.isInteger(v) || (v as number) < 0)) throw new LibraryError(`${k} must be a whole number of at least 0`, 'INVALID');
      if (k === 'title' && !String(v ?? '').trim()) throw new LibraryError('title cannot be empty', 'INVALID');
      if (k === 'folder') { sets.push('folder = ?'); params.push(normalizeFolder(String(v ?? ''))); continue; }
      if (k === 'kitId' && v != null && !this.lib.get('SELECT 1 FROM kits WHERE id = ? AND brand_id = ?', v, brandId)) throw new LibraryError('kit not found in this brand', 'NOT_FOUND');
      if (k === 'sourceUrl') { sets.push('platform = ?'); params.push(patch.platform ?? platformFromUrl(v as string)); }
      sets.push(`${col} = ?`);
      params.push(v ?? null);
    }
    if (sets.length) this.lib.run(`UPDATE refs SET ${sets.join(', ')} WHERE id = ? AND brand_id = ?`, ...params, id, brandId);
    return this.require(brandId, id);
  }

  setTags(brandId: string, id: string, tags: string[]): Reference {
    this.require(brandId, id);
    const clean = [...new Set(tags.map((t) => t.trim().toLowerCase().replace(/^#/, '')).filter((t) => t && t.length <= 40))];
    this.lib.tx(() => {
      this.lib.run('DELETE FROM ref_tags WHERE ref_id = ?', id);
      for (const t of clean) this.lib.run('INSERT INTO ref_tags (ref_id, tag) VALUES (?, ?)', id, t);
    });
    return this.require(brandId, id);
  }
  tags(brandId: string): Array<{ tag: string; count: number }> {
    return this.lib.all('SELECT t.tag, count(*) n FROM ref_tags t JOIN refs r ON r.id = t.ref_id WHERE r.brand_id = ? AND r.deleted_at IS NULL GROUP BY t.tag ORDER BY n DESC, t.tag', brandId)
      .map((r) => ({ tag: String(r.tag), count: Number(r.n) }));
  }
  folders(brandId: string): Array<{ folder: string; count: number }> {
    return this.lib.all("SELECT folder, count(*) n FROM refs WHERE brand_id = ? AND deleted_at IS NULL AND folder <> '' GROUP BY folder ORDER BY folder", brandId)
      .map((r) => ({ folder: String(r.folder), count: Number(r.n) }));
  }

  createKit(brandId: string, name: string): { id: string; name: string } {
    this.brandExists(brandId);
    if (!name.trim()) throw new LibraryError('kit name cannot be empty', 'INVALID');
    const id = this.lib.id('kit');
    this.lib.run('INSERT INTO kits (id, brand_id, name, created) VALUES (?, ?, ?, ?)', id, brandId, name.trim(), this.lib.stamp());
    return { id, name: name.trim() };
  }
  kits(brandId: string): Array<{ id: string; name: string; count: number }> {
    return this.lib.all('SELECT k.id, k.name, (SELECT count(*) FROM refs r WHERE r.kit_id = k.id AND r.deleted_at IS NULL) n FROM kits k WHERE k.brand_id = ? ORDER BY k.created', brandId)
      .map((r) => ({ id: String(r.id), name: String(r.name), count: Number(r.n) }));
  }
  deleteKit(brandId: string, kitId: string): boolean {
    return this.lib.tx(() => {
      this.lib.run('UPDATE refs SET kit_id = NULL WHERE kit_id = ? AND brand_id = ?', kitId, brandId);
      return this.lib.run('DELETE FROM kits WHERE id = ? AND brand_id = ?', kitId, brandId).changes > 0;
    });
  }

  remove(brandId: string, id: string): boolean { return this.lib.run('UPDATE refs SET deleted_at = ? WHERE id = ? AND brand_id = ? AND deleted_at IS NULL', this.lib.stamp(), id, brandId).changes > 0; }
  restore(brandId: string, id: string): boolean { return this.lib.run('UPDATE refs SET deleted_at = NULL WHERE id = ? AND brand_id = ?', id, brandId).changes > 0; }

  setAnalysis(brandId: string, id: string, analysis: unknown): void {
    if (!this.lib.run('UPDATE refs SET analysis = ? WHERE id = ? AND brand_id = ?', JSON.stringify(analysis), id, brandId).changes) throw new LibraryError('reference not found in this brand', 'NOT_FOUND');
  }
  setTranscript(brandId: string, id: string, transcript: unknown): void {
    if (!this.lib.run('UPDATE refs SET transcript = ? WHERE id = ? AND brand_id = ?', JSON.stringify(transcript), id, brandId).changes) throw new LibraryError('reference not found in this brand', 'NOT_FOUND');
  }
  transcript<T>(brandId: string, id: string): T | null {
    const r = this.lib.get('SELECT transcript FROM refs WHERE id = ? AND brand_id = ?', id, brandId);
    return r ? json<T | null>(r.transcript, null) : null;
  }
}

export function normalizeFolder(f: string): string {
  return f.split('/').map((s) => s.trim()).filter(Boolean).join('/').slice(0, 200);
}
