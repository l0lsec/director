import { assert, vitest, fixture, groundTruth } from '../lib.mjs';
import { launchStudio, directorProject, docJson, requestLog } from '../swipe-lib.mjs';

// Recorded assistant steps, in the Messages API response shape the replay transport returns.
const usage = { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 21000, cache_creation_input_tokens: 0 };
const step = (content, stop_reason = 'tool_use') => ({ model: 'claude-opus-5-5', stop_reason, content, usage });
const SIGNATURE = 'Q'.repeat(640);
const STEPS = [
  // Message 1: read, then add a chapter marker (accepted), then answer.
  step([{ type: 'thinking', thinking: 'Read the state and the timeline first.', signature: SIGNATURE }, { type: 'text', text: 'Looking at your timeline.' }, { type: 'tool_use', id: 'toolu_a1', name: 'get_state', input: {} }, { type: 'tool_use', id: 'toolu_a2', name: 'get_timeline', input: {} }]),
  step([{ type: 'tool_use', id: 'toolu_a3', name: 'add_marker', input: { at: 5, label: 'Hook ends', kind: 'chapter' } }]),
  step([{ type: 'text', text: 'Added a chapter marker at 5 s.' }], 'end_turn'),
  // Message 2: a title the person rejects, a tool the assistant may not use, then an answer.
  step([{ type: 'tool_use', id: 'toolu_b1', name: 'add_text', input: { text: 'Watch this', start: 1, duration: 2 } }, { type: 'tool_use', id: 'toolu_b2', name: 'render_frame', input: { t: 1 } }]),
  step([{ type: 'text', text: 'Okay, no title.' }], 'end_turn'),
];

const logText = (win) => win.evaluate(() => [...document.querySelectorAll('[data-testid="assistant-log"] > li')].map((li) => `${li.dataset.kind ?? 'tool'}:${li.dataset.status ?? ''}:${li.textContent}`));

export default async function () {
  const unit = vitest(['packages/ai/test/assistant.test.ts'], { min: 11 });
  const { app, win, log } = await launchStudio({ replay: { assistant: STEPS }, tab: 'edit' });
  try {
    await directorProject(win, groundTruth(), fixture);
    // Cmd+J opens the assistant from anywhere in the Edit workspace.
    await win.evaluate(() => document.activeElement?.blur());
    await win.keyboard.press('Meta+j');
    await win.waitForSelector('[data-testid="assistant-panel"]', { timeout: 10_000 });
    const before = await docJson(win);

    // Message 1, in Ask mode: the marker waits for approval.
    await win.fill('[data-testid="assistant-input"]', 'Mark where the hook ends');
    await win.keyboard.press('Enter');
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="add_marker"]', { timeout: 30_000 });
    assert((await docJson(win)) === before, 'the project changed before the person accepted');
    await win.click('[data-testid="mcp-accept"]');
    await win.waitForFunction(() => document.querySelector('[data-testid="assistant-panel"]')?.dataset.busy === '0' && [...document.querySelectorAll('[data-testid="assistant-log"] .asst-msg.assistant')].some((e) => e.textContent.includes('5 s')), null, { timeout: 30_000 });
    const doc1 = await win.evaluate(() => globalThis.__directorProject().doc);
    assert(doc1.markers.some((m) => m.label === 'Hook ends' && m.t === 5_000_000), `marker missing: ${JSON.stringify(doc1.markers)}`);
    const label = await win.evaluate(() => globalThis.__directorProject().undoLabel);
    assert(/^Assistant:/.test(label ?? ''), `undo label ${label}`);
    const lines1 = await logText(win);
    assert(lines1[0] === 'user::Mark where the hook ends', `first line ${lines1[0]}`);
    assert(lines1.some((l) => l.startsWith('tool:done:Checked the playhead')) && lines1.some((l) => l.startsWith('tool:applied:')), `tool rows ${JSON.stringify(lines1)}`);
    const activity = await win.evaluate(() => globalThis.__directorAgent.state().activity.filter((a) => a.client === 'Assistant').map((a) => `${a.tool}:${a.status}`));
    assert(activity.includes('add_marker:applied') && activity.includes('get_timeline:done'), `agent activity ${activity}`);

    // Message 2: reject the title; render_frame is refused without running.
    const mid = await docJson(win);
    await win.fill('[data-testid="assistant-input"]', 'Add a title over the start');
    await win.click('[data-testid="assistant-send"]');
    await win.waitForSelector('[data-testid="mcp-proposal"][data-tool="add_text"]', { timeout: 30_000 });
    await win.click('[data-testid="mcp-reject"]');
    await win.waitForFunction(() => [...document.querySelectorAll('[data-testid="assistant-log"] .asst-msg.assistant')].some((e) => e.textContent.includes('no title')), null, { timeout: 30_000 });
    assert((await docJson(win)) === mid, 'a rejected title changed the project');
    const lines2 = await logText(win);
    assert(lines2.some((l) => l.startsWith('tool:rejected:')) && lines2.some((l) => l.startsWith('tool:error:') && l.includes('not available')), `rejected or refused rows missing: ${JSON.stringify(lines2.slice(-6))}`);

    // What reached Claude: every request is text and tool blocks only, with no path or media file name in it.
    const reqs = requestLog(log).filter((r) => r.task === 'assistant');
    assert(reqs.length === 5, `${reqs.length} assistant requests, expected 5`);
    for (const { request } of reqs) {
      const sent = JSON.stringify(request.messages);
      for (const bad of ['/Users/', '/private/', '/var/folders', '.mp4', '.wav', 'data:image']) assert(!sent.includes(bad), `a request carries ${bad}`);
      assert(!request.tools.some((t) => ['render_frame', 'render_contact_sheet', 'import_media'].includes(t.name)) && request.tools.length >= 90, `tools: ${request.tools.length}`);
      assert(request.tools.every((t) => t.eager_input_streaming === true) && request.system[0].cache_control && request.cache_control, 'request is not cached or streamed as built');
    }
    const second = reqs[1].request.messages;
    assert(second[1].content[0].signature === SIGNATURE, 'the thinking block was not sent back verbatim');
    const results = second[2].content.filter((b) => b.type === 'tool_result');
    assert(results.map((b) => b.tool_use_id).join() === 'toolu_a1,toolu_a2' && /reference-reel|speech/.test(results[1].content), 'tool results missing or not readable');
    const last = reqs[4].request.messages.at(-1).content;
    assert(last.find((b) => b.tool_use_id === 'toolu_b1').content.includes('rejected') && last.find((b) => b.tool_use_id === 'toolu_b2').is_error, 'the rejection or refusal did not reach Claude');
    const cost = await win.textContent('[data-testid="assistant-cost"]');
    assert(/^\$0\.\d\d$/.test(cost ?? ''), `cost shown: ${cost}`);

    // New chat clears the conversation; the project keeps the changes.
    await win.click('[data-testid="assistant-new"]');
    assert((await win.evaluate(() => globalThis.__directorAssistant.state().messages)) === 0, 'new chat kept the conversation');
    return `${unit}; app: Cmd+J opens the chat, a marker applied after Accept (one "Assistant:" undo step), a rejected title changed nothing, render_frame refused unrun; 5 requests text and tools only, no paths or media names, thinking sent back verbatim, cached and streamed`;
  } finally { await app.close(); }
}
