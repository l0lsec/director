import { assert } from '../lib.mjs';
import { call } from '../swipe-lib.mjs';
import { agentSession, tool, must, appDoc, undoLabel } from '../agent-lib.mjs';

const json = (d) => JSON.stringify(d);
const dialog = (win) => win.isVisible('[data-testid="mcp-proposal"]');

export default async function () {
  const s = await agentSession({ mode: 'ask', name: 'claude-ai' });
  const { client, win } = s;
  try {
    const tl = await must(client, 'get_timeline');
    const cam = tl.lanes.find((l) => l.kind === 'camera').clips[0];
    // ASK mode. Reads never ask.
    const before = json(await appDoc(win));
    const t0 = Date.now();
    await must(client, 'get_transcript');
    await must(client, 'get_clip', { clip: cam.id });
    assert(!(await dialog(win)) && Date.now() - t0 < 5000, 'a read asked for approval');
    // A write waits; nothing changes while it waits; Reject leaves the project untouched.
    const p1 = tool(client, 'split', { at: 10 });
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="split"]', { timeout: 20_000 });
    const head = await win.textContent('#agent-approval-title');
    assert(/Claude Desktop wants to change your project/.test(head), `dialog title: ${head}`);
    await win.waitForTimeout(800);
    assert(json(await appDoc(win)) === before, 'changed while waiting for approval');
    const pending = await win.evaluate(() => globalThis.__directorAgent.state().activity.find((a) => a.tool === 'split'));
    assert(pending?.status === 'waiting', `activity while pending: ${pending?.status}`);
    await win.click('[data-testid="mcp-reject"]');
    const r1 = await p1;
    assert(r1.rejected && !r1.applied, `reject result ${json(r1)}`);
    assert(json(await appDoc(win)) === before, 'rejecting changed the project');
    // Accept applies it as one undo step labelled with the client.
    const undo0 = await undoLabel(win);
    const p2 = tool(client, 'split', { at: 10 });
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="split"]', { timeout: 20_000 });
    await win.click('[data-testid="mcp-accept"]');
    const r2 = await p2;
    assert(r2.applied && r2.result.rightParts.length >= 1, `accept result ${json(r2).slice(0, 200)}`);
    assert((await undoLabel(win)) === 'Claude Desktop: Split 2 clip(s) at 10 s', `undo label ${await undoLabel(win)}`);
    await win.evaluate(() => globalThis.__directorUndo());
    assert(json(await appDoc(win)) === before && (await undoLabel(win)) === undo0, 'one undo did not restore the project');
    // A batch asks once.
    const p3 = tool(client, 'batch', { label: 'Grade and title', steps: [{ tool: 'add_effect', args: { clips: [cam.id], type: 'vignette' } }, { tool: 'add_text', args: { text: 'Hook', start: 0, duration: 2 } }] });
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="batch"]', { timeout: 20_000 });
    assert((await win.textContent('[data-testid="agent-approval-summary"]')) === 'Grade and title', 'batch summary');
    await win.click('[data-testid="mcp-accept"]');
    assert((await p3).applied && !(await dialog(win)), 'batch needed more than one approval');
    await win.evaluate(() => globalThis.__directorUndo());
    // App tools that change things ask too; ones that only move the playhead do not.
    const p4 = tool(client, 'undo', {});
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="undo"]', { timeout: 20_000 });
    await win.click('[data-testid="mcp-reject"]');
    assert((await p4).rejected, 'undo was not gated');
    await must(client, 'seek', { t: 3 });
    assert(!(await dialog(win)) && Math.abs((await must(client, 'get_state')).playhead - 3) < 0.05, 'seek');
    // AUTO mode: changes land at once; propose_edits still always asks.
    await call(win, 'agent:setMode', { mode: 'auto' });
    const base = await appDoc(win);
    const a = await must(client, 'add_marker', { at: 5, label: 'agent A' });
    assert(a.applied && !(await dialog(win)), 'auto mode asked');
    await win.evaluate(() => globalThis.__directorProjectApply([{ op: 'setMeta', patch: { name: 'Renamed by the person' } }], 'Rename'));
    await must(client, 'set_clip', { clips: [cam.id], opacity: 0.5 });
    const p5 = tool(client, 'propose_edits', { summary: 'Proposal', actions: [{ type: 'marker', start: 1, end: 1, text: 'p', reason: 'test' }] });
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="propose_edits"]', { timeout: 20_000 });
    assert(!(await win.isVisible('[data-testid="mcp-accept-all"]')), 'always-ask proposals must not offer stop asking');
    await win.click('[data-testid="mcp-reject"]');
    await p5;
    // Activity panel lists the agent's changes.
    await win.evaluate(() => globalThis.__directorEditCmd.setEdit({ panel: 'agent' }));
    await win.waitForSelector('[data-testid="agent-panel"]');
    const rows = await win.evaluate(() => [...document.querySelectorAll('[data-testid="agent-activity"] li[data-tool]')].map((l) => `${l.dataset.tool}:${l.dataset.status}`));
    for (const want of ['add_marker:applied', 'set_clip:applied', 'propose_edits:rejected', 'split:rejected', 'split:applied']) assert(rows.includes(want), `panel rows ${rows.join(', ')} lack ${want}`);
    // Revert agent changes: one click takes back A and the opacity change, keeping the person's rename.
    await win.click('[data-testid="agent-revert"]');
    await win.waitForFunction(() => /^Revert agent changes/.test(globalThis.__directorProject().undoLabel ?? ''), null, { timeout: 10_000 });
    const after = await appDoc(win);
    const expect = { ...base, name: 'Renamed by the person' };
    assert(json({ ...after, updatedAt: 0 }) === json({ ...expect, updatedAt: 0 }), 'revert did not restore exactly the base plus the person\'s rename');
    // "Accept and stop asking" switches to auto.
    await call(win, 'agent:setMode', { mode: 'ask' });
    const p6 = tool(client, 'add_marker', { at: 2, label: 'B' });
    await win.waitForSelector('[data-testid="mcp-accept-all"]', { timeout: 20_000 });
    await win.click('[data-testid="mcp-accept-all"]');
    assert((await p6).applied && (await call(win, 'mcp:status', {})).mode === 'auto', 'accept-all did not switch to auto');
    return `Ask: reads never asked; a split waited (nothing changed), Reject left it untouched, Accept was one undo step "Claude Desktop: Split 2 clip(s) at 10 s"; a batch asked once; undo is gated, seek is not. Auto: edits applied at once, propose_edits still asked, the Agent panel listed ${rows.length} actions, and Revert agent changes restored the project exactly except the person's own rename; "Accept and stop asking" switched to Auto`;
  } finally { await s.close(); }
}
