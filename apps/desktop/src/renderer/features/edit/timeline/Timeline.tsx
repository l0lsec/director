import { useCallback, useEffect, useRef, useState } from 'react';
import {
  clipDuration, clipEnd, findClip, snapTime, moveClipOps, trimOps, splitOps, slipOps, rollOps, timelineDuration, formatTimecode,
  AUDIO_LANES, LANE_LABEL, type Clip, type Project,
} from '@director/engine';
import { mediaUrl } from '@director/media';
import { useProject } from '../../project/store';
import { useEdit, setEdit, getEdit } from '../store';
import { seek } from '../player';
import { addMediaToTimeline } from '../commands';
import { invoke } from '../../../shell/bridge';
import { HEADER_W, RULER_H, laneRows, timeToX, xToTime, type LaneRow } from './geometry';
import { getLibraryMedia } from '../library/store';

type Drag =
  | { kind: 'scrub' }
  | { kind: 'move'; clipId: string; grabDt: number; startX: number; startY: number; moved: boolean; ghostStart: number; ghostLane: string }
  | { kind: 'trim'; clipId: string; edge: 'start' | 'end'; ghostT: number }
  | { kind: 'slip'; clipId: string; startX: number; delta: number }
  | { kind: 'roll'; leftId: string; rightId: string; startX: number; delta: number }
  | { kind: 'marquee'; x0: number; y0: number; x1: number; y1: number };

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

const thumbs = new Map<string, HTMLImageElement | 'loading' | 'none'>();
const peaks = new Map<string, Uint8Array | 'loading' | 'none'>();

function requestDerived(doc: Project, onReady: () => void): void {
  const dir = useProject.getState().dir ?? undefined;
  for (const m of Object.values(doc.media)) {
    if (!m.hash || m.hash.length < 8 || thumbs.has(m.hash)) continue;
    thumbs.set(m.hash, 'loading');
    peaks.set(m.hash, 'loading');
    void invoke('media:derived', { hash: m.hash, projectDir: dir }).then((d) => {
      if (d.thumbs) { const img = new Image(); img.onload = () => { thumbs.set(m.hash, img); onReady(); }; img.src = mediaUrl(d.thumbs); } else thumbs.set(m.hash, 'none');
      if (d.peaks) void invoke('media:peaks', { path: d.peaks }).then((p) => { peaks.set(m.hash, p); onReady(); }); else peaks.set(m.hash, 'none');
    }).catch(() => { thumbs.set(m.hash, 'none'); peaks.set(m.hash, 'none'); });
  }
}

