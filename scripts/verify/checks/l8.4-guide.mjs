import { assert, fixture } from '../lib.mjs';
import { call } from '../swipe-lib.mjs';
import { agentSession, must, tool } from '../agent-lib.mjs';

/** Each mistake: the call, what the message must say went wrong, and what it must name as the fix. */
async function expectFix(client, label, name, args, what, fix) {
  const r = await tool(client, name, args);
  assert(r.error, `${label}: ${name} did not fail: ${JSON.stringify(r).slice(0, 150)}`);
  assert(what.test(r.error), `${label}: message lacks what went wrong: ${r.error}`);
  assert(fix.test(r.error), `${label}: message lacks the fix: ${r.error}`);
  return label;
}

export default async function () {
  const s = await agentSession({ mode: 'auto', project: false });
  const { client, win } = s;
  const seen = [];
  try {
    // Orientation with nothing open.
    const g0 = await must(client, 'get_started');
    assert(g0.project === null && /create_project/.test(g0.next) && g0.mode === 'auto' && g0.units?.units && g0.workflow.length >= 6, 'get_started without a project');
    seen.push(await expectFix(client, 'no project', 'get_timeline', {}, /No project is open/, /list_projects|open_project|create_project/));
    await must(client, 'create_project', { name: 'Guide check' });
    const voice = (await must(client, 'import_media', { paths: [fixture('speech.wav')], role: 'mic' })).added[0];
    const vClip = (await must(client, 'add_clip', { media: voice.id, start: 0 })).result.clip;
    seen.push(await expectFix(client, 'no transcript', 'cut_words', { text: 'hello' }, /no transcript/i, /transcribe/));
    await must(client, 'transcribe', {}, 600_000);
    // Orientation with a project: describes it and the tools.
    const g1 = await must(client, 'get_started');
    assert(g1.project?.name === 'Guide check' && g1.project.transcript && Object.values(g1.tools).flat().length === s.status.tools, 'get_started with a project');
    const d = await must(client, 'describe_tool', { name: 'set_keyframes' });
    assert(d.inputSchema.properties.property.enum.includes('volume') && d.examples.length >= 2 && d.changesProject, 'describe_tool');
    seen.push(await expectFix(client, 'phrase not said', 'cut_words', { text: 'purple elephant' }, /"purple elephant" is not in the transcript/, /find_in_transcript|get_transcript/));
    seen.push(await expectFix(client, 'unknown clip', 'trim_clip', { clip: 'clip_nope', edge: 'end', by: -1 }, /No clip "clip_nope"/, /get_timeline/));
    seen.push(await expectFix(client, 'unknown tool', 'split_clip', { at: 1 }, /no tool called split_clip/, /Did you mean .*\bsplit\b/));
    seen.push(await expectFix(client, 'past the end', 'add_marker', { at: 999, label: 'x' }, /past the end of the timeline \(26\.\d+ s\)/, /get_timeline|durationSec/));
    seen.push(await expectFix(client, 'outside the clip', 'split', { at: 0, clips: [vClip] }, /not inside clip/, /get_clip|between the clip start and end/));
    seen.push(await expectFix(client, 'no such effect', 'add_effect', { clips: [vClip], type: 'sepia' }, /type: .*expected one of.*"color"/i, /describe_tool/));
    seen.push(await expectFix(client, 'value out of range', 'add_effect', { clips: [vClip], type: 'color', params: { exposure: 5 } }, /exposure = 5 is outside -2 to 2/, /Stops of exposure/));
    seen.push(await expectFix(client, 'no such parameter', 'add_effect', { clips: [vClip], type: 'color', params: { gamma: 1.2 } }, /no parameter "gamma"/, /exposure.*get_capabilities/s));
    seen.push(await expectFix(client, 'wrong type', 'split', { at: 'soon' }, /at: .*number/i, /describe_tool \{"name":"split"\}/));
    seen.push(await expectFix(client, 'no such lane', 'add_clip', { media: voice.id, lane: 'drone' }, /No lane "drone".*Lanes: .*voice/, /lane id or kind/));
    seen.push(await expectFix(client, 'both to and by', 'trim_clip', { clip: vClip, edge: 'end', to: 3, by: -1 }, /exactly one of `to` or `by`/, /"by":-0\.5/));
    seen.push(await expectFix(client, 'file name with a folder', 'export_video', { fileName: 'exports/final.mp4' }, /plain file name/, /export folder/));
    await must(client, 'update_lane', { lane: 'voice', locked: true });
    seen.push(await expectFix(client, 'locked lane', 'trim_clip', { clip: vClip, edge: 'end', by: -1 }, /locked lane/, /update_lane \{"lane":"[^"]+","locked":false\}/));
    await must(client, 'update_lane', { lane: 'voice', locked: false });
    const rev = (await must(client, 'get_timeline')).revision;
    await win.evaluate(() => globalThis.__directorProjectApply([{ op: 'setMeta', patch: { name: 'Changed by hand' } }], 'rename'));
    seen.push(await expectFix(client, 'stale revision', 'split', { at: 2, expectRevision: rev }, new RegExp(`changed since revision ${rev}`), /get_timeline/));
    seen.push(await expectFix(client, 'needs captions first', 'style_captions', { style: 'karaoke' }, /no captions/i, /generate_captions/));
    assert(seen.length >= 14, `${seen.length} mistakes checked`);
    const st = await call(win, 'mcp:status', {});
    return `get_started oriented a new agent with and without a project (mode, units, ${g0.workflow.length}-step workflow, ${st.tools} tools by group) and describe_tool gave schemas with examples; ${seen.length} common mistakes each said what went wrong and named the fix: ${seen.join(', ')}`;
  } finally { await s.close(); }
}
