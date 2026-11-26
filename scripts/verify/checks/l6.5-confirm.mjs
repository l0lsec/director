import { assert, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, directorProject, mcpConnect, docJson } from '../swipe-lib.mjs';

const ACTIONS = [
  { type: 'cut', start: 3.6, end: 4.65, text: '', amount: 0, reason: 'Dead air after the hook' },
  { type: 'zoom', start: 8.42, end: 12.23, text: '', amount: 1.2, reason: 'Emphasis' },
  { type: 'text', start: 0.5, end: 3.48, text: 'Stop typing plain prompts', amount: 0, reason: 'Title the hook' },
];

export default async function () {
  const { app, win } = await launchStudio({ tab: 'edit' });
  let client;
  try {
    await directorProject(win, groundTruth(), fixture);
    ({ client } = await mcpConnect(win));
    await win.waitForTimeout(400);
    const before = await docJson(win);
    const undo0 = await win.evaluate(() => globalThis.__directorProject().undoLabel);
    // 1. Invalid proposal: refused with reasons, never shown, nothing changes.
    const bad = await client.callTool({ name: 'propose_edits', arguments: { summary: 'bad', actions: [{ type: 'cut', start: 20, end: 40, reason: 'past the end' }] } });
    assert(bad.isError && /past the end of the timeline/.test(bad.content[0].text), `invalid proposal: ${bad.content[0].text}`);
    assert(!(await win.isVisible('[data-testid="mcp-proposal"]')), 'an invalid proposal reached the dialog');
    // 2. Valid proposal: pending until the person decides; rejecting leaves the project alone.
    const p1 = client.callTool({ name: 'propose_edits', arguments: { summary: 'Tighten the hook', actions: ACTIONS } }, undefined, { timeout: 120_000 });
    await win.waitForSelector('[data-testid="mcp-proposal"]', { timeout: 20_000 });
    const lines = await win.evaluate(() => [...document.querySelectorAll('[data-testid="mcp-proposal"] li')].map((l) => l.textContent));
    assert(lines.length === 3 && /^Cut 3\.60 to 4\.65 s/.test(lines[0]), `dialog lines ${JSON.stringify(lines)}`);
    await win.waitForTimeout(1500);
    assert((await docJson(win)) === before, 'the project changed before the proposal was accepted');
    await win.click('[data-testid="mcp-reject"]');
    const r1 = await p1;
    assert(!r1.isError && /rejected/.test(r1.content[0].text), `reject result: ${r1.content[0].text}`);
    assert((await docJson(win)) === before && (await win.evaluate(() => globalThis.__directorProject().undoLabel)) === undo0, 'rejecting changed the project');
    // 3. Same proposal, accepted: applies as one undo step.
    const p2 = client.callTool({ name: 'propose_edits', arguments: { summary: 'Tighten the hook', actions: ACTIONS } }, undefined, { timeout: 120_000 });
    await win.waitForSelector('[data-testid="mcp-proposal"]', { timeout: 20_000 });
    assert((await docJson(win)) === before, 'changed while the second proposal was pending');
    await win.click('[data-testid="mcp-accept"]');
    const r2 = await p2;
    assert(!r2.isError && /Accepted and applied as one undo step/.test(r2.content[0].text), `accept result: ${r2.content[0].text}`);
    const doc = await win.evaluate(() => globalThis.__directorProject().doc);
    assert(doc.lanes.find((l) => l.kind === 'titles').clips.length === 1, 'title not added');
    assert(doc.lanes.find((l) => l.kind === 'camera').clips.some((c) => c.effects.some((e) => e.type === 'zoom')), 'zoom not added');
    assert((await win.evaluate(() => globalThis.__directorProject().undoLabel)) === 'MCP: Tighten the hook', 'undo label');
    await win.evaluate(() => globalThis.__directorUndo());
    assert((await docJson(win)) === before, 'one undo did not restore the project');
    assert((await win.evaluate(() => globalThis.__directorProject().undoLabel)) === undo0, 'more than one undo step was added');
    // 4. Raw primitive ops go through the same gate.
    const p3 = client.callTool({ name: 'propose_edits', arguments: { summary: 'Rename', ops: [{ op: 'setMeta', patch: { name: 'Named over MCP' } }] } }, undefined, { timeout: 120_000 });
    await win.waitForSelector('[data-testid="mcp-proposal"]', { timeout: 20_000 });
    assert((await win.evaluate(() => globalThis.__directorProject().doc.name)) !== 'Named over MCP', 'raw op applied before confirmation');
    await win.click('[data-testid="mcp-accept"]');
    await p3;
    assert((await win.evaluate(() => globalThis.__directorProject().doc.name)) === 'Named over MCP', 'raw op not applied after accept');
    const badOps = await client.callTool({ name: 'propose_edits', arguments: { summary: 'x', ops: [{ op: 'removeClip', id: 'does-not-exist' }] } });
    assert(badOps.isError && /not found/.test(badOps.content[0].text), 'invalid raw op not refused up front');
    return 'invalid proposals refused up front; valid ones changed nothing while pending, a rejection left the project untouched, an acceptance applied as one undo step that restores byte-identical; raw ops are gated the same way';
  } finally { await client?.close().catch(() => undefined); await app.close(); }
}
