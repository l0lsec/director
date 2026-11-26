import { assert, groundTruth } from '../lib.mjs';
import { launchEditor, importFixtures, addToTimeline } from '../edit-lib.mjs';

export default async function () {
  const g = groundTruth().speechGaps;
  const { app, win } = await launchEditor();
  try {
    const [speech, tone] = await importFixtures(win, ['speech-gaps.wav', 'tone-440.wav']);
    await addToTimeline(win, speech, 0, 'voice');
    for (let t = 0; t < 14e6; t += 4e6) await addToTimeline(win, tone, t, 'music');
    const r = await win.evaluate(async ({ g, speech }) => {
      const d0 = globalThis.__directorProject().doc;
      const musicClips = d0.lanes.find((l) => l.kind === 'music').clips;
      globalThis.__directorProjectApply([
        { op: 'setMeta', patch: { transcript: [{ mediaId: speech, language: 'en', words: g.words.map((w) => ({ text: w.text, start: Math.round(w.start * 1e6), end: Math.round(w.end * 1e6) })) }] } },
        ...musicClips.map((c) => ({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, duckable: true }, meta: { duckDb: -12 } } })),
      ], 'duck setup');
      const { lib } = globalThis.__directorMedia;
      const render = async (doc) => {
        const ctx = new OfflineAudioContext(1, 48000 * 14, 48000);
        await lib.buildMix(ctx, doc, new lib.AudioCache(new lib.MediaPool(), (c, l, rr) => new AudioBuffer({ numberOfChannels: c, length: l, sampleRate: rr })), { fromUs: 0, startAt: 0 });
        return (await ctx.startRendering()).getChannelData(0);
      };
      const doc = globalThis.__directorProject().doc;
      const full = await render(doc);
      const voiceOnly = await render(globalThis.__directorAnalysisApply(doc, doc.lanes.find((l) => l.kind === 'music').clips.map((c) => ({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, muted: true } } }))));
      const music = full.map((v, i) => v - voiceOnly[i]);
      const rms = (a, b) => { let s = 0; const i0 = Math.round(a * 48000), i1 = Math.round(b * 48000); for (let i = i0; i < i1; i++) s += music[i] * music[i]; return 20 * Math.log10(Math.sqrt(s / (i1 - i0)) + 1e-12); };
      const intervals = lib.speechIntervals(doc).map((x) => [x.from / 1e6, x.to / 1e6]);
      // Level 100 ms after each speech start vs. clear of speech; and recovery after the release.
      const first = intervals[0];
      return { intervals, open: rms(0.05, Math.max(0.1, first[0] - 0.05)), ducked: intervals.map(([a, b]) => (b - a > 0.4 ? rms(a + 0.1, b - 0.05) : null)).filter((x) => x != null), at100: intervals.filter(([a], i) => i === 0 || a - intervals[i - 1][1] > 0.4).map(([a]) => rms(a + 0.1, a + 0.14)), recovered: intervals.slice(1).map(([a], i) => [intervals[i][1], a]).filter(([e, s]) => s - e > 0.7).map(([e, s]) => rms(e + 0.35, s - 0.05)) };
    }, { g, speech });
    const lines = [`open ${r.open.toFixed(1)} dB`, `ducked ${r.ducked.map((x) => x.toFixed(1)).join('/')} dB`, `recovered in long pauses ${r.recovered.map((x) => x.toFixed(1)).join('/')} dB`];
    for (const d of r.ducked) assert(Math.abs(d - r.open + 12) <= 1, `ducked level off: ${lines.join(', ')}`);
    for (const d of r.at100) assert(d - r.open <= -10.5, `not ducked 100 ms into speech (${(d - r.open).toFixed(1)} dB): ${lines.join(', ')}`);
    assert(r.recovered.length >= 2 && r.recovered.every((x) => Math.abs(x - r.open) <= 0.5), `did not recover: ${lines.join(', ')}`);
    return `music ${lines.join(', ')} over ${r.intervals.length} speech intervals`;
  } finally { await app.close(); }
}
