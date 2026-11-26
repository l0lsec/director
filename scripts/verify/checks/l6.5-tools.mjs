import { assert, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, directorProject, mcpConnect } from '../swipe-lib.mjs';

export default async function () {
  const { app, win } = await launchStudio({ tab: 'edit' });
  let client;
  try {
    const gt = groundTruth();
    await directorProject(win, gt, fixture);
    ({ client } = await mcpConnect(win));
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    // M8 grew the bridge into the full agent catalog; the five original tools must still be there and behave the same.
    const legacy = ['get_project', 'get_transcript', 'list_ops', 'propose_edits', 'render_frame'];
    assert(legacy.every((n) => tools.includes(n)), `original tools missing: ${legacy.filter((n) => !tools.includes(n)).join()}`);
    const doc = await win.evaluate(() => globalThis.__directorProject().doc);
    // The bridge reads the open project (pushed from the window), not a stale copy.
    await win.waitForTimeout(400);
    const pr = await client.callTool({ name: 'get_project', arguments: {} });
    assert(!pr.isError, `get_project error: ${pr.content[0].text}`);
    const got = JSON.parse(pr.content[0].text);
    assert(got.project.name === doc.name, `name ${got.project.name}`);
    const lanes = doc.lanes.map((l) => `${l.kind}:${l.clips.length}`).join();
    assert(got.project.lanes.map((l) => `${l.kind}:${l.clips.length}`).join() === lanes, `lanes ${JSON.stringify(got.project.lanes.map((l) => l.kind))}`);
    assert(Math.abs(got.project.durationSec - 26.83) < 0.01, `duration ${got.project.durationSec}`);
    assert(!JSON.stringify(got).includes('/Users/') && !JSON.stringify(got).includes('.mp4'), 'project read leaks paths or file names');
    const tr = JSON.parse((await client.callTool({ name: 'get_transcript', arguments: {} })).content[0].text);
    assert(tr.words.length === gt.speech.words.length && tr.words[0].text === gt.speech.words[0].text && Math.abs(tr.words[0].start - gt.speech.words[0].start) < 0.001, `transcript ${tr.words.length} words`);
    const ops = (await client.callTool({ name: 'list_ops', arguments: {} })).content[0].text;
    assert(/propose_edits/.test(ops) && /cut/.test(ops) && /zoom/.test(ops), 'list_ops text');
    const fr = await client.callTool({ name: 'render_frame', arguments: { t: 5 } });
    assert(!fr.isError && fr.content[0].type === 'image' && fr.content[0].mimeType === 'image/png', `render_frame: ${JSON.stringify(fr.content[0]).slice(0, 200)}`);
    const png = Buffer.from(fr.content[0].data, 'base64');
    assert(png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 540 && png.readUInt32BE(20) === 960, `png ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`);
    // Changing the project in the app is visible to the client.
    await win.evaluate(() => globalThis.__directorProjectApply([{ op: 'setMeta', patch: { name: 'Renamed in app' } }], 'rename'));
    await win.waitForTimeout(400);
    const again = JSON.parse((await client.callTool({ name: 'get_project', arguments: {} })).content[0].text);
    assert(again.project.name === 'Renamed in app', 'client sees a stale project');
    return `MCP client listed ${tools.length} tools, read the open project (${got.project.lanes.length} lanes, ${got.project.durationSec} s), ${tr.words.length} transcript words, the op list and a 540x960 PNG frame; edits in the app show up`;
  } finally { await client?.close().catch(() => undefined); await app.close(); }
}
