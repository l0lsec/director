import type { LaneKind, Project } from '@director/engine';

export const HEADER_W = 150;
export const RULER_H = 28;
export const LANE_H: Record<LaneKind, number> = { graphics: 40, titles: 40, captions: 40, broll: 56, screen: 56, camera: 64, voice: 48, music: 44, sfx: 40 };

export interface LaneRow { id: string; kind: LaneKind; y: number; h: number }

export function laneRows(doc: Project): LaneRow[] {
  let y = RULER_H;
  return doc.lanes.map((l) => { const r = { id: l.id, kind: l.kind, y, h: LANE_H[l.kind] }; y += r.h + 2; return r; });
}

export function timeToX(t: number, zoom: number, scrollX: number): number { return (t / 1e6) * zoom - scrollX; }
export function xToTime(x: number, zoom: number, scrollX: number): number { return Math.max(0, Math.round(((x + scrollX) / zoom) * 1e6)); }
