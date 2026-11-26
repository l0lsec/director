import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { z } from 'zod';
import { assertTextOnly, type OutgoingRequest } from './privacy';
import { costOf, DEFAULT_MODEL, type UsageBlock } from './pricing';

export type Effort = 'low' | 'medium' | 'high';

/** The request we send: a strict subset of the Messages API create params. */
export interface ClaudeRequest extends OutgoingRequest {
  model: string;
  max_tokens: number;
  system: Array<{ type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }>;
  messages: Array<{ role: 'user' | 'assistant'; content: Array<{ type: 'text'; text: string }> }>;
  thinking: { type: 'adaptive' };
  output_config: { effort: Effort; format?: unknown };
}

/** The parts of a Messages API response we read. Recorded fixtures use exactly this shape. */
export interface ClaudeResponse {
  id?: string;
  model: string;
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  content: Array<{ type: string; text?: string }>;
  usage: UsageBlock;
}

export interface Transport {
  send(req: ClaudeRequest, opts: { task: string; onText?: (delta: string) => void; signal?: AbortSignal }): Promise<ClaudeResponse>;
}

export type ClaudeErrorCode = 'NO_KEY' | 'AUTH' | 'RATE_LIMIT' | 'OVERLOADED' | 'NETWORK' | 'REFUSAL' | 'TRUNCATED' | 'INVALID_OUTPUT' | 'API' | 'CANCELLED';
export class ClaudeError extends Error {
  public readonly code: ClaudeErrorCode;
  public readonly details?: unknown;
  constructor(code: ClaudeErrorCode, message: string, details?: unknown) { super(message); this.code = code; this.details = details; }
}

export interface CallRecord { task: string; model: string; usage: UsageBlock; costUsd: number; at: string; ms: number }

export interface CallSpec<S extends z.ZodType> {
  task: string;
  system: string;
  /** Stable context that benefits from caching (brand voice, reference), sent before the per-call prompt. */
  context?: string;
  prompt: string;
  schema: S;
  effort: Effort;
  maxTokens?: number;
  onText?: (delta: string) => void;
  signal?: AbortSignal;
  /** Extra conversation turns (for a revision request). */
  history?: Array<{ role: 'user' | 'assistant'; text: string }>;
}

export interface CallResult<T> { data: T; record: CallRecord; raw: string }

/** Thin, testable Claude client: builds the request, applies the privacy guard, parses and validates output. */
export class ClaudeClient {
  private transport: Transport;
  public model: string;
  private onRecord?: (r: CallRecord) => void;
  private now: () => number;
  constructor(transport: Transport, model: string = DEFAULT_MODEL, onRecord?: (r: CallRecord) => void, now: () => number = () => Date.now()) {
    this.transport = transport; this.model = model; this.onRecord = onRecord; this.now = now;
  }

  build<S extends z.ZodType>(spec: CallSpec<S>): ClaudeRequest {
    const system: ClaudeRequest['system'] = [{ type: 'text', text: spec.system }];
    if (spec.context) system.push({ type: 'text', text: spec.context });
    // One breakpoint on the last stable block caches the system prompt and context together.
    system[system.length - 1]!.cache_control = { type: 'ephemeral' };
    const messages: ClaudeRequest['messages'] = [];
    const first = spec.history?.length ? spec.history : [{ role: 'user' as const, text: spec.prompt }];
    for (const h of first) messages.push({ role: h.role, content: [{ type: 'text', text: h.text }] });
    if (spec.history?.length) messages.push({ role: 'user', content: [{ type: 'text', text: spec.prompt }] });
    return {
      model: this.model,
      max_tokens: spec.maxTokens ?? 16000,
      system,
      messages,
      thinking: { type: 'adaptive' },
      output_config: { effort: spec.effort, format: zodOutputFormat(spec.schema) },
    };
  }

