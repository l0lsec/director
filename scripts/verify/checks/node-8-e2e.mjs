import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { assert, fixture, ffprobe, tmp } from '../lib.mjs';
import { agentSession, must, appDoc } from '../agent-lib.mjs';

/** Mean absolute difference (0-255) between two images, both scaled to 270 wide by ffmpeg. */
function meanDiff(a, b) {
  const raw = (p) => spawnSync('ffmpeg', ['-v', 'error', '-i', p, '-vf', 'scale=270:480', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 64 << 20 }).stdout;
  const x = raw(a), y = raw(b);
  assert(x.length === y.length && x.length === 270 * 480 * 3, `compare sizes ${x.length} ${y.length}`);
  let d = 0;
  for (let i = 0; i < x.length; i++) d += Math.abs(x[i] - y[i]);
  return d / x.length;
}

export default async function () {
  const s = await agentSession({ mode: 'auto', project: false, name: 'claude-code' });
  const { client, win } = s;
  const work = tmp('node-8-e2e');
  const steps = [];
  const step = async (name, args, timeout) => { const r = await must(client, name, args, timeout); steps.push(name); return r; };
  try {
    // Start from nothing, the way an agent would.
    const g = await step('get_started');
    assert(g.project === null, 'a project was already open');
    await step('create_project', { name: 'Agent e2e reel' });
    const empty = await appDoc(win);
    const imp = async (p, role) => (await step('import_media', { paths: [fixture(p)], role })).added[0];
    const voice = await imp('speech.wav', 'mic'), cam = await imp('reference-reel.mp4', 'camera'), broll = await imp('sync-1080p30.mp4', 'broll'), logo = await imp('still.png', 'image'), music = await imp('click-120bpm.wav', 'music');
    await step('add_clip', { media: voice.id, start: 0 });
    const camClip = (await step('add_clip', { media: cam.id, start: 0, sourceOut: Math.min(voice.duration, cam.duration) })).result.clip;
    await step('set_audio', { clips: [camClip], muted: true });
    // Rough cut from the words.
    const tr = await step('transcribe', {}, 600_000);
    assert(tr.wordsOnTimeline >= 40, `transcribed ${tr.wordsOnTimeline}`);
    const preview = await step('auto_cut', { dryRun: true });
    assert(preview.dryRun && preview.result.cuts.length >= 3, 'auto_cut preview');
    const ac = await step('auto_cut', {});
    const cw = await step('cut_words', { text: 'Critique your answer like a tough editor' });
    const tl = await step('get_timeline');
    const D = tl.durationSec;
    assert(D < 26.8 - ac.result.removedSeconds - cw.result.removedSeconds + 0.05 && D > 12, `length after cuts ${D}`);
    // Pictures: b-roll with a speed ramp and a crossfade, a logo picture-in-picture.
    const b = (await step('add_clip', { media: broll.id, lane: 'broll', start: 3, sourceIn: 1, sourceOut: 4 })).result.clip;
    await step('set_speed', { clip: b, ramp: 'hero', ripple: false });
    await step('set_transition', { clips: [b], type: 'crossfade', duration: 0.3 });
    const l = (await step('add_clip', { media: logo.id, lane: 'graphics', start: 6, duration: 2 })).result.clip;
    await step('set_layout', { clip: l, layout: 'bottom-right' });
    // Look: grade one camera clip, copy the look to the rest, punch in on the second.
    const camClips = (await step('get_timeline', { lanes: ['camera'] })).lanes[0].clips.map((c) => c.id);
    assert(camClips.length >= 4, `camera clips after cuts ${camClips.length}`);
    await step('add_effect', { clips: [camClips[0]], type: 'color', params: { contrast: 0.2, saturation: 0.15, temperature: 0.08 } });
    await step('add_effect', { clips: [camClips[0]], type: 'vignette', params: { amount: 0.3 } });
    await step('copy_effects', { from: camClips[0], to: camClips.slice(1) });
    await step('add_effect', { clips: [camClips[1]], type: 'zoom', params: { at: 0.3, amount: 1.2, ramp: 0.15 } });
    // Words on screen: an animated hook title, a boxed call to action, styled captions.
    const hook = (await step('add_text', { text: 'Stop typing plain prompts', start: 0.1, duration: 2.4, y: -650, animationIn: 'pop' })).result.clip;
    await step('set_keyframes', { clip: hook, property: 'scale', timeBase: 'clip', keyframes: [{ time: 0, value: 0.85 }, { time: 0.4, value: 1, ease: 'easeOut' }] });
    await step('add_text', { text: 'Follow for part 2', start: Math.max(0, D - 2.5), duration: 2.4, y: 620, size: 64, box: { color: 'rgba(0,0,0,0.7)', padding: 24, radius: 18 }, animationIn: 'slide-up' });
    const caps = await step('generate_captions', { style: 'word-pop', maxWords: 3 });
    await step('style_captions', { highlightColor: '#ff4d6d' });
    // Sound: music bed ducked under the voice with a fade, beats marked, a chapter marker.
    const m = (await step('add_clip', { media: music.id, start: 0 })).result.clip;
    await step('set_audio', { clips: [m], volume: -18, duckUnderVoice: true, fadeOut: 1 });
    const beats = await step('detect_beats', { clip: m });
    await step('batch', { label: 'Chapter and name', steps: [{ tool: 'add_marker', args: { at: 2.5, label: 'Hook ends', kind: 'chapter' } }, { tool: 'set_project', args: { name: 'Prompting reel (agent cut)' } }] });
    // Look at it, measure it.
    const sheet = await step('render_contact_sheet', { count: 9, columns: 3, width: 900 });
    assert(sheet.image?.mimeType === 'image/png' && sheet.times.length === 9, 'contact sheet');
    const pace = await step('analyze_pacing');
    assert(pace.pacing.shotCount >= 6 && pace.pacing.wordsPerSec > 1.5, `pacing ${JSON.stringify(pace.pacing)}`);
    // Export, then check the file, and that the export matches what the agent was shown.
    const ex = await step('export_video', { preset: 'reels-30', fileName: 'agent-e2e.mp4' });
    let job;
    for (let i = 0; i < 2400; i++) { job = (await must(client, 'get_export_status', { job: ex.job })).jobs[0]; if (['done', 'error', 'cancelled'].includes(job.status)) break; await new Promise((r) => setTimeout(r, 250)); }
    assert(job.status === 'done', `export ${JSON.stringify(job).slice(0, 200)}`);
    const file = join(s.exportDir, 'agent-e2e.mp4');
    const p = ffprobe(file);
    const v = p.streams.find((x) => x.codec_type === 'video');
    assert(v.width === 1080 && v.height === 1920 && v.r_frame_rate === '30/1' && p.streams.some((x) => x.codec_type === 'audio') && Math.abs(Number(v.duration) - D) < 0.05, `export probe ${v.width}x${v.height} ${v.duration} s (timeline ${D})`);
    assert(Math.abs(job.result.loudness.integrated + 14) < 1.5, `loudness ${job.result.loudness.integrated}`);
    const t = 4.2;
    const shown = await must(client, 'render_frame', { t, width: 540 });
    const a = join(work, 'shown.png'), bfile = join(work, 'exported.png');
    writeFileSync(a, Buffer.from(shown.image.data, 'base64'));
    spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', String(t + 0.5 / 30), '-i', file, '-frames:v', '1', bfile]);
    const diff = meanDiff(a, bfile);
    assert(diff < 10, `export differs from the agent's preview at ${t} s: mean difference ${diff.toFixed(1)}`);
    // Everything was the agent's: one revert takes it all back.
    const hist = await step('get_history');
    const rv = await step('revert_agent_changes');
    const back = await appDoc(win);
    const strip = (d) => JSON.stringify({ ...d, updatedAt: 0 });
    assert(rv.reverted === hist.agentSteps && strip(back) === strip(empty), `revert: ${rv.reverted} of ${hist.agentSteps} steps; back to the empty project: ${strip(back) === strip(empty)}`);
    return `MCP only, from no project: ${steps.length} tool calls built a ${D.toFixed(2)} s reel (AutoCut ${ac.result.removedSeconds} s, cut a line ${cw.result.removedSeconds} s, ramped b-roll with a crossfade, logo picture-in-picture, graded and copied look, punch-in, animated hook, boxed CTA, ${caps.result.captions} restyled captions, ducked music with ${beats.markers} beat markers, a chapter) and exported a 1080x1920 30 fps file at ${job.result.loudness.integrated.toFixed(1)} LUFS whose frame at ${t} s matches the agent's preview (mean difference ${diff.toFixed(1)}/255); revert_agent_changes undid all ${rv.reverted} agent steps back to the empty project`;
  } finally { await s.close(); }
}
