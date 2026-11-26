import type { TextSpec } from '@director/engine';

export interface TextAnim { alpha: number; scale: number; dx: number; dy: number; reveal: number }

const easeOutBack = (x: number) => 1 + 2.2 * Math.pow(x - 1, 3) + 1.2 * Math.pow(x - 1, 2);
const easeOut = (x: number) => 1 - Math.pow(1 - x, 3);

/** In/out animation state at tRel (seconds) for a clip lasting dur seconds. */
export function textAnimation(spec: Pick<TextSpec, 'animationIn' | 'animationOut' | 'animationDuration'>, tRel: number, dur: number): TextAnim {
  const a: TextAnim = { alpha: 1, scale: 1, dx: 0, dy: 0, reveal: 1 };
  const d = Math.min((spec.animationDuration ?? 300_000) / 1e6, dur / 2);
  const apply = (kind: string | undefined, x: number) => {
    if (!kind || x >= 1) return;
    const k = Math.max(0, x);
    switch (kind) {
      case 'fade': a.alpha *= k; break;
      case 'pop': a.scale *= 0.6 + 0.4 * easeOutBack(k); a.alpha *= Math.min(1, k * 2); break;
      case 'slide-up': a.dy += (1 - easeOut(k)) * 80; a.alpha *= k; break;
      case 'slide-left': a.dx += (1 - easeOut(k)) * 120; a.alpha *= k; break;
      case 'zoom': a.scale *= 1.4 - 0.4 * easeOut(k); a.alpha *= k; break;
      case 'typewriter': a.reveal = Math.min(a.reveal, k); break;
    }
  };
  if (d > 0) {
    apply(spec.animationIn, tRel / d);
    apply(spec.animationOut, (dur - tRel) / d);
  }
  return a;
}

function wrap(ctx: OffscreenCanvasRenderingContext2D, text: string, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const test = line ? `${line} ${word}` : word;
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = word; } else line = test;
    }
    out.push(line);
  }
  return out;
}

function roundRect(ctx: OffscreenCanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();
}

/**
 * Renders a text or caption clip into a full-frame transparent canvas (premultiplied alpha).
 * Captions with word timings highlight the word being spoken.
 */
export class TextRenderer {
  private canvases = new Map<string, OffscreenCanvas>();

  render(key: string, spec: TextSpec, tRelUs: number, durUs: number, W: number, H: number, scaleFactor = 1): OffscreenCanvas {
    let cv = this.canvases.get(key);
    if (!cv || cv.width !== W || cv.height !== H) { cv = new OffscreenCanvas(W, H); this.canvases.set(key, cv); }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const anim = textAnimation(spec, tRelUs / 1e6, durUs / 1e6);
    if (anim.alpha <= 0.001) return cv;
    const size = spec.size * scaleFactor;
    ctx.font = `${spec.weight} ${size}px "${spec.font}", Inter, -apple-system, "Helvetica Neue", sans-serif`;
    ctx.textBaseline = 'alphabetic';
    const maxWidth = W * spec.maxWidth;
    const upper = (s: string) => (spec.uppercase ? s.toUpperCase() : s);

    // Caption mode: only words currently on this card, highlight the active one.
    const words = spec.words;
    let lines: string[];
    let activeWord = -1;
    let flatWords: string[] = [];
    if (words && words.length) {
      flatWords = words.map((w) => upper(w.text));
      activeWord = words.findIndex((w) => tRelUs >= w.start && tRelUs < w.end);
      if (activeWord < 0) { const past = words.filter((w) => w.start <= tRelUs).length; activeWord = past - 1; }
      lines = wrap(ctx, flatWords.join(' '), maxWidth);
    } else {
      let content = upper(spec.content);
      if (anim.reveal < 1) content = content.slice(0, Math.ceil(content.length * anim.reveal));
      lines = wrap(ctx, content, maxWidth);
    }
    const lh = size * spec.lineHeight;
    const blockH = lh * lines.length;
    ctx.globalAlpha = anim.alpha;
    ctx.translate(W / 2 + anim.dx * scaleFactor, H / 2 + anim.dy * scaleFactor);
    ctx.scale(anim.scale, anim.scale);
    const top = -blockH / 2;
    const xFor = (w: number) => (spec.align === 'left' ? -maxWidth / 2 : spec.align === 'right' ? maxWidth / 2 - w : -w / 2);

    if (spec.box) {
      ctx.fillStyle = spec.box.color;
      const widest = Math.max(...lines.map((l) => ctx.measureText(l).width));
      const pad = spec.box.padding * scaleFactor;
      roundRect(ctx, xFor(widest) - pad, top - pad * 0.6, widest + pad * 2, blockH + pad * 1.2, spec.box.radius * scaleFactor);
    }
    let wordCursor = 0;
    lines.forEach((line, li) => {
      const y = top + lh * (li + 0.78);
      const lw = ctx.measureText(line).width;
      let x = xFor(lw);
      const parts = line.split(' ');
      for (const part of parts) {
        const isActive = words && wordCursor === activeWord;
        const pw = ctx.measureText(part).width;
        ctx.save();
        if (isActive && spec.styleId === 'word-pop') {
          ctx.translate(x + pw / 2, y - size * 0.35);
          ctx.scale(1.15, 1.15);
          ctx.translate(-(x + pw / 2), -(y - size * 0.35));
        }
        if (spec.shadow) { ctx.shadowColor = spec.shadow.color; ctx.shadowBlur = spec.shadow.blur * scaleFactor; ctx.shadowOffsetX = spec.shadow.x * scaleFactor; ctx.shadowOffsetY = spec.shadow.y * scaleFactor; }
        if (spec.stroke && spec.stroke.width > 0) {
          ctx.lineJoin = 'round';
          ctx.lineWidth = spec.stroke.width * 2 * scaleFactor;
          ctx.strokeStyle = spec.stroke.color;
          ctx.strokeText(part, x, y);
          ctx.shadowColor = 'transparent';
        }
        ctx.fillStyle = isActive && spec.highlightColor ? spec.highlightColor : spec.color;
        ctx.fillText(part, x, y);
        ctx.restore();
        x += pw + ctx.measureText(' ').width;
        wordCursor++;
      }
    });
    return cv;
  }

  drop(key: string): void { this.canvases.delete(key); }
  clear(): void { this.canvases.clear(); }
}
