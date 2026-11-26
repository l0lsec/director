// Who is speaking when, in a single-camera or split-screen (remote interview) video, from lip movement.
// Input: face samples with a mouth-opening measure per face (Apple Vision landmarks, see director-native faces --mouth)
// and the transcript words (source time). Output: panels, speaker turns snapped to word boundaries, and a shot plan.

/** A rectangle in normalized source coordinates (0..1, top-left origin). */
export interface Rect { x: number; y: number; w: number; h: number }
export interface MouthFace extends Rect { c?: number; m?: number }
/** One analyzed frame: t in source seconds. */
export interface MouthSample { t: number; faces: MouthFace[] }
export interface SpeechWord { text: string; start: number; end: number }
/** A run of words by one person. Times are source microseconds. */
export interface SpeakerTurn { panel: number; start: number; end: number; words: number; text: string }
export interface SpeakerAnalysis {
  /** Where each person is in the frame (normalized), left to right. */
  panels: Rect[];
  /** The median face box per panel (normalized source coordinates), or null if never seen. */
  faces: Array<Rect | null>;
  turns: SpeakerTurn[];
  /** Seconds of speech per panel. */
  talk: number[];
  /** How sure the lip signal was, 0..1 (share of speech where one panel clearly led). */
  confidence: number;
}

const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2; };
const pct = (a: number[], p: number) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]!; };

/**
 * Split the content area into side-by-side panels, one per person. People are found by clustering face centers;
 * a split-screen recording gives two (or three) well separated groups, a single camera gives one.
 */
export function detectPanels(samples: MouthSample[], content: Rect = { x: 0, y: 0, w: 1, h: 1 }): Rect[] {
  const xs = samples.flatMap((s) => s.faces.filter((f) => (f.c ?? 1) >= 0.5 && f.w * f.h > 0.0005).map((f) => (f.x + f.w / 2 - content.x) / content.w));
  if (xs.length < 5) return [content];
  // Try equal columns for n = 3, 2: each column must hold a steady share of faces, and faces must sit near column centers.
  for (const n of [3, 2]) {
    const counts = new Array(n).fill(0);
    let off = 0;
    for (const x of xs) { const i = Math.min(n - 1, Math.max(0, Math.floor(x * n))); counts[i]++; off += Math.abs(x * n - (i + 0.5)); }
    const share = counts.map((c) => c / xs.length);
    if (share.every((s) => s >= 0.6 / n) && off / xs.length < 0.3) {
      return Array.from({ length: n }, (_, i) => ({ x: content.x + (content.w * i) / n, y: content.y, w: content.w / n, h: content.h }));
    }
  }
  return [content];
}

const inside = (f: Rect, p: Rect) => { const cx = f.x + f.w / 2, cy = f.y + f.h / 2; return cx >= p.x && cx < p.x + p.w && cy >= p.y && cy < p.y + p.h; };

/** Per panel: the largest face in each sample (or null). */
function facesByPanel(samples: MouthSample[], panels: Rect[]): Array<Array<MouthFace | null>> {
  return panels.map((p) => samples.map((s) => s.faces.filter((f) => inside(f, p)).sort((a, b) => b.w * b.h - a.w * a.h)[0] ?? null));
}

/** Lip activity per panel per sample: the spread of mouth opening over a short window, above that panel's resting level. */
function lipActivity(samples: MouthSample[], byPanel: Array<Array<MouthFace | null>>, halfWindow = 0.4): number[][] {
  const ts = samples.map((s) => s.t);
  return byPanel.map((faces) => {
    const raw: number[] = new Array(samples.length).fill(0);
    let lo = 0, hi = 0;
    for (let i = 0; i < samples.length; i++) {
      while (ts[lo]! < ts[i]! - halfWindow) lo++;
      while (hi + 1 < samples.length && ts[hi + 1]! <= ts[i]! + halfWindow) hi++;
      const ms: number[] = [];
      for (let j = lo; j <= hi; j++) { const m = faces[j]?.m; if (m != null) ms.push(m); }
      if (ms.length < 2) continue;
      const mean = ms.reduce((a, b) => a + b, 0) / ms.length;
      raw[i] = Math.sqrt(ms.reduce((a, b) => a + (b - mean) ** 2, 0) / ms.length);
    }
    const floor = pct(raw.filter((v) => v > 0), 0.1) ?? 0;
    return raw.map((v) => Math.max(0, v - floor));
  });
}

