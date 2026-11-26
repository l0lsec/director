import { mkdirSync, copyFileSync, writeFileSync, statSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { assert, fixture } from '../lib.mjs';
import { call, libCall } from '../swipe-lib.mjs';
import { agentSession, must, tool, appDoc } from '../agent-lib.mjs';

export default async function () {
  const s = await agentSession({ mode: 'auto' });
  const { client, win } = s;
  try {
    const doc = await appDoc(win);
    const camClip = doc.lanes.find((l) => l.kind === 'camera').clips[0].id;
    // Playback and selection: what the agent sets is what the window shows.
    await must(client, 'seek', { t: 7.25 });
    const st1 = await must(client, 'get_state');
    const t = await win.evaluate(() => globalThis.__directorEditCmd.getEdit().t);
    assert(Math.abs(st1.playhead - 7.25) < 0.001 && Math.abs(t / 1e6 - 7.25) < 0.001, `seek: agent ${st1.playhead}, app ${t / 1e6}`);
    await must(client, 'play');
    await win.waitForFunction(() => globalThis.__directorPlayer?.isPlaying, null, { timeout: 10_000 });
    await win.waitForTimeout(500);
    assert((await must(client, 'get_state')).playing, 'play');
    await must(client, 'pause');
    assert(!(await must(client, 'get_state')).playing && !(await win.evaluate(() => globalThis.__directorPlayer.isPlaying)), 'pause');
    await must(client, 'select_clips', { clips: [camClip] });
    assert(JSON.stringify(await win.evaluate(() => globalThis.__directorEditCmd.getEdit().selection)) === JSON.stringify([camClip]), 'selection');
    await must(client, 'show_workspace', { workspace: 'export' });
    await win.waitForSelector('[data-testid="workspace-export"]');
    await must(client, 'show_workspace', { workspace: 'edit' });
    await win.waitForSelector('[data-testid="workspace-edit"]');
    // Projects: save, list, create another, open the first again by name.
    const dir = await win.evaluate(() => globalThis.__directorProject().dir);
    const pj = readdirSync(dir).find((f) => f.endsWith('.json') && f.startsWith('project')) ?? readdirSync(dir).find((f) => f.endsWith('.json'));
    const m0 = statSync(join(dir, pj)).mtimeMs;
    await win.waitForTimeout(20);
    await must(client, 'save_project');
    assert(statSync(join(dir, pj)).mtimeMs > m0, 'save_project did not write the project file');
    const firstName = (await appDoc(win)).name;
    await must(client, 'create_project', { name: 'Second reel', preset: 'square-1080' });
    assert((await appDoc(win)).name === 'Second reel' && (await appDoc(win)).canvas.width === 1080 && (await appDoc(win)).canvas.height === 1080, 'create_project');
    const list = (await must(client, 'list_projects')).projects.map((p) => p.name);
    assert(list.includes(firstName) && list.includes('Second reel'), `list_projects ${list}`);
    await must(client, 'open_project', { project: firstName });
    assert((await appDoc(win)).name === firstName && (await appDoc(win)).lanes.find((l) => l.kind === 'camera').clips[0].id === camClip, 'open_project');
    // Swipe reference: listed with pacing, read without its file path, compared with the edit.
    const imported = await call(win, 'swipe:import', { brandId: (await libCall(win, 'brands.list'))[0].id, paths: [fixture('reference-reel.mp4')] });
    const refId = imported.added[0].id;
    await call(win, 'swipe:analyze', { brandId: (await libCall(win, 'brands.list'))[0].id, id: refId });
    const refs = (await must(client, 'list_references')).references;
    assert(refs.some((r) => r.id === refId && r.pacing?.shotCount === 8), `list_references ${JSON.stringify(refs).slice(0, 200)}`);
    const ref = await must(client, 'get_reference', { id: refId });
    assert(ref.analysis?.pacing && !JSON.stringify(ref).includes(fixture('reference-reel.mp4')), 'get_reference leaks the file path or lacks pacing');
    const cmp = await must(client, 'analyze_pacing', { referenceId: refId });
    assert(cmp.comparison?.length >= 5 && cmp.reference.shotCount === 8, 'analyze_pacing comparison');
    // Scripts: list, read, attach.
    const b = (await libCall(win, 'brands.list'))[0].id;
    const scr = await libCall(win, 'studio.createScript', b, { title: 'Agent script', text: 'Stop typing plain prompts into Claude.\n[ZOOM]\nAsk me questions before you answer.', wpm: 160 });
    const scripts = (await must(client, 'list_scripts')).scripts;
    assert(scripts.some((x) => x.id === scr.id && x.title === 'Agent script'), 'list_scripts');
    const got = await must(client, 'get_script', { id: scr.id });
    assert(/\[ZOOM\]/.test(got.text), 'get_script text');
    await must(client, 'attach_script', { id: scr.id });
    const d1 = await appDoc(win);
    assert(d1.scriptText === got.text && d1.scriptRef?.scriptId === scr.id, 'attach_script');
    // Templates: save from clips, list, apply with new text.
    const title = (await must(client, 'add_text', { text: 'Name here', start: 1, duration: 2, y: 600, box: { color: 'rgba(0,0,0,0.7)', padding: 20, radius: 12 } })).result.clip;
    await must(client, 'save_template', { clips: [title], name: 'Agent lower third' });
    const tpls = (await must(client, 'list_templates')).templates;
    const tp = tpls.find((x) => x.name === 'Agent lower third');
    assert(tp && tp.textSlots === 1, `list_templates ${JSON.stringify(tpls)}`);
    const ap = await must(client, 'apply_template', { template: 'Agent lower third', at: 12, texts: ['Sam Rivera'] });
    const placed = (await appDoc(win)).lanes.flatMap((l) => l.clips).find((c) => c.id === ap.result.clips[0]);
    assert(placed.text.content === 'Sam Rivera' && placed.start === 12_000_000 && placed.text.box, 'apply_template');
    // Audio library folders the person chose.
    await call(win, 'audiolib:setFolders', { folders: [dirname(fixture('click-120bpm.wav'))] });
    const lib = (await must(client, 'list_audio_library', {})).items;
    assert(lib.some((i) => i.name.startsWith('click-120bpm')), `audio library ${lib.map((i) => i.name)}`);
    // A recorded take: listed, then put on the timeline in sync with its markers and script.
    const takeDir = join(dir, 'takes', '2026-11-25 100000 - Agent take');
    mkdirSync(takeDir, { recursive: true });
    copyFileSync(fixture('reference-reel.mp4'), join(takeDir, 'camera.mp4'));
    writeFileSync(join(takeDir, 'take.json'), JSON.stringify({ schemaVersion: 1, id: 'take_agent', title: 'Agent take', createdAt: '2026-11-25T10:00:00.000Z', durationUs: 26_800_000, files: { camera: 'camera.mp4' }, devices: {}, clock: { cameraStartMs: 1764064800000 }, markers: [{ t: 2_000_000, kind: 'retake', label: 'Retake' }, { t: 5_000_000, kind: 'cue', label: 'ZOOM' }], alignment: [], recorder: { mimeType: 'video/mp4', videoBitsPerSecond: 0, chunks: 0 }, rating: 4, notes: '', status: 'ok' }));
    const takes = (await must(client, 'list_takes')).takes;
    assert(takes.length === 1 && takes[0].title === 'Agent take' && takes[0].markers === 2 && takes[0].rating === 4, `list_takes ${JSON.stringify(takes)}`);
    const end0 = (await must(client, 'get_timeline')).durationSec;
    await must(client, 'add_take', { take: 'take_agent' });
    const d2 = await appDoc(win);
    const added = d2.lanes.find((l) => l.kind === 'camera').clips.find((c) => c.name === 'Agent take');
    assert(added && Math.abs(added.start / 1e6 - end0) < 0.001, `add_take camera clip at ${added?.start}`);
    assert(d2.lanes.find((l) => l.kind === 'voice').clips.some((c) => c.linkGroup === added.linkGroup), 'take voice not linked');
    assert(d2.markers.some((m) => m.kind === 'retake' && Math.abs(m.t - added.start - 2_000_000) < 1000), 'take markers');
    const bad = await tool(client, 'add_take', { take: 'nope' });
    assert(/No take "nope"/.test(bad.error) && /list_takes/.test(bad.error), 'unknown take');
    return 'seek/play/pause/select/show_workspace matched the window; save, list, create (square) and open by name worked; a Swipe reference was listed with 8 shots, read without its path and compared with the edit; a script was listed, read and attached; a template was saved, listed and applied with new text; the audio library listed the chosen folder; a recorded take was listed and placed at the end in sync with its markers';
  } finally { await s.close(); }
}
