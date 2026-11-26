import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, fixture, groundTruth, tmp } from '../lib.mjs';
import { launchWithFakeDevices, recordFor, stopAndGet } from '../capture-lib.mjs';
import { call, libCall, responses, requestLog, openProject, speechEdit } from '../swipe-lib.mjs';
import { fillLane } from '../edit-lib.mjs';

// Reference import -> analysis -> structure (Claude) -> drafted script (Claude) -> prompter and a take ->
// Make Reel -> Director pass (Claude) -> one undo. Claude responses are recorded fixtures; the Director's
// is written for the timeline Make Reel produced, then picked up by the app's replay transport.
const msg = (data, usage) => ({ id: 'msg_e2e', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: JSON.stringify(data) }], stop_reason: 'end_turn', stop_details: null, usage });

export default async function () {
  const g = groundTruth();
  const R = responses();
  const lines = g.retakes.lines;
  const script = [`[HOOK] ${lines[0]}`, lines[1], `[ZOOM] ${lines[2]}`, `[B-ROLL: phone screen] ${lines[3]}`, lines[4], `[CTA] ${lines[5]}`].join('\n');
  const draft = msg({ title: 'Better prompts', hook: lines[0], script, notes: 'Callout hook, one tip per shot, save prompt, as in the reference.' }, { input_tokens: 2100, output_tokens: 400, cache_read_input_tokens: 0, cache_creation_input_tokens: 900 });
  const work = tmp('node6-e2e');
  const replayPath = join(work, 'replay.json');
  const log = join(work, 'requests.jsonl');
  writeFileSync(log, '');
  writeFileSync(replayPath, JSON.stringify({ structure: R.structure.reel, draft }));
  const { app, win } = await launchWithFakeDevices({ DIRECTOR_CLAUDE_REPLAY: replayPath, DIRECTOR_CLAUDE_LOG: log, DIRECTOR_SHOW: '1' });
  try {
    await win.waitForFunction(() => !!globalThis.__directorLib, null, { timeout: 20_000 });
    const b = await win.evaluate(() => globalThis.__directorLib.activeBrand());
    // 1. Swipe: import, analyze, label.
    const [ref] = (await call(win, 'swipe:import', { brandId: b, paths: [fixture('reference-reel.mp4')] })).added;
    const a = await call(win, 'swipe:analyze', { brandId: b, id: ref.id });
    assert(a.shots.length === 8 && a.transcribed, `analysis: ${a.shots.length} shots, transcribed ${a.transcribed}`);
    const { structure } = await call(win, 'claude:structure', { brandId: b, refId: ref.id });
    assert(structure.segments[0].label === 'hook', 'structure');
    // 2. Script: draft from the reference in a voice, save, send to the prompter.
    const voice = await libCall(win, 'studio.createVoice', b, { name: 'Coach', wpm: 160 });
    const d = await call(win, 'claude:draft', { brandId: b, voiceId: voice.id, topic: 'Better prompts', targetSec: 17, refId: ref.id, requestId: 'e2e' });
    assert(d.withinTolerance && d.revisions === 0, `draft ${d.estimateSec} s`);
    const s = await libCall(win, 'studio.createScript', b, { title: d.draft.title, text: d.draft.script, wpm: 160, targetSec: 17, voiceId: voice.id, refId: ref.id, note: 'drafted with Claude' });
    const sent = await win.evaluate((id) => globalThis.__directorScript.sendToPrompter(id), s.id);
    assert(sent.cues === 4 && sent.version === 1, `prompter: ${JSON.stringify(sent)}`);
    // 3. Record a take from the prompter (fake camera and mic): it carries the script version.
    await win.evaluate(() => { const r = globalThis.__directorRecord; r.setOption('mode', 'wpm'); r.setOption('countdownSeconds', 0); });
    await recordFor(win, 2000);
    const take = await stopAndGet(win);
    assert(take.take.script.scriptId === s.id && take.take.script.version === 1, 'take lost the script version');
    // 4. Edit: the delivered performance (the retakes fixture reads this script with retakes and an ad-lib).
    await openProject(win);
    await speechEdit(win, { voicePath: fixture('retakes.wav'), cameraPath: fixture('vertical-1080x1920.mp4'), durationUs: 5_000_000 });
    const camId = await win.evaluate(() => globalThis.__directorProject().doc.lanes.find((l) => l.kind === 'camera').clips[0].mediaId);
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; const cam = d.lanes.find((l) => l.kind === 'camera'); globalThis.__directorProjectApply(cam.clips.map((c) => ({ op: 'removeClip', id: c.id })), 'clear'); });
    await fillLane(win, camId, 'camera', Math.round(g.retakes.durationSec * 1e6), 5_000_000);
    const keeps = g.retakes.takes.filter((t) => t.kind === 'keep');
    const markers = [
      { id: 'cz', t: Math.round(keeps[2].start * 1e6) - 50_000, kind: 'cue', label: 'ZOOM' },
      { id: 'cb', t: Math.round(keeps[3].start * 1e6) - 50_000, kind: 'cue', label: 'BROLL: phone screen' },
    ];
    await win.evaluate(({ text, markers, ref }) => globalThis.__directorProjectApply([{ op: 'setMeta', patch: { scriptText: text, scriptRef: ref } }, ...markers.map((m) => ({ op: 'addMarker', marker: m }))], 'script'), { text: s.current.text, markers, ref: { scriptId: s.id, version: 1 } });
    await win.click('[data-testid="tab-edit"]');
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'transcript' }));
    await win.waitForFunction(() => !!globalThis.__directorTranscript, null, { timeout: 10_000 });
    await win.evaluate(() => globalThis.__directorTranscript.ensureTranscripts());
    // 5. Make Reel.
    const report = await win.evaluate(() => globalThis.__directorMakeReel.makeReel());
    assert(report.captions >= 8 && report.zooms === 1 && report.brolls === 1 && report.missingLines.length === 0, `Make Reel: ${JSON.stringify(report)}`);
    // 6. Director pass, with a recorded response written for this timeline.
    const doc = await win.evaluate(() => globalThis.__directorProject().doc);
    const cams = doc.lanes.find((l) => l.kind === 'camera').clips.map((c) => ({ start: c.start, end: c.start + (c.out - c.in) })).sort((x, y) => (y.end - y.start) - (x.end - x.start));
    const zc = cams[0];
    const z0 = (zc.start + 300_000) / 1e6, z1 = Math.min(zc.end - 300_000, zc.start + 2_300_000) / 1e6;
    const director = msg({ summary: 'Punch in on a key line, title the hook, flag the CTA.', actions: [
      { type: 'zoom', start: z0, end: z1, text: '', amount: 1.15, reason: 'Emphasis on the key line' },
      { type: 'text', start: 0.2, end: 1.4, text: 'Better prompts', amount: 0, reason: 'Title the hook on screen' },
      { type: 'marker', start: 1.0, end: 1.0, text: 'Check the hook lands in the first second', amount: 0, reason: 'Hook timing' },
    ] }, { input_tokens: 5400, output_tokens: 600, cache_read_input_tokens: 0, cache_creation_input_tokens: 700 });
    const replay = JSON.parse(readFileSync(replayPath, 'utf8'));
    writeFileSync(replayPath, JSON.stringify({ ...replay, structure: [], draft: [], director }));
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'director' }));
    await win.waitForSelector('[data-testid="run-director"]');
    const beforeDirector = JSON.stringify(doc);
    await win.selectOption('select[aria-label="Match a reference\'s pacing"]', ref.id);
    await win.click('[data-testid="run-director"]');
    await win.waitForSelector('[data-testid="apply-director"]:not([disabled])', { timeout: 30_000 });
    await win.click('[data-testid="apply-director"]');
    await win.waitForFunction(() => /^Director:/.test(globalThis.__directorProject().undoLabel ?? ''));
    const after = await win.evaluate(() => globalThis.__directorProject().doc);
    assert(after.lanes.find((l) => l.kind === 'titles').clips.some((c) => c.text?.content === 'Better prompts'), 'Director title missing');
    await win.evaluate(() => globalThis.__directorUndo());
    assert((await win.evaluate(() => JSON.stringify(globalThis.__directorProject().doc))) === beforeDirector, 'one undo did not restore the Make Reel result');
    // 7. What reached Claude: three tasks, text only; the Director saw the reference pacing.
    const reqs = requestLog(log);
    assert(reqs.map((q) => q.task).join() === 'structure,draft,director', `requests ${reqs.map((q) => q.task).join()}`);
    const dj = JSON.stringify(reqs[2].request);
    assert(/Reference pacing: 26\.8 s, 8 shots/.test(dj), 'Director request lacks the reference pacing');
    for (const q of reqs) assert(!JSON.stringify(q.request).includes('/Users/') && !/\.(mp4|wav)\b/.test(JSON.stringify(q.request.messages)), `${q.task} request leaks a path or file name`);
    const st = await call(win, 'claude:status', {});
    return `reference (8 shots, labelled) -> draft ${d.estimateSec.toFixed(1)} s in voice -> prompter (4 cues, v1) -> take with script ref -> Make Reel (${(report.before / 1e6).toFixed(1)} s to ${(report.after / 1e6).toFixed(1)} s, ${report.captions} captions) -> Director pass applied and undone in one step; 3 Claude calls, $${st.usage.costUsd.toFixed(4)}`;
  } finally { await app.close(); }
}
