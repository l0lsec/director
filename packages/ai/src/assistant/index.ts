/**
 * The in-app assistant: a chat in Director where Claude edits with the same tools external agents use.
 *
 * The loop runs where the tools are (the renderer); each model step goes through `send`, which the app routes to
 * the main process (the API key never leaves it). Everything the app adds to the conversation, the person's text
 * and every tool result, is redacted here and checked again by the privacy guard before it is sent.
 */
import { privacyFindings, type OutgoingRequest } from '../client/privacy';
import type { UsageBlock } from '../client/pricing';

export interface Block { type: string; [k: string]: unknown }
export interface AssistantMessage { role: 'user' | 'assistant'; content: Block[] }
export interface ToolSpec { name: string; description: string; input_schema: Record<string, unknown> }

export interface AssistantRequest extends OutgoingRequest {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  tools: Array<ToolSpec & { eager_input_streaming: true }>;
  messages: AssistantMessage[];
  thinking: { type: 'adaptive' };
  /** Automatic caching for the growing conversation tail. */
  cache_control: { type: 'ephemeral' };
}

/**
 * Tools the built-in assistant does not get: the render tools return pictures, and media never leaves the Mac;
 * import_media and browse_files deal in file paths, which are never sent either (the person adds files from the Files panel).
 */
export const ASSISTANT_EXCLUDED = new Set(['render_frame', 'render_contact_sheet', 'import_media', 'browse_files']);

export const ASSISTANT_SYSTEM = [
  'You are the assistant built into Director, a desktop video editor on the person\'s Mac for short-form vertical video and long-form YouTube (podcasts, interviews, talking heads).',
  'The person is chatting with you in a panel next to their timeline. Every tool acts on the project open in Director, and they see each change as you make it.',
  '',
  'How to work:',
  '- Start a new task with get_started (once per conversation) and get_state: get_state gives the playhead, the selected clips and the in and out points, so "here", "this clip" and "this part" mean those.',
  '- Times are seconds on the timeline. Ids come from get_timeline (clips, lanes, markers) and list_media (media); always refer to media and clips by id.',
  '- Read before you edit: get_timeline, then get_transcript or find_in_transcript to find moments by what was said. For a long video, read the transcript in ranges rather than all at once.',
  '- Every change is one undo step. Use dryRun to preview anything large or destructive, batch to group related edits so the person approves once, and expectRevision so you never overwrite edits they make while you work.',
  '- The person may be in Ask mode: each change waits for them to accept it. If they reject one, do not retry it; ask what they would like instead.',
  '- You cannot see frames: pictures, file paths and file names never leave the Mac, so media names reach you without their extension. Judge framing from get_timeline, speaker detection and the transcript, and ask the person to look when it matters.',
  '- You cannot import files. If something is missing, ask the person to drag it into the media bin, then call list_media.',
  '- Do what was asked, no more. If a request is ambiguous and getting it wrong would waste their time (which section, how much to cut), ask one short question first.',
  '',
  'When you finish, reply in a few short sentences: what you changed (with times), anything you could not do, and what they might check. Plain text, no headings or tables.',
].join('\n');

const PATH = /(?:\/(?:Users|Volumes|private|home|var|tmp|opt)\/|~\/|[A-Za-z]:\\)[^"'\n]*/g;
const MEDIA_EXT = /\b([\w-]+)\.(?:mp4|mov|m4v|webm|mkv|wav|m4a|mp3|aac|png|jpe?g|heic)\b/gi;
const PATH_KEYS = new Set(['path', 'paths', 'dir', 'folder', 'file', 'filePath', 'outputPath', 'connectionFile']);
/** Most characters of one tool result sent back (about 20k tokens). */
export const MAX_RESULT_CHARS = 80_000;

/** File paths become [path] and media file names lose their extension, so nothing on disk is named. */
export function redactText(s: string): string {
  return s.replace(PATH, '[path]').replace(MEDIA_EXT, '$1');
}

/** Deep copy with every string redacted and path fields replaced. */
export function redact<T>(v: T): T {
  const walk = (x: unknown, key?: string): unknown => {
    if (typeof x === 'string') return key && PATH_KEYS.has(key) ? '[path]' : redactText(x);
    if (Array.isArray(x)) return key && PATH_KEYS.has(key) ? x.map(() => '[path]') : x.map((y) => walk(y));
    if (x && typeof x === 'object') {
      if (x instanceof Uint8Array || ArrayBuffer.isView(x)) return '[binary data left out]';
      return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, k)]));
    }
    return x;
  };
  return walk(v) as T;
}

