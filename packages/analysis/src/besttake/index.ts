import { normalizeWord, type ParsedScript, type Marker } from '@director/engine';
import { tokenSimilarity } from '../aligner/similarity';
import type { TimelineWord } from '../transcribe/timeline';
import type { CutRange } from '../autocut';

export interface Attempt { line: number; startWord: number; endWord: number; start: number; end: number; coverage: number; complete: boolean; reason?: string }
export interface BestTakePlan { attempts: Attempt[]; chosen: Attempt[]; missingLines: number[]; cuts: CutRange[] }

/** Find every attempt at a script line in the transcript: a run that starts like the line and follows it. */
export function findAttempts(script: ParsedScript, words: TimelineWord[]): Attempt[] {
  const tw = words.map((w) => normalizeWord(w.text));
  const out: Attempt[] = [];
  for (const line of script.lines) {
    if (!line.wordCount) continue;
    const lw = script.words.slice(line.firstWord, line.firstWord + line.wordCount).map((w) => w.norm);
    const heads = new Set(lw.slice(0, Math.min(2, lw.length)));
    for (let k = 0; k < tw.length; k++) {
      if (!heads.has(tw[k]!)) continue;
      // Only begin at the line's first word, or its second when the first was dropped.
      if (tw[k] !== lw[0] && (lw.length < 2 || tw[k] !== lw[1] || (k > 0 && tw[k - 1] === lw[0]))) continue;
      // Greedy in-order match: each script word may be found within the next three transcript words
      // (tolerating an "um" or a misheard word); script words the reader skipped are passed over.
      let matched = 0;
      let lastT = -1;
      let lastL = -1;
      let ti = k;
      for (let li = 0; li < lw.length && ti < tw.length; li++) {
        let found = -1;
        for (let d = 0; d <= 2 && ti + d < tw.length; d++) if (tokenSimilarity(tw[ti + d]!, lw[li]!) > 0.6) { found = ti + d; break; }
        if (found < 0) continue;
        matched++; lastT = found - k; lastL = li; ti = found + 1;
      }
      if (lastT < 0) continue;
      const coverage = matched / lw.length;
      const complete = coverage >= 0.8 && lastL >= lw.length - 2;
      out.push({ line: line.index, startWord: k, endWord: k + lastT, start: words[k]!.start, end: words[k + lastT]!.end, coverage, complete });
    }
  }
  // An attempt cut short by a restart of the same line is not clean.
  for (const a of out) {
    const restart = out.find((b) => b.line === a.line && b.startWord > a.startWord && b.startWord <= a.endWord);
    if (restart) { a.complete = false; a.reason = 'restarted'; a.endWord = restart.startWord - 1; a.end = words[Math.max(a.startWord, restart.startWord - 1)]!.end; }
  }
  return out.sort((x, y) => x.start - y.start);
}

/**
 * Pick the last complete attempt of each line. A retake marker for a line (from the recorder's R key)
 * rules out that line's attempts that started before it.
 */
export function planBestTake(script: ParsedScript, words: TimelineWord[], markers: Marker[], timelineEnd: number, pad = 60_000): BestTakePlan {
  const attempts = findAttempts(script, words);
  const retakes = markers.filter((m) => m.kind === 'retake').map((m) => ({ t: m.t, line: typeof m.data?.line === 'number' ? (m.data.line as number) : null }));
  // Pressing R means "that last attempt was bad": rule out the attempt of the marked line (or, when the
  // marker names no line, of any line) that started most recently before the marker.
  for (const r of retakes) {
    const before = attempts.filter((a) => a.start < r.t && (r.line == null || r.line === a.line));
    const last = before.sort((x, y) => y.start - x.start)[0];
    if (last) { last.complete = false; last.reason = 'retake marker'; }
  }
  const chosen: Attempt[] = [];
  const missingLines: number[] = [];
  let cursor = -1; // keep script order: each chosen attempt must come after the previous one
  for (const line of script.lines.filter((l) => l.wordCount)) {
    const cands = attempts.filter((a) => a.line === line.index && a.complete && a.start > cursor);
    const pick = cands[cands.length - 1] ?? attempts.filter((a) => a.line === line.index && a.start > cursor).sort((a, b) => b.coverage - a.coverage)[0];
    if (!pick) { missingLines.push(line.index); continue; }
    chosen.push(pick);
    cursor = pick.start;
  }
  // No script line found in the recording (wrong script, or no transcript): cut nothing rather than everything.
  if (!chosen.length) return { attempts, chosen, missingLines, cuts: [] };
  // Everything outside the chosen attempts (with a little air) is cut.
  const keeps = chosen.map((a, i) => ({
    from: Math.max(0, a.start - pad, i > 0 ? Math.min(a.start, chosen[i - 1]!.end) : 0),
    to: Math.min(timelineEnd, a.end + pad),
  })).sort((x, y) => x.from - y.from);
  const cuts: CutRange[] = [];
  let at = 0;
  for (const k of keeps) {
    if (k.from > at) cuts.push({ from: at, to: k.from, reason: 'retake', label: 'Outside the best takes' });
    at = Math.max(at, k.to);
  }
  if (at < timelineEnd) cuts.push({ from: at, to: timelineEnd, reason: 'retake', label: 'After the last line' });
  return { attempts, chosen, missingLines, cuts: cuts.filter((c) => c.to - c.from > 10_000) };
}
