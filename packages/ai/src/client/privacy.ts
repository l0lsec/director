/**
 * Privacy guard: only text may leave the machine. Every outgoing Claude request passes through
 * `assertTextOnly` before it is sent. It rejects non-text content blocks, data URIs, long base64 or
 * hex runs (encoded media), binary control characters, absolute file paths and media file names.
 */
export class PrivacyError extends Error {
  readonly code = 'PRIVACY';
  public readonly reasons: string[];
  constructor(reasons: string[]) { super(`Blocked by the privacy guard: ${reasons.slice(0, 3).join('; ')}`); this.reasons = reasons; }
}

const DATA_URI = /data:[a-z]+\/[a-z0-9.+-]+;base64,/i;
const BASE64_RUN = /[A-Za-z0-9+/]{400,}={0,2}/;
const HEX_RUN = /\b[0-9a-f]{512,}\b/i;
// eslint-disable-next-line no-control-regex
const BINARY = /[\x00-\x08\x0e-\x1f\x7f]/;
const ABS_PATH = /(?:^|[\s"'(=])(?:\/(?:Users|Volumes|private|home|var|tmp|opt)\/\S+|[A-Za-z]:\\\S+|~\/\S+)/;
const MEDIA_FILE = /\b[\w-]+\.(?:mp4|mov|m4v|webm|mkv|wav|m4a|mp3|aac|png|jpe?g|heic)\b/i;
const ALLOWED_BLOCKS = new Set(['text']);

function walkStrings(v: unknown, path: string, out: Array<{ path: string; value: string }>): void {
  if (typeof v === 'string') out.push({ path, value: v });
  else if (Array.isArray(v)) v.forEach((x, i) => walkStrings(x, `${path}[${i}]`, out));
  else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walkStrings(x, path ? `${path}.${k}` : k, out);
}

export interface OutgoingRequest { system?: unknown; messages: Array<{ role: string; content: unknown }>; [k: string]: unknown }

export function privacyFindings(req: OutgoingRequest): string[] {
  const reasons: string[] = [];
  if (typeof req !== 'object' || !req || !Array.isArray(req.messages)) return ['request has no messages array'];
  const blocks: unknown[] = [];
  for (const m of req.messages) {
    if (typeof m.content === 'string') continue;
    if (Array.isArray(m.content)) blocks.push(...m.content);
    else reasons.push('message content is neither text nor a block list');
  }
  if (Array.isArray(req.system)) blocks.push(...req.system);
  else if (req.system !== undefined && typeof req.system !== 'string') reasons.push('system prompt is neither text nor a block list');
  for (const b of blocks) {
    const t = (b as { type?: string })?.type;
    if (!t || !ALLOWED_BLOCKS.has(t)) reasons.push(`content block of type "${t}" is not allowed (text only)`);
  }
  // What the model reads is scanned; the output schema is app-authored and carries no user data.
  const strings: Array<{ path: string; value: string }> = [];
  walkStrings({ system: req.system, messages: req.messages }, '', strings);
  for (const { path, value } of strings) {
    if (DATA_URI.test(value)) reasons.push(`${path}: contains a data URI`);
    if (BASE64_RUN.test(value)) reasons.push(`${path}: contains a long base64 run (encoded media?)`);
    if (HEX_RUN.test(value)) reasons.push(`${path}: contains a long hex run (encoded media?)`);
    if (BINARY.test(value)) reasons.push(`${path}: contains binary control characters`);
    if (ABS_PATH.test(value)) reasons.push(`${path}: contains a file path`);
    if (MEDIA_FILE.test(value)) reasons.push(`${path}: names a media file`);
  }
  return [...new Set(reasons)];
}

export function assertTextOnly(req: OutgoingRequest): void {
  const r = privacyFindings(req);
  if (r.length) throw new PrivacyError(r);
}