/** A tool result as the text Claude reads: redacted, size-capped, and withheld if the guard would still object. */
export function toolResultText(value: unknown): string {
  let text = JSON.stringify(redact(value ?? null)) ?? 'null';
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)} ... [cut off: the result was ${text.length} characters. Ask for less, for example a time range or detail:"summary".]`;
  const findings = privacyFindings({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] });
  if (findings.length) return JSON.stringify({ withheld: true, message: 'This result held data that does not leave the Mac (media or a file path), so it was left out. Try a narrower request.' });
  return text;
}

export function buildAssistantRequest(o: { model: string; tools: ToolSpec[]; messages: AssistantMessage[]; maxTokens?: number }): AssistantRequest {
  return {
    model: o.model,
    max_tokens: o.maxTokens ?? 32_000,
    // The tool list never changes and renders first, so this one breakpoint caches tools and instructions together.
    system: [{ type: 'text', text: ASSISTANT_SYSTEM, cache_control: { type: 'ephemeral' } }],
    tools: o.tools.filter((t) => !ASSISTANT_EXCLUDED.has(t.name)).map((t) => ({ ...t, eager_input_streaming: true as const })),
    messages: o.messages,
    thinking: { type: 'adaptive' },
    cache_control: { type: 'ephemeral' },
  };
}

export interface StepResult {
  content: Block[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  usage?: UsageBlock;
  costUsd: number;
}

export type ToolOutcome = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; hint?: string } };

export type TurnEvent =
  | { type: 'step'; content: Block[] }
  | { type: 'tool'; id: string; name: string; input: unknown; status: 'running' }
  | { type: 'tool'; id: string; name: string; input: unknown; status: 'done' | 'error'; outcome: ToolOutcome };

export type TurnStop = 'done' | 'max_steps' | 'truncated' | 'refusal' | 'cancelled' | 'error';

export interface TurnOptions {
  /** The conversation so far; the person's new message is added by runTurn. */
  messages: AssistantMessage[];
  text: string;
  send: (messages: AssistantMessage[]) => Promise<StepResult>;
  runTool: (name: string, input: unknown) => Promise<ToolOutcome>;
  onEvent?: (e: TurnEvent) => void;
  /** Model steps per message before stopping to check in with the person. */
  maxSteps?: number;
  signal?: AbortSignal;
}

/** The conversation is always returned in a state the next message can continue from, even after an error. */
export interface TurnResult { messages: AssistantMessage[]; stop: TurnStop; costUsd: number; steps: number; explanation?: string; redacted: boolean; error?: { code?: string; message: string } }

/** Add user blocks, joining the last message if it is already the person's (tool results left from a stopped turn). */
function appendUser(messages: AssistantMessage[], blocks: Block[]): AssistantMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === 'user') return [...messages.slice(0, -1), { role: 'user', content: [...last.content, ...blocks] }];
  return [...messages, { role: 'user', content: blocks }];
}

const notRun = (id: string, why: string): Block => ({ type: 'tool_result', tool_use_id: id, is_error: true, content: JSON.stringify({ notRun: true, message: why }) });

/** One message from the person, then model steps and tool calls until Claude answers (or a stop condition). */
export async function runTurn(o: TurnOptions): Promise<TurnResult> {
  const clean = redactText(o.text);
  let messages = appendUser(o.messages, [{ type: 'text', text: clean }]);
  let costUsd = 0;
  const maxSteps = o.maxSteps ?? 60;
  for (let step = 1; ; step++) {
    if (o.signal?.aborted) return { messages, stop: 'cancelled', costUsd, steps: step - 1, redacted: clean !== o.text };
    let res: StepResult;
    try { res = await o.send(messages); } catch (e) {
      const err = e as { code?: string; message?: string };
      const base = { messages, costUsd, steps: step - 1, redacted: clean !== o.text };
      if (o.signal?.aborted) return { ...base, stop: 'cancelled' };
      return { ...base, stop: 'error', error: { ...(err?.code ? { code: err.code } : {}), message: err?.message ?? String(e) } };
    }
    costUsd += res.costUsd;
    messages = [...messages, { role: 'assistant', content: res.content }];
    o.onEvent?.({ type: 'step', content: res.content });
    const uses = res.content.filter((b) => b.type === 'tool_use') as Array<Block & { id: string; name: string; input: unknown }>;
    const end = (stop: TurnStop, why: string, explanation?: string): TurnResult => {
      // Every tool_use needs a result before the next message, so a stopped turn answers them as not run.
      if (uses.length) messages = appendUser(messages, uses.map((u) => notRun(u.id, why)));
      return { messages, stop, costUsd, steps: step, redacted: clean !== o.text, ...(explanation ? { explanation } : {}) };
    };
    // A refusal or a cut-off can end a tool call mid-input, so that step's tools never run.
    if (res.stop_reason === 'refusal') return end('refusal', 'Not run: the response was declined.', res.stop_details?.explanation ?? undefined);
    if (res.stop_reason === 'max_tokens') return end('truncated', 'Not run: the response was cut off at the output limit.');
    if (res.stop_reason === 'pause_turn') { if (step >= maxSteps) return end('max_steps', 'Not run: step limit.'); continue; }
    if (!uses.length) return { messages, stop: 'done', costUsd, steps: step, redacted: clean !== o.text };
    const results: Block[] = [];
    for (const u of uses) {
      if (o.signal?.aborted) { results.push(notRun(u.id, 'Not run: the person stopped the assistant.')); continue; }
      o.onEvent?.({ type: 'tool', id: u.id, name: u.name, input: u.input, status: 'running' });
      let outcome: ToolOutcome;
      if (ASSISTANT_EXCLUDED.has(u.name)) {
        outcome = { ok: false, error: { code: 'NOT_AVAILABLE', message: `${u.name} is not available to the assistant inside Director (pictures and file paths stay on the Mac).`, hint: 'Use get_timeline and the transcript instead, or ask the person.' } };
      } else {
        try { outcome = await o.runTool(u.name, u.input); } catch (e) { outcome = { ok: false, error: { code: 'FAILED', message: (e as Error)?.message ?? String(e) } }; }
      }
      o.onEvent?.({ type: 'tool', id: u.id, name: u.name, input: u.input, status: outcome.ok ? 'done' : 'error', outcome });
      results.push({ type: 'tool_result', tool_use_id: u.id, ...(outcome.ok ? {} : { is_error: true }), content: toolResultText(outcome.ok ? outcome.data : { error: outcome.error }) });
    }
    messages = appendUser(messages, results);
    if (o.signal?.aborted) return { messages, stop: 'cancelled', costUsd, steps: step, redacted: clean !== o.text };
    if (step >= maxSteps) return { messages, stop: 'max_steps', costUsd, steps: step, redacted: clean !== o.text };
  }
}

/** The text Claude wrote in a step (thinking and tool calls left out). */
export function stepText(content: Block[]): string {
  return content.filter((b) => b.type === 'text').map((b) => String(b.text ?? '')).join('').trim();
}
