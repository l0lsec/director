import type { Project } from '@director/engine';
import { Compositor, type LayerDraw } from './compositor/gl';
import { planFrame, resolveEffects, transitionMods, placeLayer, hexToRgb, mattePlan, type VisualPlan } from './timeline/plan';
import { TextRenderer } from './text/render';

export interface FrameSource { source: TexImageSource; width: number; height: number }
export type SourceResolver = (plan: VisualPlan) => FrameSource | null;

const shapeCache = new Map<string, OffscreenCanvas>();
function shapeSource(type: 'rect' | 'ellipse', color: string, radius: number): FrameSource {
  const key = `${type}|${color}|${radius}`;
  let c = shapeCache.get(key);
  if (!c) {
    c = new OffscreenCanvas(256, 256);
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = color;
    ctx.beginPath();
    if (type === 'ellipse') ctx.ellipse(128, 128, 128, 128, 0, 0, Math.PI * 2); else ctx.roundRect(0, 0, 256, 256, Math.min(128, radius));
    ctx.fill();
    shapeCache.set(key, c);
  }
  return { source: c, width: 256, height: 256 };
}

/**
 * Compose one frame. `scale` is output size / project size (preview renders smaller).
 * Returns how many video layers had no frame ready.
 */
export function renderFrame(comp: Compositor, doc: Project, t: number, resolve: SourceResolver, text: TextRenderer, scale = 1): { missing: number; layers: number } {
  const W = Math.round(doc.canvas.width * scale);
  const H = Math.round(doc.canvas.height * scale);
  comp.resize(W, H);
  const plans = planFrame(doc, t);
  const draws: LayerDraw[] = [];
  let missing = 0;
  let bg: [number, number, number] = doc.canvas.background.kind === 'color' ? hexToRgb(doc.canvas.background.color) : [0, 0, 0];
  for (const p of plans) {
    let src: FrameSource | null = null;
    let premultiplied = false;
    if (p.kind === 'video' || p.kind === 'image') {
      src = resolve(p);
      if (!src) { missing++; continue; }
    } else if (p.kind === 'text') {
      const cv = text.render(p.clip.id, p.clip.text!, p.tRel, p.duration, W, H, scale);
      src = { source: cv, width: W, height: H };
      premultiplied = true;
    } else if (p.kind === 'shape') {
      src = shapeSource(p.clip.shape!.type, p.clip.shape!.color, p.clip.shape!.radius);
    }
    if (!src) continue;
    const fx = resolveEffects(p.clip, p.tRel);
    const tm = transitionMods(p.transition, W, H);
    if (tm.dip) bg = tm.dip;
    // Scale project-space transforms (pixels) to output pixels.
    const scaled = scale === 1 ? p.clip : { ...p.clip, transform: { ...p.clip.transform, x: { ...p.clip.transform.x, value: p.clip.transform.x.value * scale, keyframes: p.clip.transform.x.keyframes?.map((k) => ({ ...k, v: k.v * scale })) }, y: { ...p.clip.transform.y, value: p.clip.transform.y.value * scale, keyframes: p.clip.transform.y.keyframes?.map((k) => ({ ...k, v: k.v * scale })) } } };
    const isText = p.kind === 'text';
    const isShape = p.kind === 'shape';
    const place = placeLayer(isText || isShape ? { ...scaled, fit: 'stretch' } : scaled, p.tRel, isText ? W : src.width, isText ? H : src.height, isShape ? W : W, isShape ? H : H, { ...fx, shake: { x: fx.shake.x * scale, y: fx.shake.y * scale } }, tm);
    if (isShape) { place.w *= 0.25; place.h *= 0.25; }
    // Blurred background fill: the bottom-most video drawn to cover the canvas, blurred, before anything else.
    if (draws.length === 0 && doc.canvas.background.kind === 'blur' && p.kind === 'video') {
      const s = Math.max(W / src.width, H / src.height) * 1.08;
      draws.push({ source: src.source, srcWidth: src.width, srcHeight: src.height, cx: W / 2, cy: H / 2, w: src.width * s, h: src.height * s, rotation: 0, opacity: 1, crop: { left: 0, top: 0, right: 0, bottom: 0 }, flipH: false, flipV: false, blend: 'normal', blur: 24 * doc.canvas.background.amount + 6, color: { exposure: -0.3, contrast: 0, saturation: 0, temperature: 0, tint: 0, brightness: 0, vignette: 0 } });
    }
    const mp = mattePlan(p);
    const matte = mp ? resolve(mp)?.source : undefined;
    draws.push({ ...place, source: src.source, srcWidth: src.width, srcHeight: src.height, blend: p.clip.blend, premultiplied, ...(matte ? { matte } : {}) });
  }
  comp.draw(draws, bg);
  return { missing, layers: plans.length };
}

/** Load every .cube LUT a project references into the compositor (preview and export both call this). */
export async function loadLuts(doc: Project, comp: Compositor): Promise<number> {
  const { parseCube } = await import('./compositor/gl');
  const { mediaUrl } = await import('./url');
  const paths = new Set<string>();
  for (const l of doc.lanes) for (const c of l.clips) for (const e of c.effects) if (e.type === 'lut' && typeof e.params.path === 'string') paths.add(e.params.path);
  let n = 0;
  for (const p of paths) {
    if (comp.hasLut(p)) continue;
    try { const { size, data } = parseCube(await (await fetch(mediaUrl(p))).text()); comp.setLut(p, size, data); n++; } catch { /* missing or invalid LUT: renders without it */ }
  }
  return n;
}