export function Timeline() {
  const doc = useProject((s) => s.doc);
  const version = useProject((s) => s.version);
  const { t, zoom, scrollX, selection, tool, snapping, ripple, inPoint, outPoint } = useEdit();
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const [, force] = useState(0);
  const [size, setSize] = useState({ w: 800, h: 300 });
  const [hover, setHover] = useState<string>('default');

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => { if (e) setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }); });
    if (wrap.current) ro.observe(wrap.current);
    return () => ro.disconnect();
  }, [!!doc]);

  useEffect(() => { if (doc) requestDerived(doc, () => force((n) => n + 1)); }, [doc, version]);

  const rows = doc ? laneRows(doc) : [];
  const contentH = rows.length ? rows[rows.length - 1]!.y + rows[rows.length - 1]!.h + 8 : 200;

  const draw = useCallback(() => {
    const cv = canvas.current;
    if (!cv || !doc) return;
    const dpr = window.devicePixelRatio || 1;
    const W = size.w - HEADER_W;
    const H = Math.max(size.h, contentH);
    if (cv.width !== W * dpr || cv.height !== H * dpr) { cv.width = W * dpr; cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const ctx = cv.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = css('--bg');
    ctx.fillRect(0, 0, W, H);
    const fps = doc.canvas.fps;
    // Ruler.
    ctx.fillStyle = css('--bg-1');
    ctx.fillRect(0, 0, W, RULER_H);
    const secPerTick = [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120, 300].find((s) => s * zoom >= 70) ?? 600;
    ctx.fillStyle = css('--text-faint');
    ctx.font = '10px ui-monospace, Menlo, monospace';
    const startSec = Math.floor(scrollX / zoom / secPerTick) * secPerTick;
    for (let s = startSec; s * zoom - scrollX < W; s += secPerTick) {
      const x = Math.round(s * zoom - scrollX) + 0.5;
      ctx.fillRect(x, RULER_H - 10, 1, 10);
      ctx.fillText(formatTimecode(Math.round(s * 1e6), fps), x + 3, 12);
      for (let k = 1; k < 5; k++) { const xx = Math.round((s + (k * secPerTick) / 5) * zoom - scrollX) + 0.5; ctx.fillRect(xx, RULER_H - 4, 1, 4); }
    }
    // In/out range.
    if (inPoint != null && outPoint != null) {
      const a = timeToX(Math.min(inPoint, outPoint), zoom, scrollX), b = timeToX(Math.max(inPoint, outPoint), zoom, scrollX);
      ctx.fillStyle = 'rgba(245,184,61,0.12)';
      ctx.fillRect(a, 0, b - a, H);
    }
    // Lanes.
    const ghost = drag.current;
    for (const row of rows) {
      const lane = doc.lanes.find((l) => l.id === row.id)!;
      ctx.fillStyle = css('--bg-1');
      ctx.fillRect(0, row.y, W, row.h);
      const color = css(`--lane-${row.kind}`);
      for (const c of lane.clips) {
        let start = c.start;
        let end = clipEnd(c);
        let laneY = row;
        if (ghost?.kind === 'move' && ghost.moved && (ghost.clipId === c.id || (c.linkGroup && findClip(doc, ghost.clipId)?.clip.linkGroup === c.linkGroup))) {
          const delta = ghost.ghostStart - findClip(doc, ghost.clipId)!.clip.start;
          start += delta; end += delta;
          if (ghost.clipId === c.id) laneY = rows.find((r) => r.id === ghost.ghostLane) ?? row;
        }
        if (ghost?.kind === 'trim' && ghost.clipId === c.id) { if (ghost.edge === 'start') start = Math.min(ghost.ghostT, end - 1000); else end = Math.max(ghost.ghostT, start + 1000); }
        const x = timeToX(start, zoom, scrollX);
        const w = Math.max(2, timeToX(end, zoom, scrollX) - x);
        if (x > W || x + w < 0) continue;
        drawClip(ctx, doc, c, x, laneY.y + 2, w, laneY.h - 4, color, selection.includes(c.id), AUDIO_LANES.has(row.kind));
      }
    }
    // Markers.
    for (const m of doc.markers) {
      const x = timeToX(m.t, zoom, scrollX);
      if (x < -10 || x > W + 10) continue;
      ctx.fillStyle = m.kind === 'retake' ? css('--danger') : m.kind === 'cue' ? css('--info') : m.kind === 'good' ? css('--ok') : css('--accent');
      ctx.beginPath(); ctx.moveTo(x - 5, RULER_H - 12); ctx.lineTo(x + 5, RULER_H - 12); ctx.lineTo(x, RULER_H - 4); ctx.fill();
      ctx.globalAlpha = 0.25; ctx.fillRect(x, RULER_H, 1, H); ctx.globalAlpha = 1;
    }
    if (ghost?.kind === 'marquee') {
      ctx.strokeStyle = css('--accent'); ctx.setLineDash([4, 3]);
      ctx.strokeRect(Math.min(ghost.x0, ghost.x1), Math.min(ghost.y0, ghost.y1), Math.abs(ghost.x1 - ghost.x0), Math.abs(ghost.y1 - ghost.y0));
      ctx.setLineDash([]);
    }
    // Playhead.
    const px = Math.round(timeToX(t, zoom, scrollX)) + 0.5;
    ctx.fillStyle = css('--danger');
    ctx.fillRect(px - 0.5, 0, 2, H);
    ctx.beginPath(); ctx.moveTo(px - 6, 0); ctx.lineTo(px + 7, 0); ctx.lineTo(px + 0.5, 9); ctx.fill();
    const g = globalThis as unknown as Record<string, number>; g.__directorTimelineDraws = (g.__directorTimelineDraws ?? 0) + 1;
  }, [doc, version, size, zoom, scrollX, t, selection, rows, contentH, inPoint, outPoint]);

  useEffect(() => { draw(); });

  // Test and automation surface: geometry in client coordinates.
  useEffect(() => {
    (globalThis as Record<string, unknown>).__directorTimeline = {
      canvasRect: () => canvas.current?.getBoundingClientRect(),
      timeToClientX: (tt: number) => (canvas.current?.getBoundingClientRect().left ?? 0) + timeToX(tt, getEdit().zoom, getEdit().scrollX),
      laneCenterY: (kind: string) => { const r = rows.find((x) => x.kind === kind); const top = canvas.current?.getBoundingClientRect().top ?? 0; return r ? top + r.y + r.h / 2 : null; },
      clipRect: (id: string) => {
        const d = useProject.getState().doc; if (!d) return null;
        const loc = findClip(d, id); if (!loc) return null;
        const r = laneRows(d).find((x) => x.id === loc.lane.id)!;
        const b = canvas.current!.getBoundingClientRect();
        const x = timeToX(loc.clip.start, getEdit().zoom, getEdit().scrollX);
        return { x: b.left + x, y: b.top + r.y + 2, w: timeToX(clipEnd(loc.clip), getEdit().zoom, getEdit().scrollX) - x, h: r.h - 4 };
      },
      redraw: draw,
    };
  }, [rows, draw]);

  const hit = (x: number, y: number): { row?: LaneRow; clip?: Clip; edge?: 'start' | 'end' } => {
    if (!doc) return {};
    const row = rows.find((r) => y >= r.y && y < r.y + r.h);
    if (!row) return {};
    const lane = doc.lanes.find((l) => l.id === row.id)!;
    for (const c of [...lane.clips].reverse()) {
      const x0 = timeToX(c.start, zoom, scrollX), x1 = timeToX(clipEnd(c), zoom, scrollX);
      if (x >= x0 - 1 && x <= x1 + 1) {
        const edge = x - x0 < 7 && x1 - x0 > 16 ? 'start' : x1 - x < 7 && x1 - x0 > 16 ? 'end' : undefined;
        return { row, clip: c, edge };
      }
    }
    return { row };
  };

  const snap = (tt: number, exclude: Set<string>): number => {
    if (!doc || !snapping) return tt;
    return snapTime(doc, tt, Math.round((8 / zoom) * 1e6), [getEdit().t], exclude).t;
  };

  const local = (e: React.PointerEvent | React.DragEvent | React.WheelEvent) => {
    const r = canvas.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (!doc) return;
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    const { x, y } = local(e);
    if (y < RULER_H) { drag.current = { kind: 'scrub' }; seek(snap(xToTime(x, zoom, scrollX), new Set())); return; }
    const h = hit(x, y);
    const at = xToTime(x, zoom, scrollX);
    if (!h.clip) {
      if (!e.shiftKey) setEdit({ selection: [] });
      drag.current = { kind: 'marquee', x0: x, y0: y, x1: x, y1: y };
      return;
    }
    if (tool === 'blade') {
      const tt = snap(at, new Set());
      useProject.getState().apply(splitOps(doc, [h.clip.id], tt), 'Blade');
      return;
    }
    const multi = e.shiftKey || e.metaKey;
    const already = selection.includes(h.clip.id);
    setEdit({ selection: multi ? (already ? selection.filter((s) => s !== h.clip!.id) : [...selection, h.clip.id]) : already ? selection : [h.clip.id] });
    if (tool === 'slip') { drag.current = { kind: 'slip', clipId: h.clip.id, startX: x, delta: 0 }; return; }
    if (tool === 'roll' && h.edge) {
      const lane = doc.lanes.find((l) => l.id === h.row!.id)!;
      const idx = lane.clips.findIndex((c) => c.id === h.clip!.id);
      const left = h.edge === 'start' ? lane.clips[idx - 1] : h.clip;
      const right = h.edge === 'start' ? h.clip : lane.clips[idx + 1];
      if (left && right) drag.current = { kind: 'roll', leftId: left.id, rightId: right.id, startX: x, delta: 0 };
      return;
    }
    if (h.edge) { drag.current = { kind: 'trim', clipId: h.clip.id, edge: h.edge, ghostT: h.edge === 'start' ? h.clip.start : clipEnd(h.clip) }; return; }
    drag.current = { kind: 'move', clipId: h.clip.id, grabDt: at - h.clip.start, startX: x, startY: y, moved: false, ghostStart: h.clip.start, ghostLane: h.row!.id };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!doc) return;
    const { x, y } = local(e);
    const d = drag.current;
    if (!d) {
      const h = y < RULER_H ? {} : hit(x, y);
      setHover(tool === 'blade' && h.clip ? 'crosshair' : h.edge ? 'ew-resize' : h.clip ? 'grab' : 'default');
      return;
    }
    const at = xToTime(x, zoom, scrollX);
    if (d.kind === 'scrub') seek(snap(at, new Set()));
    else if (d.kind === 'move') {
      if (!d.moved && Math.abs(x - d.startX) + Math.abs(y - d.startY) < 4) return;
      d.moved = true;
      const c = findClip(doc, d.clipId)!.clip;
      const exclude = new Set([c.id]);
      let ns = Math.max(0, at - d.grabDt);
      if (snapping) {
        const thr = Math.round((8 / zoom) * 1e6);
        const s1 = snapTime(doc, ns, thr, [getEdit().t], exclude);
        const s2 = snapTime(doc, ns + clipDuration(c), thr, [getEdit().t], exclude);
        // Snap whichever edge actually found a target; if both did, the nearer one wins.
        if (s1.snapped && (!s2.snapped || Math.abs(s1.t - ns) <= Math.abs(s2.t - clipDuration(c) - ns))) ns = s1.t;
        else if (s2.snapped) ns = s2.t - clipDuration(c);
      }
      d.ghostStart = Math.max(0, ns);
      const row = rows.find((r) => y >= r.y && y < r.y + r.h);
      const fromKind = AUDIO_LANES.has(findClip(doc, c.id)!.lane.kind);
      if (row && AUDIO_LANES.has(row.kind) === fromKind) d.ghostLane = row.id;
      draw();
    } else if (d.kind === 'trim') { d.ghostT = snap(at, new Set([d.clipId])); draw(); }
    else if (d.kind === 'slip') { d.delta = Math.round(((d.startX - x) / zoom) * 1e6); }
    else if (d.kind === 'roll') { d.delta = Math.round(((x - d.startX) / zoom) * 1e6); }
    else if (d.kind === 'marquee') { d.x1 = x; d.y1 = y; draw(); }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!doc || !d) return;
    const apply = useProject.getState().apply;
    if (d.kind === 'move' && d.moved) apply(moveClipOps(doc, d.clipId, d.ghostLane, d.ghostStart), 'Move');
    else if (d.kind === 'trim') apply(trimOps(doc, d.clipId, d.edge, d.ghostT, { ripple }), d.edge === 'start' ? 'Trim start' : 'Trim end');
    else if (d.kind === 'slip' && d.delta) apply(slipOps(doc, d.clipId, d.delta), 'Slip');
    else if (d.kind === 'roll' && d.delta) apply(rollOps(doc, d.leftId, d.rightId, d.delta), 'Roll');
    else if (d.kind === 'marquee') {
      const t0 = xToTime(Math.min(d.x0, d.x1), zoom, scrollX), t1 = xToTime(Math.max(d.x0, d.x1), zoom, scrollX);
      const y0 = Math.min(d.y0, d.y1), y1 = Math.max(d.y0, d.y1);
      if (Math.abs(d.x1 - d.x0) > 3) {
        const ids = rows.filter((r) => r.y + r.h > y0 && r.y < y1).flatMap((r) => doc.lanes.find((l) => l.id === r.id)!.clips.filter((c) => clipEnd(c) > t0 && c.start < t1).map((c) => c.id));
        setEdit({ selection: ids });
      } else seek(xToTime(d.x0, zoom, scrollX));
    }
    draw();
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!doc) return;
    if (e.metaKey || e.ctrlKey) {
      const { x } = local(e);
      const at = (x + scrollX) / zoom;
      const nz = Math.max(4, Math.min(2000, zoom * Math.exp(-e.deltaY * 0.01)));
      setEdit({ zoom: nz, scrollX: Math.max(0, at * nz - x) });
    } else {
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      if (dx) setEdit({ scrollX: Math.max(0, Math.min(scrollX + dx, (timelineDuration(doc) / 1e6) * zoom)) });
      else if (wrap.current) wrap.current.scrollTop += e.deltaY;
    }
  };

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setEdit({ dragOverLane: null });
    const id = e.dataTransfer.getData('application/x-director-media');
    const m = id ? getLibraryMedia(id) : null;
    if (!m || !doc) return;
    const { x, y } = local(e);
    const row = rows.find((r) => y >= r.y && y < r.y + r.h);
    addMediaToTimeline(m, snap(xToTime(x, zoom, scrollX), new Set()), row && (AUDIO_LANES.has(row.kind) ? m.hasAudio : m.hasVideo) ? row.id : undefined);
  };

  if (!doc) return <div className="empty">Open or create a project to start editing.</div>;
  return (
    <div className="timeline" ref={wrap} data-testid="timeline">
      <div className="lane-headers" style={{ height: Math.max(size.h, contentH) }}>
        <div className="lane-head ruler-head" style={{ height: RULER_H }}>{formatTimecode(t, doc.canvas.fps)}</div>
        {rows.map((r) => {
          const lane = doc.lanes.find((l) => l.id === r.id)!;
          const toggle = (k: 'muted' | 'hidden' | 'locked') => useProject.getState().apply([{ op: 'updateLane', id: lane.id, patch: { [k]: !lane[k] } }], `Lane ${k}`);
          return (
            <div key={r.id} className="lane-head" style={{ top: r.y, height: r.h, borderLeftColor: `var(--lane-${r.kind})` }}>
              <span className="name">{LANE_LABEL[r.kind]}</span>
              <span className="lane-btns">
                {AUDIO_LANES.has(r.kind) || r.kind === 'camera' || r.kind === 'screen' || r.kind === 'broll' ? <button className={lane.muted ? 'on' : ''} title="Mute" aria-label={`Mute ${LANE_LABEL[r.kind]}`} onClick={() => toggle('muted')}>M</button> : null}
                {!AUDIO_LANES.has(r.kind) ? <button className={lane.hidden ? 'on' : ''} title="Hide" aria-label={`Hide ${LANE_LABEL[r.kind]}`} onClick={() => toggle('hidden')}>H</button> : null}
                <button className={lane.locked ? 'on' : ''} title="Lock" aria-label={`Lock ${LANE_LABEL[r.kind]}`} onClick={() => toggle('locked')}>L</button>
              </span>
            </div>
          );
        })}
      </div>
      <canvas
        ref={canvas}
        style={{ cursor: hover, left: HEADER_W }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }}
        onDrop={onDrop}
        data-testid="timeline-canvas"
      />
    </div>
  );
}

