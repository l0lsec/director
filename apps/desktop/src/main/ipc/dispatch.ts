import type { z } from 'zod';
import type { IpcResult } from './contract';

export interface ChannelDef { input: z.ZodType; __out: unknown }
export type HandlerMap<D extends Record<string, ChannelDef>> = {
  [K in keyof D]?: (input: z.output<D[K]['input']>, ctx: { senderId: number }) => Promise<D[K]['__out']> | D[K]['__out'];
};

/**
 * Validates the payload against the channel schema before the handler ever runs.
 * Pure and Electron-free so it can be unit tested.
 */
export async function dispatch<D extends Record<string, ChannelDef>>(
  defs: D,
  handlers: HandlerMap<D>,
  channel: unknown,
  payload: unknown,
  ctx: { senderId: number },
): Promise<IpcResult<unknown>> {
  if (typeof channel !== 'string' || !Object.prototype.hasOwnProperty.call(defs, channel)) {
    return { ok: false, error: { code: 'UNKNOWN_CHANNEL', message: `Unknown channel: ${String(channel).slice(0, 80)}` } };
  }
  const def = defs[channel]!;
  const handler = handlers[channel as keyof D];
  if (!handler) return { ok: false, error: { code: 'NO_HANDLER', message: `No handler for ${channel}` } };
  const parsed = def.input.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, error: { code: 'BAD_INPUT', message: `Invalid payload for ${channel}`, issues: parsed.error.issues.slice(0, 10) } };
  }
  try {
    const value = await handler(parsed.data as never, ctx);
    return { ok: true, value };
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return { ok: false, error: { code: e.code ?? 'HANDLER_ERROR', message: e.message ?? String(err) } };
  }
}
