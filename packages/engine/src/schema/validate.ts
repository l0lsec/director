import { ProjectSchema, type Project } from './project';
import { clipEnd } from '../model';

/** Schema validation plus cross-reference invariants. Returns human-readable problems. */
export function validateProject(doc: unknown): string[] {
  const res = ProjectSchema.safeParse(doc);
  if (!res.success) return res.error.issues.slice(0, 20).map((i) => `${i.path.join('.')}: ${i.message}`);
  const p: Project = res.data;
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const lane of p.lanes) {
    if (ids.has(lane.id)) problems.push(`duplicate lane id ${lane.id}`);
    ids.add(lane.id);
    let prev = -1;
    for (const c of lane.clips) {
      if (ids.has(c.id)) problems.push(`duplicate clip id ${c.id}`);
      ids.add(c.id);
      if (c.mediaId && !p.media[c.mediaId]) problems.push(`clip ${c.id} references missing media ${c.mediaId}`);
      if (c.start < prev) problems.push(`lane ${lane.id} clips are not sorted`);
      prev = c.start;
      if (clipEnd(c) <= c.start) problems.push(`clip ${c.id} has no duration`);
    }
  }
  for (const [k, m] of Object.entries(p.media)) if (k !== m.id) problems.push(`media key ${k} does not match id ${m.id}`);
  return problems;
}