  async call<S extends z.ZodType>(spec: CallSpec<S>): Promise<CallResult<z.infer<S>>> {
    const req = this.build(spec);
    assertTextOnly(req);
    const t0 = this.now();
    const res = await this.transport.send(req, { task: spec.task, onText: spec.onText, signal: spec.signal });
    const record: CallRecord = { task: spec.task, model: res.model || req.model, usage: res.usage, costUsd: costOf(res.model || req.model, res.usage), at: new Date(t0).toISOString(), ms: this.now() - t0 };
    // Usage is billed whatever happens next, so record it before reading the content.
    this.onRecord?.(record);
    if (res.stop_reason === 'refusal') {
      const why = res.stop_details?.explanation ?? 'Claude declined this request.';
      throw new ClaudeError('REFUSAL', why, res.stop_details);
    }
    if (res.stop_reason === 'max_tokens') throw new ClaudeError('TRUNCATED', 'The response was cut off at the token limit. Try a shorter input.');
    const raw = res.content.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new ClaudeError('INVALID_OUTPUT', 'Claude returned text that is not valid JSON.', raw.slice(0, 500)); }
    const v = spec.schema.safeParse(parsed);
    if (!v.success) throw new ClaudeError('INVALID_OUTPUT', 'Claude returned JSON that does not match the expected shape.', v.error.issues.slice(0, 10));
    return { data: v.data, record, raw };
  }
}

/** Live transport through the official SDK. The key stays in the main process. */
export function sdkTransport(apiKey: string): Transport {
  if (!apiKey) throw new ClaudeError('NO_KEY', 'Add your Claude API key in Settings to use this feature.');
  const client = new Anthropic({ apiKey, maxRetries: 2 });
  return {
    async send(req, { onText, signal }) {
      try {
        const params = req as unknown as Anthropic.MessageCreateParamsNonStreaming;
        if (onText) {
          const stream = client.messages.stream(params, { signal });
          stream.on('text', (d) => onText(d));
          return (await stream.finalMessage()) as unknown as ClaudeResponse;
        }
        return (await client.messages.create(params, { signal })) as unknown as ClaudeResponse;
      } catch (e) {
        throw mapSdkError(e);
      }
    },
  };
}

export function mapSdkError(e: unknown): ClaudeError {
  if (e instanceof ClaudeError) return e;
  if (e instanceof Anthropic.APIUserAbortError) return new ClaudeError('CANCELLED', 'Cancelled.');
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) return new ClaudeError('AUTH', 'Your Claude API key was rejected. Check it in Settings.');
  if (e instanceof Anthropic.RateLimitError) return new ClaudeError('RATE_LIMIT', 'Rate limited by the Claude API. Wait a moment and try again.');
  if (e instanceof Anthropic.APIConnectionError) return new ClaudeError('NETWORK', 'Could not reach the Claude API. Check your connection.');
  if (e instanceof Anthropic.APIError) {
    if (e.status === 529) return new ClaudeError('OVERLOADED', 'The Claude API is overloaded. Try again shortly.');
    return new ClaudeError('API', `Claude API error ${e.status ?? ''}: ${e.message}`.trim());
  }
  return new ClaudeError('API', (e as Error)?.message ?? String(e));
}

/**
 * Replays recorded responses by task, in order. A request log keeps every request exactly as it
 * would have been sent, for privacy checks and for asserting request shape.
 */
export class ReplayTransport implements Transport {
  readonly log: Array<{ task: string; request: ClaudeRequest; json: string }> = [];
  private queues = new Map<string, ClaudeResponse[]>();
  constructor(recordings: Record<string, ClaudeResponse | ClaudeResponse[]>) {
    for (const [task, r] of Object.entries(recordings)) this.queues.set(task, Array.isArray(r) ? [...r] : [r]);
  }
  async send(req: ClaudeRequest, { task, onText }: { task: string; onText?: (d: string) => void }): Promise<ClaudeResponse> {
    this.log.push({ task, request: req, json: JSON.stringify(req) });
    const q = this.queues.get(task);
    if (!q?.length) throw new ClaudeError('API', `no recorded response left for task "${task}"`);
    const res = q.shift()!;
    if (onText) for (const b of res.content) if (b.type === 'text' && b.text) for (let i = 0; i < b.text.length; i += 40) onText(b.text.slice(i, i + 40));
    return res;
  }
}
