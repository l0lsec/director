import { assert, vitest } from '../lib.mjs';
import { launchEditor, speechProject } from '../edit-lib.mjs';

export default async function () {
  const unit = vitest(['packages/analysis/test/m4.test.ts'], { min: 1, pattern: 'deletes selected words' });
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    await speechProject(win, 'speech.wav');
    const r = await win.evaluate(async () => {
      const T = globalThis.__directorTranscript;
      const before = T.words();
      const docBefore = JSON.stringify(globalThis.__directorProject().doc.lanes);
      T.select(6, 7); // "Ask me"
      await new Promise((x) => setTimeout(x, 50));
      globalThis.__directorTranscript.del(); // fresh reference: the panel re-renders with the new selection
      await new Promise((x) => setTimeout(x, 100));
      const after = globalThis.__directorTranscript.words();
      const lanes = globalThis.__directorProject().doc.lanes;
      globalThis.__directorUndo();
      await new Promise((x) => setTimeout(x, 50));
      const restored = JSON.stringify(globalThis.__directorProject().doc.lanes) === docBefore;
      return { before: before.map((w) => [w.text, w.start, w.end]), after: after.map((w) => [w.text, w.start, w.end]), restored, voiceClips: lanes.find((l) => l.kind === 'voice').clips.length };
    });
    const b = r.before, a = r.after;
    assert(b[6][0].toLowerCase().startsWith('ask') && b[7][0].toLowerCase().startsWith('me'), `selected ${b[6][0]} ${b[7][0]}`);
    assert(!a.some((w, i) => i === 6 && /^ask/i.test(w[0])), 'words removed');
    const removed = b[8][1] - b[6][1];
    const frame = 1_000_000 / 30;
    // The next word now starts where the deleted ones began; later words moved by exactly the removed span.
    assert(Math.abs(a[6][1] - b[6][1]) <= frame, `cut not at the word boundary: ${a[6][1]} vs ${b[6][1]}`);
    assert(Math.abs((b[b.length - 1][1] - a[a.length - 1][1]) - removed) <= frame, 'later words shifted by the removed span');
    assert(r.restored, 'one undo restores');
    return `${unit}; deleted "${b[6][0]} ${b[7][0]}" (${(removed / 1e6).toFixed(2)} s), cut at the word boundary, undo restored`;
  } finally { await app.close(); }
}