function drawClip(ctx: CanvasRenderingContext2D, doc: Project, c: Clip, x: number, y: number, w: number, h: number, color: string, selected: boolean, audioLane: boolean) {
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, 5);
  ctx.clip();
  ctx.fillStyle = color;
  ctx.globalAlpha = c.enabled ? 0.28 : 0.1;
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = 1;
  const m = c.mediaId ? doc.media[c.mediaId] : undefined;
  if (m && !audioLane && m.hasVideo) {
    const img = thumbs.get(m.hash);
    if (img instanceof HTMLImageElement && img.naturalWidth) {
      const count = Math.max(1, Math.round(img.naturalWidth / (img.naturalHeight * ((m.width ?? 16) / (m.height ?? 9)))));
      const tileW = img.naturalWidth / count;
      const th = h - 14;
      const tw = th * (tileW / img.naturalHeight);
      for (let xx = x; xx < x + w; xx += tw) {
        const srcT = c.in + ((xx - x) / w) * (c.out - c.in);
        const idx = Math.min(count - 1, Math.max(0, Math.floor((srcT / Math.max(1, m.durationUs)) * count)));
        ctx.globalAlpha = 0.85;
        ctx.drawImage(img, idx * tileW, 0, tileW, img.naturalHeight, xx, y + 14, tw, th);
      }
      ctx.globalAlpha = 1;
    }
  }
  if (m && (audioLane || !m.hasVideo) && m.hasAudio) {
    const p = peaks.get(m.hash);
    if (p instanceof Uint8Array) {
      ctx.fillStyle = color;
      const mid = y + h / 2 + 4;
      const amp = (h - 16) / 2;
      const rate = 100;
      for (let px = 0; px < w; px += 2) {
        const srcT = (c.in + ((px / w) * (c.out - c.in))) / 1e6;
        const v = (p[Math.floor(srcT * rate)] ?? 0) / 255;
        const a = v * amp * (c.audio?.muted ? 0.3 : 1);
        ctx.fillRect(x + px, mid - a, 1.5, a * 2);
      }
    }
  }
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  ctx.fillRect(x, y, w, 14);
  ctx.fillStyle = '#fff';
  ctx.font = '600 10px -apple-system, sans-serif';
  const label = c.text ? c.text.content : c.name ?? m?.name ?? c.kind;
  ctx.fillText(`${label}${c.speed.kind === 'constant' && c.speed.rate !== 1 ? `  ${c.speed.rate}x` : ''}${c.reverse ? '  rev' : ''}`, x + 5, y + 10, Math.max(0, w - 10));
  if (c.transitionIn) { ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + Math.min(w, 18), y + 14); ctx.lineTo(x, y + 14); ctx.fill(); }
  if (c.audio?.fadeIn) { ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(x, y + h); ctx.lineTo(x + (c.audio.fadeIn / 1e6) * (w / (clipDuration(c) / 1e6)), y + 14); ctx.stroke(); }
  ctx.restore();
  ctx.strokeStyle = selected ? '#ffffff' : color;
  ctx.lineWidth = selected ? 2 : 1;
  ctx.beginPath();
  ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, 5);
  ctx.stroke();
  if (c.linkGroup) { ctx.fillStyle = 'rgba(255,255,255,0.6)'; ctx.fillRect(x + w - 8, y + 4, 4, 4); }
}
