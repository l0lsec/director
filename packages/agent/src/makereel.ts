import { applyOps, parseScript, timelineDuration, findClip, laneOfKind, newClip, uid, clipEnd, type Op, type Project } from '@director/engine';
import { timelineWords, planBestTake, planAutoCut, cutOps, captionOps, DEFAULT_AUTOCUT, DEFAULT_CAPTIONS, type TimelineWord } from '@director/analysis';

export interface MakeReelReport { bestTakeCuts: number; autoCuts: number; zooms: number; brolls: number; captions: number; removedUs: number; missingLines: number[]; before: number; after: number }

/** Identify the word a cue belongs to so it can be found again after cuts move everything. */
function anchorFor(words: TimelineWord[], t: number): { mediaId: string; srcStart: number } | null {
  const w = words.find((x) => x.start >= t - 50_000) ?? null;
  return w ? { mediaId: w.mediaId, srcStart: w.srcStart } : null;
}

/** The whole Make Reel pipeline as one list of ops (one undo step). Pure given the doc. */
export function planMakeReel(start: Project, captionStyle = DEFAULT_CAPTIONS.styleId): { ops: Op[]; report: MakeReelReport } {
  let doc = start;
  const ops: Op[] = [];
  const tx = (more: Op[]) => { if (!more.length) return; doc = applyOps(doc, more).doc; ops.push(...more); };
  const report: MakeReelReport = { bestTakeCuts: 0, autoCuts: 0, zooms: 0, brolls: 0, captions: 0, removedUs: 0, missingLines: [], before: timelineDuration(start), after: 0 };
  if (doc.canvas.width !== 1080 || doc.canvas.height !== 1920) tx([{ op: 'setCanvas', patch: { width: 1080, height: 1920 } }]);
  // Remember where cues point before cuts shift (or remove) their markers.
  const words0 = timelineWords(doc);
  const cueAnchors = doc.markers.filter((m) => m.kind === 'cue').map((m) => ({ label: m.label, anchor: anchorFor(words0, m.t) })).filter((c) => c.anchor);
  if (doc.scriptText) {
    const plan = planBestTake(parseScript(doc.scriptText), words0, doc.markers, timelineDuration(doc));
    report.bestTakeCuts = plan.cuts.length;
    report.missingLines = plan.missingLines;
    tx(cutOps(doc, plan.cuts));
  }
  const auto = planAutoCut(doc, timelineWords(doc), DEFAULT_AUTOCUT);
  report.autoCuts = auto.length;
  tx(cutOps(doc, auto));
  // Cues -> punch-in zooms on the camera clip, b-roll placeholders on the B-roll lane.
  const words = timelineWords(doc);
  const findWord = (a: { mediaId: string; srcStart: number }) => words.find((w) => w.mediaId === a.mediaId && Math.abs(w.srcStart - a.srcStart) < 5_000);
  const cam = laneOfKind(doc, 'camera');
  const broll = laneOfKind(doc, 'broll');
  for (const c of cueAnchors) {
    const w = findWord(c.anchor!);
    if (!w) continue;
    if (/^ZOOM/i.test(c.label) && cam) {
      const clip = cam.clips.find((x) => x.start <= w.start && clipEnd(x) > w.start);
      if (!clip) continue;
      const fx = { id: uid('fx'), type: 'zoom', enabled: true, params: { at: w.start - clip.start, amount: 1.18, ramp: 140_000 } };
      tx([{ op: 'updateClip', id: clip.id, patch: { effects: [...findClip(doc, clip.id)!.clip.effects, fx] } }]);
      report.zooms++;
    } else if (/^B-?ROLL/i.test(c.label) && broll) {
      const label = c.label.replace(/^B-?ROLL:?\s*/i, '') || 'B-roll';
      const end = Math.min(w.start + 2_500_000, timelineDuration(doc));
      if (end - w.start < 200_000 || broll.clips.some((x) => x.start < end && clipEnd(x) > w.start)) continue;
      tx([{ op: 'addClip', laneId: broll.id, clip: newClip({ kind: 'placeholder', start: w.start, out: end - w.start, name: `B-roll: ${label}` }) }]);
      report.brolls++;
    }
  }
  const caps = captionOps(doc, timelineWords(doc), { ...DEFAULT_CAPTIONS, styleId: captionStyle });
  report.captions = caps.filter((o) => o.op === 'addClip').length;
  tx(caps);
  report.after = timelineDuration(doc);
  report.removedUs = report.before - report.after;
  return { ops, report };
}
