import { LibraryDb, LibraryError, json, type Row } from '../db';

export interface Brand { id: string; name: string; color: string | null; created: string; archived: boolean }
export interface CaptionPreset { id: string; brandId: string; name: string; style: Record<string, unknown>; created: string }

const toBrand = (r: Row): Brand => ({ id: String(r.id), name: String(r.name), color: (r.color as string) ?? null, created: String(r.created), archived: !!r.archived });

/** Brands are the top-level workspace: every library row belongs to exactly one brand. */
export class Brands {
  private lib: LibraryDb;
  constructor(lib: LibraryDb) { this.lib = lib;}
  create(name: string, color?: string): Brand {
    const n = name.trim();
    if (!n || n.length > 80) throw new LibraryError('Brand name must be 1 to 80 characters', 'INVALID');
    if (this.lib.get('SELECT 1 FROM brands WHERE lower(name) = lower(?) AND archived = 0', n)) throw new LibraryError(`A brand named "${n}" already exists`, 'DUPLICATE');
    const b: Brand = { id: this.lib.id('brand'), name: n, color: color ?? null, created: this.lib.stamp(), archived: false };
    this.lib.run('INSERT INTO brands (id, name, color, created) VALUES (?, ?, ?, ?)', b.id, b.name, b.color, b.created);
    return b;
  }
  list(includeArchived = false): Brand[] {
    return this.lib.all(`SELECT * FROM brands ${includeArchived ? '' : 'WHERE archived = 0'} ORDER BY created, name`).map(toBrand);
  }
  get(id: string): Brand | null { const r = this.lib.get('SELECT * FROM brands WHERE id = ?', id); return r ? toBrand(r) : null; }
  require(id: string): Brand {
    const b = this.get(id);
    if (!b) throw new LibraryError(`brand ${id} not found`, 'NOT_FOUND');
    return b;
  }
  update(id: string, patch: { name?: string; color?: string | null; archived?: boolean }): Brand {
    const b = this.require(id);
    const name = patch.name?.trim() ?? b.name;
    if (!name || name.length > 80) throw new LibraryError('Brand name must be 1 to 80 characters', 'INVALID');
    this.lib.run('UPDATE brands SET name = ?, color = ?, archived = ? WHERE id = ?', name, patch.color === undefined ? b.color : patch.color, (patch.archived ?? b.archived) ? 1 : 0, id);
    return this.require(id);
  }
  /** Default brand for a fresh install, so the library is usable before any setup. */
  ensureDefault(): Brand { return this.list()[0] ?? this.create('My brand'); }

  // Caption presets are brand-scoped styles for the captions panel.
  savePreset(brandId: string, name: string, style: Record<string, unknown>, id?: string): CaptionPreset {
    this.require(brandId);
    if (id) {
      const r = this.lib.run('UPDATE caption_presets SET name = ?, style = ? WHERE id = ? AND brand_id = ?', name, JSON.stringify(style), id, brandId);
      if (!r.changes) throw new LibraryError(`preset ${id} not found in this brand`, 'NOT_FOUND');
      return this.presets(brandId).find((p) => p.id === id)!;
    }
    const p: CaptionPreset = { id: this.lib.id('cap'), brandId, name, style, created: this.lib.stamp() };
    this.lib.run('INSERT INTO caption_presets (id, brand_id, name, style, created) VALUES (?, ?, ?, ?, ?)', p.id, brandId, name, JSON.stringify(style), p.created);
    return p;
  }
  presets(brandId: string): CaptionPreset[] {
    return this.lib.all('SELECT * FROM caption_presets WHERE brand_id = ? ORDER BY created', brandId)
      .map((r) => ({ id: String(r.id), brandId: String(r.brand_id), name: String(r.name), style: json(r.style, {}), created: String(r.created) }));
  }
  deletePreset(brandId: string, id: string): boolean { return this.lib.run('DELETE FROM caption_presets WHERE id = ? AND brand_id = ?', id, brandId).changes > 0; }
}
