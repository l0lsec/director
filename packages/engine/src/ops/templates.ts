import type { Clip, LaneKind, Project } from '../schema/project';
import type { Op } from './primitives';
import { clipEnd, findClip, laneOfKind, uid } from '../model';

export interface TemplateClip { lane: LaneKind; clip: Clip; placeholder?: string }
export interface Template { id: string; name: string; duration: number; clips: TemplateClip[] }

/** Capture clips as a reusable template; text clips become numbered placeholders. */
export function makeTemplate(doc: Project, clipIds: string[], name: string): Template {
  const locs = clipIds.map((id) => findClip(doc, id)).filter((x): x is NonNullable<typeof x> => !!x);
  if (!locs.length) throw new Error('select clips to save as a template');
  const t0 = Math.min(...locs.map((l) => l.clip.start));
  let n = 0;
  const clips = locs.sort((a, b) => a.clip.start - b.clip.start).map((l) => {
    const c: Clip = structuredClone(l.clip);
    c.start -= t0;
    delete (c as Partial<Clip>).linkGroup;
    const placeholder = c.text ? `Text ${++n}` : undefined;
    return { lane: l.lane.kind, clip: c, placeholder };
  });
  return { id: uid('tpl'), name, duration: Math.max(...locs.map((l) => clipEnd(l.clip))) - t0, clips };
}

/** Ops that place a template at `at`, replacing placeholder texts in order. */
export function applyTemplateOps(doc: Project, t: Template, at: number, texts: string[] = []): Op[] {
  const ops: Op[] = [];
  let k = 0;
  for (const tc of t.clips) {
    const lane = laneOfKind(doc, tc.lane);
    if (!lane) continue;
    const c: Clip = { ...structuredClone(tc.clip), id: uid('clip'), start: tc.clip.start + at };
    if (tc.placeholder && c.text) {
      const txt = texts[k++];
      if (txt != null) { c.text = { ...c.text, content: txt }; c.name = txt.slice(0, 60); }
    }
    if (c.mediaId && !doc.media[c.mediaId]) continue;
    ops.push({ op: 'addClip', laneId: lane.id, clip: c });
  }
  return ops;
}
