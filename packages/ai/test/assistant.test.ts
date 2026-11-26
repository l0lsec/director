import { describe, it, expect } from 'vitest';
import {
  runTurn, buildAssistantRequest, toolResultText, redact, redactText, privacyFindings, assertTextOnly, PrivacyError,
  ASSISTANT_EXCLUDED, MAX_RESULT_CHARS, type AssistantMessage, type Block, type StepResult, type ToolOutcome,
} from '../src';

const SIG = 'A'.repeat(600);
const think: Block = { type: 'thinking', thinking: 'I should read the timeline first.', signature: SIG };
const step = (content: Block[], stop_reason = 'end_turn'): StepResult => ({ content, stop_reason, costUsd: 0.01 });
const use = (id: string, name: string, input: unknown = {}): Block => ({ type: 'tool_use', id, name, input });
const TOOLS = [
  { name: 'get_timeline', description: 'Read', input_schema: { type: 'object', properties: {} } },
  { name: 'render_frame', description: 'See', input_schema: { type: 'object', properties: {} } },
  { name: 'import_media', description: 'Import', input_schema: { type: 'object', properties: {} } },
];

/** A scripted model: returns the steps in order and records every request exactly as the main process builds it. */
function scripted(steps: StepResult[]) {
  const sent: AssistantMessage[][] = [];
  return {
    sent,
    send: async (messages: AssistantMessage[]) => {
      sent.push(structuredClone(messages));
      // Every request must pass the guard the main process applies.
      assertTextOnly(buildAssistantRequest({ model: 'claude-opus-5-5', tools: TOOLS, messages }), { agent: true });
      const s = steps.shift();
      if (!s) throw new Error('no scripted step left');
      return s;
    },
  };
}

const lastUser = (m: AssistantMessage[]) => m[m.length - 1]!;
const results = (m: AssistantMessage) => m.content.filter((b) => b.type === 'tool_result') as Array<Block & { tool_use_id: string; content: string; is_error?: boolean }>;

describe('assistant turn', () => {
  it('runs the tools Claude asks for, sends redacted results back, and ends on its answer', async () => {
    const model = scripted([
      step([think, { type: 'text', text: 'Reading the timeline.' }, use('t1', 'get_timeline', { detail: 'summary' })], 'tool_use'),
      step([{ type: 'text', text: 'Cut 3 pauses between 12 s and 40 s.' }]),
    ]);
    const calls: Array<{ name: string; input: unknown }> = [];
    const runTool = async (name: string, input: unknown): Promise<ToolOutcome> => {
      calls.push({ name, input });
      return { ok: true, data: { media: [{ id: 'm1', name: 'Chris Leslie - Full Podcast Final Draft.mp4', path: '/Users/alex/Movies/Director Projects/Chris.director/take.mp4' }], note: 'Saved to /Users/alex/Movies/Director Exports/out.mov' } };
    };
    const events: string[] = [];
    const r = await runTurn({ messages: [], text: 'tighten the start', send: model.send, runTool, onEvent: (e) => events.push(e.type === 'tool' ? `tool:${e.status}` : 'step') });
    expect(r.stop).toBe('done');
    expect(r.steps).toBe(2);
    expect(r.costUsd).toBeCloseTo(0.02);
    expect(calls).toEqual([{ name: 'get_timeline', input: { detail: 'summary' } }]);
    expect(events).toEqual(['step', 'tool:running', 'tool:done', 'step']);
    // The second request carries the assistant turn verbatim (thinking signature included) and the tool result.
    const second = model.sent[1]!;
    expect(second[1]!.content[0]).toEqual(think);
    const res = results(lastUser(second))[0]!;
    expect(res.tool_use_id).toBe('t1');
    expect(res.content).toContain('Chris Leslie - Full Podcast Final Draft');
    for (const leaked of ['/Users/', '.mp4', '.mov', 'Director Exports']) expect(res.content).not.toContain(leaked);
    expect(r.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  });

  it('never runs tools that would send pictures or need file paths', async () => {
    const model = scripted([step([use('a', 'render_frame', { t: 1 }), use('b', 'import_media', { paths: ['/x'] })], 'tool_use'), step([{ type: 'text', text: 'ok' }])]);
    let ran = 0;
    const r = await runTurn({ messages: [], text: 'how does it look', send: model.send, runTool: async () => { ran++; return { ok: true, data: {} }; } });
    expect(ran).toBe(0);
    const rs = results(lastUser(model.sent[1]!));
    expect(rs.map((x) => [x.tool_use_id, x.is_error])).toEqual([['a', true], ['b', true]]);
    expect(rs[0]!.content).toContain('NOT_AVAILABLE');
    expect(r.stop).toBe('done');
    expect([...ASSISTANT_EXCLUDED].sort()).toEqual(['import_media', 'render_contact_sheet', 'render_frame']);
  });

  it('does not run a tool call that was cut off, and the next message continues the same conversation', async () => {
    const model = scripted([step([use('c1', 'get_timeline')], 'max_tokens'), step([{ type: 'text', text: 'Picking up.' }])]);
    let ran = 0;
    const runTool = async (): Promise<ToolOutcome> => { ran++; return { ok: true, data: {} }; };
    const first = await runTurn({ messages: [], text: 'go', send: model.send, runTool });
    expect(first.stop).toBe('truncated');
    expect(ran).toBe(0);
    expect(results(lastUser(first.messages))[0]!.tool_use_id).toBe('c1');
    const second = await runTurn({ messages: first.messages, text: 'continue', send: model.send, runTool });
    expect(second.stop).toBe('done');
    // The person's text joins the pending tool results in one user message, so roles still alternate.
    const sent = model.sent[1]!;
    expect(sent.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(lastUser(sent).content.map((b) => b.type)).toEqual(['tool_result', 'text']);
  });

  it('stops on a refusal without running its tools', async () => {
    const model = scripted([{ content: [use('r1', 'get_timeline')], stop_reason: 'refusal', stop_details: { explanation: 'Not able to help with that.' }, costUsd: 0 }]);
    let ran = 0;
    const r = await runTurn({ messages: [], text: 'x', send: model.send, runTool: async () => { ran++; return { ok: true, data: {} }; } });
    expect(r.stop).toBe('refusal');
    expect(r.explanation).toBe('Not able to help with that.');
    expect(ran).toBe(0);
  });

  it('Stop ends the turn: tools after the current one are answered as not run', async () => {
    const ac = new AbortController();
    const model = scripted([step([use('s1', 'get_timeline'), use('s2', 'get_timeline')], 'tool_use')]);
    const ran: string[] = [];
    const r = await runTurn({ messages: [], text: 'x', send: model.send, signal: ac.signal, runTool: async (n) => { ran.push(n); ac.abort(); return { ok: true, data: {} }; } });
    expect(r.stop).toBe('cancelled');
    expect(ran.length).toBe(1);
    const rs = results(lastUser(r.messages));
    expect(rs.map((x) => x.tool_use_id)).toEqual(['s1', 's2']);
    expect(rs[1]!.content).toContain('stopped');
  });

  it('a failed request returns the conversation so far with the error', async () => {
    const r = await runTurn({ messages: [], text: 'x', send: async () => { throw Object.assign(new Error('Your Claude API key was rejected.'), { code: 'CLAUDE_AUTH' }); }, runTool: async () => ({ ok: true, data: {} }) });
    expect(r.stop).toBe('error');
    expect(r.error).toEqual({ code: 'CLAUDE_AUTH', message: 'Your Claude API key was rejected.' });
    expect(r.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'x' }] }]);
  });

  it('checks in after the step limit', async () => {
    const steps = Array.from({ length: 5 }, (_, i) => step([use(`m${i}`, 'get_timeline')], 'tool_use'));
    const model = scripted(steps);
    const r = await runTurn({ messages: [], text: 'x', send: model.send, runTool: async () => ({ ok: true, data: {} }), maxSteps: 3 });
    expect(r.stop).toBe('max_steps');
    expect(model.sent.length).toBe(3);
  });

  it('leaves file paths and file names out of what the person types', async () => {
    const model = scripted([step([{ type: 'text', text: 'ok' }])]);
    const r = await runTurn({ messages: [], text: 'use the take at /Users/alex/Movies/take 3.mov and IMG_0042.MOV', send: model.send, runTool: async () => ({ ok: true, data: {} }) });
    expect(r.redacted).toBe(true);
    const sent = (model.sent[0]![0]!.content[0] as unknown as { text: string }).text;
    expect(sent).toBe('use the take at [path]');
    expect(redactText('clip IMG_0042.MOV please')).toBe('clip IMG_0042 please');
  });
});

