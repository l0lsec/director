import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { assert, root } from '../lib.mjs';
import { call } from '../swipe-lib.mjs';
import { agentSession, tool, must } from '../agent-lib.mjs';

const AXE = readFileSync(join(root, 'node_modules', 'axe-core', 'axe.min.js'), 'utf8');
async function scan(win, label) {
  await win.evaluate((src) => { if (!globalThis.axe) (0, eval)(src); }, AXE);
  const v = await win.evaluate(async () => (await globalThis.axe.run(document, { resultTypes: ['violations'] })).violations.map((x) => ({ id: x.id, impact: x.impact, nodes: x.nodes.slice(0, 2).map((n) => n.target.join(' ')) })));
  return v.map((x) => ({ ...x, where: label }));
}

export default async function () {
  const s = await agentSession({ mode: 'ask', name: 'claude-code' });
  const { client, win } = s;
  try {
    // The top bar says whether assistants are connected and how they work.
    await win.waitForSelector('[data-testid="agent-status"]');
    assert((await win.textContent('[data-testid="agent-status"]')) === 'AI: asks first', `chip: ${await win.textContent('[data-testid="agent-status"]')}`);
    // Clicking it opens the Agent panel.
    await win.click('[data-testid="agent-status"]');
    await win.waitForSelector('[data-testid="agent-panel"]');
    assert((await win.textContent('[data-testid="agent-panel-status"]')) === 'Asks first', 'panel status');
    // A pending change shows in the chip and the panel while the dialog waits.
    const pending = tool(client, 'add_marker', { at: 3, label: 'Hook' });
    await win.waitForSelector('[data-testid="mcp-proposal"]');
    await win.waitForFunction(() => /1 waiting for you/.test(document.querySelector('[data-testid="agent-status"]').textContent));
    const a11yDialog = await scan(win, 'approval dialog');
    const waitingRow = await win.waitForSelector('[data-testid="agent-activity"] li[data-tool="add_marker"][data-status="waiting"]');
    assert(/Claude Code/.test(await waitingRow.textContent()), 'pending row lacks the client name');
    await win.click('[data-testid="mcp-accept"]');
    await pending;
    await win.waitForSelector('[data-testid="agent-activity"] li[data-tool="add_marker"][data-status="applied"]');
    const row = await win.textContent('[data-testid="agent-activity"] li[data-tool="add_marker"]');
    assert(/Claude Code/.test(row) && /Marker "Hook" at 3 s/.test(row) && /Changed/.test(row), `applied row: ${row}`);
    // Reads are hidden by default and shown on request; failures always show.
    await must(client, 'get_timeline');
    await tool(client, 'trim_clip', { clip: 'nope', edge: 'end', by: -1 });
    const visible = await win.evaluate(() => [...document.querySelectorAll('[data-testid="agent-activity"] li[data-tool]')].map((l) => l.dataset.tool));
    assert(!visible.includes('get_timeline') && visible.includes('trim_clip'), `rows ${visible}`);
    await win.click('[data-testid="agent-panel"] input[type="checkbox"]');
    assert(await win.isVisible('[data-testid="agent-activity"] li[data-tool="get_timeline"]'), 'Show reads did not show reads');
    // Auto mode is reflected at once.
    await call(win, 'agent:setMode', { mode: 'auto' });
    await win.waitForFunction(() => document.querySelector('[data-testid="agent-status"]').textContent.startsWith('AI: auto'));
    const a11yPanel = await scan(win, 'agent panel');
    // Settings section.
    await win.click('[data-testid="open-settings"]');
    await win.waitForSelector('[data-testid="setup-tab-claudeDesktop"]');
    await win.click('[data-testid="setup-tab-claudeDesktop"]');
    const a11ySettings = await scan(win, 'settings: connect an AI');
    const all = [...a11yDialog, ...a11yPanel, ...a11ySettings];
    const bad = all.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    assert(!bad.length, `accessibility: ${JSON.stringify(bad)}`);
    return `top bar chip "AI: asks first" opened the Agent panel; a pending change showed "1 waiting for you" and a waiting row with the client, then "Changed: Marker \\"Hook\\" at 3 s"; reads hidden until asked, failures shown; Auto mode reflected at once; axe on the approval dialog, Agent panel and Connect an AI settings: 0 serious or critical (${all.length} minor or moderate: ${[...new Set(all.map((v) => v.id))].join(', ') || 'none'})`;
  } finally { await s.close(); }
}