export interface SpeakerOptions {
  /** Content area inside letterbox bars (normalized). */
  content?: Rect;
  /** Force the panels instead of finding them. */
  panels?: Rect[];
  /** Cost of switching speaker, in seconds of contrary evidence (default 0.6). */
  switchCost?: number;
}

/** Who speaks each word, smoothed with a switching cost, merged into turns. */
export function analyzeSpeakers(samples: MouthSample[], words: SpeechWord[], opts: SpeakerOptions = {}): SpeakerAnalysis {
  const sorted = [...samples].filter((s) => Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
  const panels = opts.panels ?? detectPanels(sorted, opts.content);
  const byPanel = facesByPanel(sorted, panels);
  const faces = byPanel.map((fs) => {
    const seen = fs.filter((f): f is MouthFace => !!f);
    if (!seen.length) return null;
    return { x: median(seen.map((f) => f.x)), y: median(seen.map((f) => f.y)), w: median(seen.map((f) => f.w)), h: median(seen.map((f) => f.h)) };
  });
  const ws = [...words].filter((w) => w.end > w.start).sort((a, b) => a.start - b.start);
  const P = panels.length;
  if (P === 1 || !ws.length || !sorted.length) {
    const turns = ws.length ? [{ panel: 0, start: ws[0]!.start, end: ws[ws.length - 1]!.end, words: ws.length, text: ws.map((w) => w.text).join(' ') }] : [];
    return { panels, faces, turns, talk: [ws.reduce((n, w) => n + (w.end - w.start), 0) / 1e6, ...new Array(P - 1).fill(0)], confidence: P === 1 ? 1 : 0 };
  }
  const act = lipActivity(sorted, byPanel);
  const ts = sorted.map((s) => s.t * 1e6);
  // Evidence per word: mean activity of each panel across the word (padded a little, lips lead the sound).
  let lo = 0;
  const ev: number[][] = ws.map((w) => {
    const a = w.start - 120_000, b = w.end + 60_000;
    while (lo < ts.length && ts[lo]! < a) lo++;
    const sums = new Array(P).fill(0); let n = 0;
    for (let j = lo; j < ts.length && ts[j]! <= b; j++) { for (let p = 0; p < P; p++) sums[p] += act[p]![j]!; n++; }
    return n ? sums.map((s) => s / n) : sums;
  });
  // Viterbi over words. Cost: -log share of activity; switching costs switchCost seconds of contrary evidence.
  const switchCost = opts.switchCost ?? 0.6;
  const cost = ws.map((w, i) => {
    const evi = ev[i]!;
    const tot = evi.reduce((a, b) => a + b, 0);
    const dur = Math.max(0.08, (w.end - w.start) / 1e6);
    return evi.map((e) => (tot > 0 ? -Math.log((e + 0.02 * tot) / (tot * (1 + 0.02 * P))) : Math.log(P)) * dur);
  });
  const penalty = switchCost * Math.log(4);
  let prev = cost[0]!.slice();
  const back: number[][] = [];
  for (let i = 1; i < ws.length; i++) {
    const gap = Math.max(0, (ws[i]!.start - ws[i - 1]!.end) / 1e6);
    // A pause makes a change of speaker cheaper.
    const sw = penalty / (1 + gap * 2);
    const cur = new Array(P).fill(0), bk = new Array(P).fill(0);
    for (let p = 0; p < P; p++) {
      let best = Infinity, arg = 0;
      for (let q = 0; q < P; q++) { const v = prev[q]! + (q === p ? 0 : sw); if (v < best) { best = v; arg = q; } }
      cur[p] = best + cost[i]![p]!; bk[p] = arg;
    }
    back.push(bk); prev = cur;
  }
  const who: number[] = new Array(ws.length).fill(0);
  who[ws.length - 1] = prev.indexOf(Math.min(...prev));
  for (let i = ws.length - 1; i > 0; i--) who[i - 1] = back[i - 1]![who[i]!]!;
  // Turns: runs of words by the same panel.
  const turns: SpeakerTurn[] = [];
  for (let i = 0; i < ws.length; i++) {
    const last = turns[turns.length - 1];
    const w = ws[i]!;
    if (last && last.panel === who[i]) { last.end = w.end; last.words++; last.text += ` ${w.text}`; }
    else turns.push({ panel: who[i]!, start: w.start, end: w.end, words: 1, text: w.text });
  }
  const talk = new Array(P).fill(0);
  let clear = 0, total = 0;
  ws.forEach((w, i) => {
    const d = (w.end - w.start) / 1e6; talk[who[i]!] += d; total += d;
    const s = [...ev[i]!].sort((a, b) => b - a);
    if (s[0]! > 0 && s[0]! >= 1.5 * (s[1] ?? 0)) clear += d;
  });
  return { panels, faces, turns, talk: talk.map((t) => Math.round(t * 10) / 10), confidence: total ? Math.round((clear / total) * 100) / 100 : 0 };
}

/** A shot in the speaker edit. Times are source microseconds. */
export type SpeakerShot =
  | { kind: 'solo'; panel: number; start: number; end: number; zoom: number }
  | { kind: 'all'; start: number; end: number };

export interface SpeakerShotOptions {
  /** Shortest shot in seconds (default 2.5). Shorter turns become an all-speakers shot or join a neighbour. */
  minShot?: number;
  /** Longest single shot in seconds before changing the framing (default 9). */
  maxShot?: number;
  /** Extra zoom for the tighter framing of a solo shot (default 0.18 = 18% closer). 0 keeps every solo shot the same. */
  punchIn?: number;
  /** Show everyone when the conversation goes back and forth quickly (default true). */
  splitOnExchange?: boolean;
  /** Seconds of the next speaker's lead-in before their first word (default 0.12). */
  lead?: number;
  /** In a long answer, every Nth framing shows everyone (the listener's reaction); default 4, 0 = never. */
  reactionEvery?: number;
}

/**
 * The shot plan from `from` to `to` (source µs): a close shot of whoever is talking, everyone during quick exchanges,
 * long answers broken at pauses with alternating framing so the picture keeps moving.
 */
export function planSpeakerShots(a: SpeakerAnalysis, words: SpeechWord[], from: number, to: number, o: SpeakerShotOptions = {}): SpeakerShot[] {
  const minShot = (o.minShot ?? 2.5) * 1e6, maxShot = (o.maxShot ?? 9) * 1e6, lead = (o.lead ?? 0.12) * 1e6;
  const punch = o.punchIn ?? 0.18, split = o.splitOnExchange ?? true, reactionEvery = Math.max(0, Math.round(o.reactionEvery ?? 4));
  const P = a.panels.length;
  const turns = a.turns.filter((t) => t.end > from && t.start < to).map((t) => ({ ...t, start: Math.max(from, t.start), end: Math.min(to, t.end) }));
  if (!turns.length) return [{ kind: 'all', start: from, end: to }];
  // Cut points between turns: just before the next speaker's first word, never before the previous word ends.
  type Seg = { panel: number | -1; start: number; end: number };
  const segs: Seg[] = turns.map((t) => ({ panel: t.panel, start: t.start, end: t.end }));
  for (let i = 1; i < segs.length; i++) { const a = segs[i - 1]!, b = segs[i]!; const cut = Math.max(a.end, b.start - lead); a.end = cut; b.start = cut; }
  segs[0]!.start = from; segs[segs.length - 1]!.end = to;
  // Short turns: an exchange becomes an all shot (when there is more than one person), otherwise joins the previous shot.
  const merged: Seg[] = [];
  for (let k = 0; k < segs.length; k++) {
    const s = segs[k]!;
    // A brief interjection inside someone else's answer ("right", a laugh, a quick aside) shows both people.
    const around = segs[k - 1] && segs[k + 1] && segs[k - 1]!.panel === segs[k + 1]!.panel && segs[k - 1]!.panel !== s.panel;
    const short = s.end - s.start < minShot || (around && s.end - s.start < minShot * 1.6);
    const last = merged[merged.length - 1];
    if (short && P > 1 && split) {
      if (last && last.panel === -1) last.end = s.end; else merged.push({ panel: -1, start: s.start, end: s.end });
    } else if (short && last) last.end = s.end;
    else if (last && last.panel === s.panel) last.end = s.end;
    else merged.push({ ...s });
  }
  // An all shot that is still too short takes time from its neighbours, or folds into the next shot.
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i]!;
    if (s.panel !== -1 || s.end - s.start >= minShot) continue;
    const need = minShot - (s.end - s.start);
    const next = merged[i + 1], prev = merged[i - 1];
    if (next && next.end - next.start - need >= minShot) { s.end += need; next.start = s.end; }
    else if (prev && prev.end - prev.start - need >= minShot) { s.start -= need; prev.end = s.start; }
  }
  const tidy: Seg[] = [];
  for (const s of merged) { const last = tidy[tidy.length - 1]; if (last && (last.panel === s.panel || s.end - s.start < minShot / 2)) last.end = s.end; else tidy.push({ ...s }); }
  // Long solo shots: break at pauses near every maxShot, alternating wide and tight framing.
  const gaps = words.filter((w) => w.end > from && w.start < to).sort((x, y) => x.start - y.start);
  // Cut points between words, with how long the pause is: real pauses are preferred, any word boundary will do.
  const pauses: Array<{ t: number; gap: number }> = [];
  for (let i = 1; i < gaps.length; i++) { const a = gaps[i - 1]!, b = gaps[i]!; pauses.push({ t: Math.round((b.start + a.end) / 2), gap: Math.max(0, b.start - a.end) }); }
  const shots: SpeakerShot[] = [];
  // Each person alternates between wide and tight framing from one shot of them to the next.
  const tightFor = new Array(P).fill(false);
  for (const s of tidy) {
    if (s.panel === -1) { shots.push({ kind: 'all', start: s.start, end: s.end }); continue; }
    let tight = tightFor[s.panel];
    let start = s.start;
    let part = 0;
    while (s.end - start > maxShot) {
      // The pause nearest the ideal length, keeping both parts at least minShot long.
      const ideal = start + Math.min(maxShot, Math.max(minShot * 2, (s.end - start) / Math.ceil((s.end - start) / maxShot)));
      const cands = pauses.filter((p) => p.t - start >= minShot * 1.5 && s.end - p.t >= minShot && p.t - start <= maxShot * 1.4);
      if (!cands.length) break;
      // Score: distance from the ideal length, minus a bonus for a longer pause (a 0.5 s pause is worth 2 s of drift).
      const score = (p: { t: number; gap: number }) => Math.abs(p.t - ideal) - Math.min(p.gap, 600_000) * 4;
      const cut = cands.reduce((b, p) => (score(p) < score(b) ? p : b)).t;
      part++;
      if (P > 1 && reactionEvery > 0 && part % reactionEvery === 0) shots.push({ kind: 'all', start, end: cut });
      else { shots.push({ kind: 'solo', panel: s.panel, start, end: cut, zoom: tight ? 1 + punch : 1 }); tight = !tight; }
      start = cut;
    }
    shots.push({ kind: 'solo', panel: s.panel, start, end: s.end, zoom: tight ? 1 + punch : 1 });
    tightFor[s.panel] = !tight;
  }
  return shots;
}