describe('assistant request and privacy', () => {
  it('builds a cached, streaming-ready request without the excluded tools', () => {
    const req = buildAssistantRequest({ model: 'claude-opus-5-5', tools: TOOLS, messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] });
    expect(req.tools.map((t) => t.name)).toEqual(['get_timeline']);
    expect(req.tools.every((t) => t.eager_input_streaming === true)).toBe(true);
    expect(req.system[0]!.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.cache_control).toEqual({ type: 'ephemeral' });
    expect(req.thinking).toEqual({ type: 'adaptive' });
  });

  it('agent mode allows tool blocks where each side may send them, and still scans everything the app adds', () => {
    const base = (messages: unknown[]) => ({ messages } as never);
    const ok = base([
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
      { role: 'assistant', content: [think, use('t', 'get_timeline')] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: '{"ok":1}' }] },
    ]);
    expect(privacyFindings(ok, { agent: true })).toEqual([]);
    // Outside agent mode, tool blocks stay forbidden, and a signature in the person's text is still a base64 run.
    expect(privacyFindings(ok).length).toBeGreaterThan(0);
    const bad = [
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] }] }],
      [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'saved at /Users/alex/Movies/out.mp4' }] }],
      [{ role: 'user', content: [use('t', 'get_timeline')] }],
      [{ role: 'user', content: [{ type: 'text', text: `x ${SIG}` }] }],
      [{ role: 'assistant', content: [{ type: 'image', source: {} }] }],
    ];
    for (const m of bad) expect(() => assertTextOnly(base(m), { agent: true })).toThrow(PrivacyError);
  });

  it('caps huge results and withholds anything the guard would still object to', () => {
    const big = toolResultText({ words: Array.from({ length: 30_000 }, (_, i) => ({ i, text: 'word' })) });
    expect(big.length).toBeLessThan(MAX_RESULT_CHARS + 300);
    expect(big).toContain('cut off');
    const binary = toolResultText({ thumb: 'Q'.repeat(2000) });
    expect(binary).toContain('withheld');
    expect(redact({ paths: ['/a', '/b'], nested: { path: '/x', name: 'a.wav' }, bytes: new Uint8Array(4) })).toEqual({ paths: ['[path]', '[path]'], nested: { path: '[path]', name: 'a' }, bytes: '[binary data left out]' });
  });
});
