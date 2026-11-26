import { assert } from '../lib.mjs';
import { call } from '../swipe-lib.mjs';
import { agentSession, tool, must, appDoc, appRevision, undoLabel, http } from '../agent-lib.mjs';

export default async function () {
  const s = await agentSession({ mode: 'auto', name: 'claude-code' });
  const { client, win } = s;
  try {
    // 1. Every catalog tool is listed, with annotations; the count matches the app's own catalog and the HTTP manifest.
    const listed = (await client.listTools()).tools;
    const rest = (await http(s.port, { token: s.token })).json.tools;
    assert(listed.length >= 90 && listed.length === s.status.tools && listed.length === rest.length, `tools: MCP ${listed.length}, app ${s.status.tools}, HTTP ${rest.length}`);
    const by = Object.fromEntries(listed.map((t) => [t.name, t]));
    for (const t of listed) assert(t.annotations && typeof t.annotations.readOnlyHint === 'boolean' && t.inputSchema?.type === 'object' && t.description.length >= 60, `${t.name} lacks annotations, schema or description`);
    assert(by.get_timeline.annotations.readOnlyHint && !by.add_text.annotations.readOnlyHint && by.delete_clips.annotations.destructiveHint && by.set_clip.annotations.idempotentHint, 'annotation values');
    // 2. Resources and prompts.
    const resources = (await client.listResources()).resources.map((r) => r.uri).sort();
    assert(resources.join() === 'director://capabilities,director://guide,director://media,director://timeline,director://transcript', `resources ${resources}`);
    const doc0 = await appDoc(win);
    const tlRes = JSON.parse((await client.readResource({ uri: 'director://timeline' })).contents[0].text);
    assert(tlRes.name === doc0.name && tlRes.lanes.length === doc0.lanes.length && tlRes.lanes.some((l) => l.clips.some((c) => c.transform)), 'timeline resource is not the open project in full detail');
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    assert(prompts.length === 5 && prompts.includes('edit_reel') && prompts.includes('match_reference'), `prompts ${prompts}`);
    const pr = await client.getPrompt({ name: 'edit_reel', arguments: { goal: 'teaches one prompting trick', length: '30' } });
    assert(/get_started/.test(pr.messages[0].content.text) && /30 seconds/.test(pr.messages[0].content.text), 'edit_reel prompt text');
    // 3. Reads return the live project.
    const tl = await must(client, 'get_timeline');
    const lanesApp = doc0.lanes.map((l) => `${l.id}:${l.clips.map((c) => c.id).join('+')}`).join();
    const lanesAgent = tl.lanes.map((l) => `${l.id}:${l.clips.map((c) => c.id).join('+')}`).join();
    const endApp = Math.max(...doc0.lanes.flatMap((l) => l.clips.map((c) => c.start + (c.out - c.in) / (c.speed.rate ?? 1)))) / 1e6;
    const revApp = await appRevision(win);
    assert(lanesAgent === lanesApp, `get_timeline lanes: ${lanesAgent} vs ${lanesApp}`);
    assert(Math.abs(tl.durationSec - endApp) < 0.002 && tl.revision === revApp, `get_timeline: ${tl.durationSec} s rev ${tl.revision}; app ${endApp} s rev ${revApp}`);
    const tr = await must(client, 'get_transcript');
    assert(tr.count === 45 && tr.words[0].i === 0, `transcript ${tr.count}`);
    // 4. A write acts on the window's project, labelled with the client's name, as one undo step.
    const cam = tl.lanes.find((l) => l.kind === 'camera').clips[0];
    const w = await must(client, 'add_effect', { clips: [cam.id], type: 'color', params: { contrast: 0.2, saturation: 0.15 } });
    assert(w.applied && w.revision === (await appRevision(win)), `add_effect: ${JSON.stringify(w).slice(0, 200)}`);
    const doc1 = await appDoc(win);
    const fx = doc1.lanes.find((l) => l.kind === 'camera').clips[0].effects.find((e) => e.type === 'color');
    assert(fx && fx.params.contrast === 0.2, 'effect not in the app project');
    const label = await undoLabel(win);
    assert(label.startsWith('Claude Code: '), `undo label ${label}`);
    const clip = await must(client, 'get_clip', { clip: cam.id });
    assert(clip.clip.effects[0].params.saturation === 0.15, 'agent does not see its change');
    // 5. Errors explain the fix.
    const e = await tool(client, 'trim_clip', { clip: 'nope', edge: 'end', by: -1 });
    assert(e.error && /No clip "nope"/.test(e.error) && /How to fix: .*get_timeline/.test(e.error), `error text: ${e.error}`);
    // 6. The person's own edit in the app is visible to the agent at once.
    await win.evaluate(() => globalThis.__directorProjectApply([{ op: 'setMeta', patch: { name: 'Edited by hand' } }], 'rename'));
    assert((await must(client, 'get_timeline')).name === 'Edited by hand', 'stale read');
    // 7. Activity shows the client and what it did.
    const act = await win.evaluate(() => globalThis.__directorAgent.state().activity);
    assert(act.some((a) => a.client === 'Claude Code' && a.tool === 'add_effect' && a.status === 'applied'), `activity ${JSON.stringify(act.slice(0, 3))}`);
    const st = await call(win, 'mcp:status', {});
    return `MCP lists all ${listed.length} catalog tools with annotations (same as the app and HTTP), 5 resources and 5 prompts; reads match the live project (${tl.lanes.length} lanes, 45 words, revision ${tl.revision}); add_effect landed in the window as one undo step "${label}"; errors say how to fix; mode ${st.mode}`;
  } finally { await s.close(); }
}
