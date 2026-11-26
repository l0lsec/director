import { assert } from '../lib.mjs';
import { launchEditor } from '../edit-lib.mjs';

export default async function () {
  const { app, win } = await launchEditor({ preset: 'vertical-1080' });
  try {
    const r = await win.evaluate(() => {
      const E = globalThis.__directorEngine;
      const base = globalThis.__directorProject().doc;
      const lane = (k) => base.lanes.find((l) => l.kind === k).id;
      const mk = (id, start, content, spec, y) => ({ ...E.newClip({ kind: 'text', start, out: 2_000_000 }), id, transform: { ...E.defaultTransform(), y: { value: y } }, text: { font: 'Inter', align: 'center', lineHeight: 1.05, maxWidth: 0.8, size: 80, weight: 900, color: '#fff', ...spec, content } });
      const doc = globalThis.__directorAnalysisApply(base, [
        { op: 'addClip', laneId: lane('titles'), clip: mk('a', 1_000_000, 'Original title', { stroke: { color: '#000', width: 8 }, animationIn: 'pop' }, -500) },
        { op: 'addClip', laneId: lane('graphics'), clip: mk('b', 1_400_000, 'Original lower', { box: { color: '#000', padding: 20, radius: 12 }, size: 50 }, 600) },
      ]);
      const tpl = E.makeTemplate(doc, ['a', 'b'], 'Intro');
      const json = JSON.parse(JSON.stringify(tpl)); // survives storage
      const after = globalThis.__directorAnalysisApply(doc, E.applyTemplateOps(doc, json, 10_000_000, ['New title', 'New lower']));
      const placed = after.lanes.flatMap((l) => l.clips.map((c) => ({ ...c, lane: l.kind }))).filter((c) => c.start >= 10_000_000);
      const orig = after.lanes.flatMap((l) => l.clips.map((c) => ({ ...c, lane: l.kind }))).filter((c) => c.id === 'a' || c.id === 'b');
      return { placed, orig, placeholders: tpl.clips.map((c) => c.placeholder) };
    });
    assert(r.placeholders.join() === 'Text 1,Text 2', `placeholders ${r.placeholders}`);
    assert(r.placed.length === 2, `placed ${r.placed.length}`);
    for (const [i, o] of r.orig.entries()) {
      const p = r.placed.find((x) => x.lane === o.lane);
      const strip = (c) => JSON.stringify({ lane: c.lane, rel: c.start - (i === 0 ? 0 : 0), transform: c.transform, text: { ...c.text, content: undefined }, out: c.out, fit: c.fit, effects: c.effects });
      assert(p.lane === o.lane && p.start - 10_000_000 === o.start - 1_000_000, `timing/lane of ${o.id}`);
      assert(strip({ ...p, start: 0 }) === strip({ ...o, start: 0 }), `layout of ${o.id} changed`);
    }
    assert(r.placed.find((x) => x.lane === 'titles').text.content === 'New title' && r.placed.find((x) => x.lane === 'graphics').text.content === 'New lower', 'placeholder text replaced');
    return 'template saved, stored as JSON, applied at 10 s with new text: lanes, timing, transforms and styles identical';
  } finally { await app.close(); }
}
