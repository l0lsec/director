import type { Project, TextSpec } from '@director/engine';
import { Compositor } from './compositor/gl';
import { MediaPool } from './decode/pool';
import { TextRenderer } from './text/render';
import { renderFrame, loadLuts, type FrameSource } from './render';
import { planFrame, withMattes } from './timeline/plan';
import { mediaUrl } from './url';

export interface ThumbnailSpec { width: number; height: number; title?: string; titleStyle?: Partial<TextSpec>; format?: 'png' | 'jpeg' }

export const THUMB_TITLE: TextSpec = { content: '', font: 'Inter', size: 120, weight: 900, color: '#ffffff', align: 'center', lineHeight: 1.0, maxWidth: 0.86, stroke: { color: '#000000', width: 12 }, uppercase: true };

/** Render a cover or thumbnail: the frame at t, cropped to fill the target size, with an optional title. */
export async function renderThumbnail(doc: Project, t: number, spec: ThumbnailSpec): Promise<Blob> {
  const scale = Math.max(spec.width / doc.canvas.width, spec.height / doc.canvas.height);
  const frameCanvas = new OffscreenCanvas(16, 16);
  const comp = new Compositor(frameCanvas);
  await loadLuts(doc, comp);
  const pool = new MediaPool(4);
  const ready = new Map<string, FrameSource>();
  const toClose: VideoFrame[] = [];
  for (const p of withMattes(planFrame(doc, t))) {
    if (p.kind === 'video' && p.path) {
      const path = p.clip.id.endsWith('#matte') ? p.path : doc.media[p.clip.mediaId!]!.path;
      const f = await pool.frameAt(path, p.srcSec ?? 0);
      if (f) { toClose.push(f.frame); ready.set(p.clip.id, { source: f.frame, width: f.width, height: f.height }); }
    } else if (p.kind === 'image' && p.path) {
      const b = await createImageBitmap(await (await fetch(mediaUrl(p.path))).blob(), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
      ready.set(p.clip.id, { source: b, width: b.width, height: b.height });
    }
  }
  renderFrame(comp, doc, t, (p) => ready.get(p.clip.id) ?? null, new TextRenderer(), scale);
  for (const f of toClose) f.close();
  pool.dispose();
  const out = new OffscreenCanvas(spec.width, spec.height);
  const ctx = out.getContext('2d')!;
  // Center crop of the rendered frame into the target.
  ctx.drawImage(frameCanvas, (frameCanvas.width - spec.width) / 2, (frameCanvas.height - spec.height) / 2, spec.width, spec.height, 0, 0, spec.width, spec.height);
  if (spec.title) {
    const k = Math.min(spec.width, spec.height) / 1080;
    const tr = new TextRenderer();
    const textCanvas = tr.render('thumb', { ...THUMB_TITLE, ...spec.titleStyle, content: spec.title }, 1_000_000, 10_000_000, spec.width, spec.height, k);
    ctx.drawImage(textCanvas, 0, spec.height > spec.width ? -spec.height * 0.18 : 0);
  }
  comp.dispose();
  return out.convertToBlob({ type: spec.format === 'jpeg' ? 'image/jpeg' : 'image/png', quality: 0.92 });
}
