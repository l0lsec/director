import { existsSync } from 'node:fs';
import { assert, fixture, groundTruth } from '../lib.mjs';
import { agentSession, must, tool, appDoc, undoLabel } from '../agent-lib.mjs';

const clipOf = (doc, id) => doc.lanes.flatMap((l) => l.clips).find((c) => c.id === id);

/** Run a processing tool and prove it was one labelled undo step that undo fully reverses. */
async function oneStep(win, client, name, args, check) {
  const before = JSON.stringify(await appDoc(win));
  const r = await must(client, name, args, 900_000);
  const label = await undoLabel(win);
  assert(label.startsWith('director-check: '), `${name} undo label ${label}`);
  const after = await appDoc(win);
  check(after, r);
  await win.evaluate(() => globalThis.__directorUndo());
  const back = await appDoc(win);
  assert(JSON.stringify({ ...back, media: {} }) === JSON.stringify({ ...JSON.parse(before), media: {} }), `${name}: one undo did not restore the timeline`);
  await win.evaluate(() => globalThis.__directorRedo());
  return { r, label };
}

export default async function () {
  const s = await agentSession({ mode: 'auto', project: false });
  const { client, win } = s;
  try {
    await must(client, 'create_project', { name: 'Processing check' });
    const [voice, music, video] = [
      (await must(client, 'import_media', { paths: [fixture('noisy-speech.wav')], role: 'mic' })).added[0],
      (await must(client, 'import_media', { paths: [fixture('click-120bpm.wav')], role: 'music' })).added[0],
      (await must(client, 'import_media', { paths: [fixture('sync-1080p30.mp4')], role: 'broll' })).added[0],
    ];
    const vClip = (await must(client, 'add_clip', { media: voice.id, start: 0 })).result.clip;
    const mClip = (await must(client, 'add_clip', { media: music.id, start: 0 })).result.clip;
    const bClip = (await must(client, 'add_clip', { media: video.id, start: 0, sourceOut: 4 })).result.clip;
    // Voice cleanup: the clip now plays a new, processed file.
    const vc = await oneStep(win, client, 'process_audio', { clip: vClip, denoise: true }, (d) => {
      const m = clipOf(d, vClip).mediaId;
      assert(m !== voice.id && d.media[m] && existsSync(d.media[m].path) && / \(clean\)$/.test(d.media[m].name), `denoised media ${m}`);
    });
    // Beat markers land on the clicks.
    const g = groundTruth().files['click-120bpm.wav'];
    const bt = await oneStep(win, client, 'detect_beats', { clip: mClip }, (d, r) => {
      const beats = d.markers.filter((m) => m.kind === 'beat').map((m) => m.t / 1e6);
      const truth = [];
      for (let t = g.firstBeatSec; t < g.durationSec; t += 60 / g.bpm) truth.push(t);
      const worst = Math.max(...truth.map((t) => Math.min(...beats.map((b) => Math.abs(b - t)))));
      assert(beats.length === truth.length && r.markers === truth.length && worst < 0.02, `beats ${beats.length}/${truth.length}, worst ${worst}`);
    });
    // Stabilize swaps in a stabilized copy of the same length.
    await oneStep(win, client, 'stabilize', { clip: bClip, smoothing: 10 }, (d) => {
      const c = clipOf(d, bClip);
      assert(c.mediaId !== video.id && / \(stabilized\)$/.test(d.media[c.mediaId].name) && Math.abs(d.media[c.mediaId].durationUs - video.duration * 1e6) < 100_000, 'stabilized media');
    });
    // Background removal adds a person matte from on-device segmentation.
    await oneStep(win, client, 'remove_background', { clip: bClip }, (d) => {
      const fx = clipOf(d, bClip).effects.find((e) => e.type === 'matte');
      assert(fx && existsSync(fx.params.path), 'matte effect');
    });
    // Auto reframe reaches the face tracker; with no face in the clip it says so and changes nothing.
    const before = JSON.stringify(await appDoc(win));
    const rf = await tool(client, 'auto_reframe', { clip: bClip });
    assert(rf.error && /No face was found/.test(rf.error) && /set_keyframes/.test(rf.error), `auto_reframe: ${JSON.stringify(rf)}`);
    assert(JSON.stringify(await appDoc(win)) === before, 'auto_reframe changed the project without a face');
    return `over MCP: voice cleanup (${vc.label}), ${bt.r.markers} beat markers on the clicks, stabilize and background removal each landed as one labelled undo step that undo reverses; auto reframe ran the face tracker and reported no face without changing anything`;
  } finally { await s.close(); }
}
