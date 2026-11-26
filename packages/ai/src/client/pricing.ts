/**
 * Model prices in USD per million tokens, from the claude-api skill model table (cached 2026-11-03).
 * Cache reads: 0.05x input on Opus 5.5 and Sonnet 5.5, 0.1x elsewhere. Cache writes (5-minute TTL): 1.25x input.
 */
export const MODELS = {
  'claude-opus-5-5': { label: 'Claude Opus 5.5', input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-sonnet-5-5': { label: 'Claude Sonnet 5.5', input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-haiku-5-5': { label: 'Claude Haiku 5.5', input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
} as const;
export type ModelId = keyof typeof MODELS;
export const DEFAULT_MODEL: ModelId = 'claude-opus-5-5';
export const isModelId = (m: string): m is ModelId => m in MODELS;

export interface UsageBlock {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** Response models can carry a date or suffix; map them back to a priced id. */
export function priceKey(model: string): ModelId {
  if (isModelId(model)) return model;
  const hit = (Object.keys(MODELS) as ModelId[]).find((m) => model.startsWith(m));
  return hit ?? DEFAULT_MODEL;
}

/** Dollars for one response's usage block. `input_tokens` excludes cached tokens, as the API reports it. */
export function costOf(model: string, u: UsageBlock): number {
  const p = MODELS[priceKey(model)];
  const m = 1e-6;
  return u.input_tokens * p.input * m + u.output_tokens * p.output * m + (u.cache_read_input_tokens ?? 0) * p.cacheRead * m + (u.cache_creation_input_tokens ?? 0) * p.cacheWrite * m;
}

export function formatUsd(v: number): string {
  if (v === 0) return '$0.00';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}