/**
 * Each shot framed on where the faces are during that shot (median), the way a camera operator reframes between
 * cuts; people lean and drift over a long recording. Falls back to the whole-video face when a shot has none.
 */
export function frameShots(shots: SpeakerShot[], samples: MouthSample[], a: SpeakerAnalysis): Array<SpeakerShot & { face?: Rect; faces?: Array<Rect | null> }> {
  const sorted = [...samples].sort((x, y) => x.t - y.t);
  const byPanel = facesByPanel(sorted, a.panels);
  const ts = sorted.map((x) => x.t * 1e6);
  const faceIn = (p: number, start: number, end: number): Rect | null => {
    const seen: MouthFace[] = [];
    for (let i = 0; i < ts.length; i++) { if (ts[i]! < start) continue; if (ts[i]! > end) break; const f = byPanel[p]![i]; if (f) seen.push(f); }
    if (seen.length < 3) return a.faces[p] ?? null;
    return { x: median(seen.map((f) => f.x)), y: median(seen.map((f) => f.y)), w: median(seen.map((f) => f.w)), h: median(seen.map((f) => f.h)) };
  };
  return shots.map((sh) => sh.kind === 'solo'
    ? { ...sh, face: faceIn(sh.panel, sh.start, sh.end) ?? undefined }
    : { ...sh, faces: a.panels.map((_, p) => faceIn(p, sh.start, sh.end)) });
}
