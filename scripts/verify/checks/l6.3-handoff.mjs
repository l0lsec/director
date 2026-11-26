import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';
import { libCall } from '../swipe-lib.mjs';

const TEXT = `[HOOK] Stop posting videos nobody finishes.
Here is the rule I use. [EMPHASIS]
[ZOOM] Cut anything that does not earn the next second.
[PAUSE]
[B-ROLL: timeline with gaps removed] Then change the picture often.
[SCREEN: export settings] Export at the right size.
[NOTE: smile here] That is it.
[CTA] Follow for one rule a day.`;

export default async function () {
  const { app, win } = await launchWithFakeDevices();
  try {
    await win.waitForFunction(() => !!globalThis.__directorLib, null, { timeout: 20_000 });
    const brandId = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    const s = await libCall(win, 'studio.createScript', brandId, { title: 'Handoff', text: 'draft one', wpm: 150 });
    const v2 = await libCall(win, 'studio.saveVersion', brandId, s.id, { text: TEXT, wpm: 172, note: 'final' });
    assert(v2.current.n === 2, `version ${v2.current.n}`);
    // Send from the Script studio UI.
    await win.click('[data-testid="tab-script"]');
    await win.click(`[data-script="${s.id}"]`);
    await win.waitForFunction((t) => document.querySelector('[data-testid="script-text"]')?.value === t, TEXT);
    await win.click('[data-testid="send-to-prompter"]');
    await win.waitForSelector('[data-testid="workspace-record"]', { state: 'attached' });
    const st = await win.evaluate(() => { const r = globalThis.__directorRecord.get(); return { text: r.scriptText, ref: r.scriptRef, wpm: r.wpm, cues: r.script.cues.map((c) => ({ raw: c.raw, kind: c.kind, label: c.label })) }; });
    const raws = TEXT.match(/\[[^\]]*\]/g);
    assert(st.text === TEXT, 'prompter text differs from the saved version');
    assert(st.cues.length === raws.length && st.cues.every((c, i) => c.raw === raws[i]), `cues ${st.cues.map((c) => c.raw).join(' ')} vs ${raws.join(' ')}`);
    const kinds = new Set(st.cues.map((c) => c.kind));
    for (const k of ['hook', 'emphasis', 'zoom', 'pause', 'broll', 'screen', 'note', 'cta']) assert(kinds.has(k), `cue kind ${k} lost`);
    assert(st.ref && st.ref.scriptId === s.id && st.ref.version === 2, `scriptRef ${JSON.stringify(st.ref)}`);
    assert(st.wpm === 172, `wpm ${st.wpm}`);
    // The take records the version, on disk too.
    await recordFor(win, 2500);
    const res = await stopAndGet(win);
    assert(res.take.script.scriptId === s.id && res.take.script.version === 2 && res.take.script.text === TEXT, `take script ${JSON.stringify(res.take.script).slice(0, 200)}`);
    const disk = JSON.parse(readFileSync(join(res.dir, 'take.json'), 'utf8'));
    assert(disk.script.scriptId === s.id && disk.script.version === 2, 'take.json lost the script version');
    // And the project made from the take points at it.
    await win.evaluate((e) => globalThis.__directorRecord.sendToEditor(e), res);
    await win.waitForFunction(() => !!globalThis.__directorProject?.().doc?.scriptRef, null, { timeout: 15_000 });
    const doc = await win.evaluate(() => globalThis.__directorProject().doc);
    assert(doc.scriptRef.scriptId === s.id && doc.scriptRef.version === 2 && doc.scriptText === TEXT, `project scriptRef ${JSON.stringify(doc.scriptRef)}`);
    // Editing the text in Record drops the reference (it no longer matches a saved version).
    await win.click('[data-testid="tab-record"]');
    await win.fill('[data-testid="script-input"]', `${TEXT}\nAd lib.`);
    assert((await win.evaluate(() => globalThis.__directorRecord.get().scriptRef)) === null, 'edited text keeps a stale version reference');
    return `all ${raws.length} cues (8 kinds) and script ${s.id} v2 reached the prompter, the take (memory and take.json) and the project`;
  } finally { await app.close(); }
}
