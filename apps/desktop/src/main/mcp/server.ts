import { app, BrowserWindow } from 'electron';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { writeFileSync, rmSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Server as McpServer } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ListResourcesRequestSchema, ReadResourceRequestSchema, ListPromptsRequestSchema, GetPromptRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { tools as catalog, manifest, type ToolResponse } from '@director/agent';
import { getSecret, setSecret, getSetting, setSetting } from '../settings';
import { PROMPTS, RESOURCES } from './guide';

export type AgentMode = 'ask' | 'auto';
export interface McpStatus {
  enabled: boolean; running: boolean; url: string | null; port: number | null; token: string | null; pending: number; config: string | null; error: string | null;
  mode: AgentMode; tools: number; connectionFile: string | null;
  setup: { claudeCode: string; claudeDesktop: string; http: string; rest: string } | null;
}

const DEFAULT_PORT = 47615;
/** Long tools (transcription, stabilization, background removal) and approvals can take minutes. */
const CALL_TIMEOUT_MS = 60 * 60_000;
const broadcast = (event: string, payload: unknown) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`director:event:${event}`, payload); };

let server: Server | null = null;
let port: number | null = null;
let lastError: string | null = null;
const calls = new Map<string, { resolve: (r: ToolResponse) => void; timer: NodeJS.Timeout }>();

function token(): string {
  let t = getSecret('mcp.token');
  if (!t) { t = randomBytes(24).toString('base64url'); setSecret('mcp.token', t); }
  return t;
}

export function connectionFile(): string { return join(app.getPath('userData'), 'agent-connection.json'); }

/** The stdio bridge shipped with the app (Claude Desktop launches it). */
export function stdioScript(): string {
  const packaged = join(process.resourcesPath ?? '', 'mcp-stdio.cjs');
  if (app.isPackaged && existsSync(packaged)) return packaged;
  // Development: out/main/index.js sits two levels below apps/desktop.
  return join(__dirname, '..', '..', 'resources', 'mcp-stdio.cjs');
}

export function mode(): AgentMode { return getSetting<AgentMode>('agent.mode', 'ask') === 'auto' ? 'auto' : 'ask'; }

function setup(url: string, t: string) {
  const desktop = { mcpServers: { director: { command: process.execPath, args: [stdioScript()], env: { ELECTRON_RUN_AS_NODE: '1', DIRECTOR_MCP_TOKEN: t, DIRECTOR_CONNECTION_FILE: connectionFile() } } } };
  return {
    claudeCode: `claude mcp add --transport http director ${url} --header "Authorization: Bearer ${t}"`,
    claudeDesktop: JSON.stringify(desktop, null, 2),
    http: JSON.stringify({ mcpServers: { director: { type: 'http', url, headers: { Authorization: `Bearer ${t}` } } } }, null, 2),
    rest: `curl -s -H "Authorization: Bearer ${t}" ${url.replace(/\/mcp$/, '')}/api/tools?format=anthropic`,
  };
}

export function status(): McpStatus {
  const enabled = getSetting<boolean>('mcp.enabled', false);
  const url = server && port ? `http://127.0.0.1:${port}/mcp` : null;
  const t = enabled ? token() : null;
  const s = url && t ? setup(url, t) : null;
  return {
    enabled, running: !!server, url, port, token: t, pending: calls.size, error: lastError, mode: mode(), tools: catalog().size,
    connectionFile: server ? connectionFile() : null, config: s?.http ?? null, setup: s,
  };
}

/** The window reports the outcome of a forwarded call. */
export function result(requestId: string, response: ToolResponse): boolean {
  const c = calls.get(requestId);
  if (!c) return false;
  clearTimeout(c.timer);
  calls.delete(requestId);
  c.resolve(response);
  return true;
}

/** Run a catalog tool in the window, against the project the person is looking at. */
export function callInWindow(client: string, tool: string, args: unknown): Promise<ToolResponse> {
  const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && !w.webContents.getURL().includes('prompter'));
  if (!win) return Promise.resolve({ ok: false, error: { code: 'NO_WINDOW', message: 'Director has no open window.', hint: 'Open Director and try again.' } });
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { calls.delete(requestId); resolve({ ok: false, error: { code: 'TIMEOUT', message: `${tool} did not finish within an hour.` } }); }, CALL_TIMEOUT_MS);
    calls.set(requestId, { resolve, timer });
    win.webContents.send('director:event:agent:call', { requestId, client, tool, args: args ?? {} });
  });
}

/** MCP content for a tool response: images as image blocks, everything else as readable JSON. */
function toContent(r: ToolResponse) {
  if (!r.ok) return { content: [{ type: 'text' as const, text: `${r.error.message}${r.error.hint ? `\nHow to fix: ${r.error.hint}` : ''}\n(code ${r.error.code})` }], isError: true };
  const data = r.data as Record<string, unknown> | null;
  const img = data && typeof data === 'object' ? (data.image as { data: string; mimeType: string } | undefined) : undefined;
  if (img) {
    const { image: _i, ...rest } = data!;
    return { content: [{ type: 'image' as const, data: img.data, mimeType: img.mimeType }, { type: 'text' as const, text: JSON.stringify(rest) }] };
  }
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] };
}

/** How often a long tool call reports that it is still working. */
const HEARTBEAT_MS = Number(process.env.DIRECTOR_MCP_HEARTBEAT_MS ?? 15_000);

const INSTRUCTIONS = [
  'Director is a desktop video editor (short-form vertical video and YouTube) running on this Mac. Every tool acts on the project open in its window.',
  'Start with get_started. Times are seconds; ids come from get_timeline. Every change is one undo step; use dryRun to preview, batch for several edits at once, and expectRevision to avoid overwriting the person\'s own edits.',
  'The person may require approval for each change (Ask mode): batch related edits so they approve once. render_contact_sheet and render_frame show you the result.',
].join(' ');

const KNOWN: Array<[RegExp, string]> = [[/^claude[- ]?code/i, 'Claude Code'], [/^claude[- ]?(ai|desktop)?$/i, 'Claude Desktop'], [/cursor/i, 'Cursor'], [/vscode|visual studio code/i, 'VS Code']];
function clientName(req: IncomingMessage, info?: { name?: string; version?: string }): string {
  const ua = String(req.headers['user-agent'] ?? '');
  const raw = info?.name ?? (/claude-code/i.test(ua) ? 'Claude Code' : /claude/i.test(ua) ? 'Claude' : ua.split(/[\s/]/)[0] || 'Agent');
  const base = KNOWN.find(([re]) => re.test(raw))?.[1] ?? raw;
  return base.replace(/[^\w .()-]/g, '').slice(0, 40) || 'Agent';
}

function buildServer(who: () => string): McpServer {
  const mcp = new McpServer({ name: 'director', version: app.getVersion() }, { capabilities: { tools: {}, resources: {}, prompts: {}, logging: {} }, instructions: INSTRUCTIONS });
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: manifest('mcp') as never }));
  mcp.setRequestHandler(CallToolRequestSchema, async (r, extra) => {
    // Long calls (transcribing or analyzing a long video, exporting) keep the response stream alive: progress for
    // clients that asked for it, a short log line for the rest, so no HTTP client gives up waiting.
    const token = r.params._meta?.progressToken;
    const started = Date.now();
    let beat = 0;
    const timer = setInterval(() => {
      const secs = Math.round((Date.now() - started) / 1000);
      const note = token !== undefined
        ? { method: 'notifications/progress' as const, params: { progressToken: token, progress: ++beat, message: `${r.params.name}: still working (${secs} s)` } }
        : { method: 'notifications/message' as const, params: { level: 'info' as const, logger: 'director', data: `${r.params.name}: still working (${secs} s)` } };
      extra.sendNotification(note as never).catch(() => undefined);
    }, HEARTBEAT_MS);
    try { return toContent(await callInWindow(who(), r.params.name, r.params.arguments ?? {})) as never; } finally { clearInterval(timer); }
  });
  mcp.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: RESOURCES.map(({ uri, name, description, mimeType }) => ({ uri, name, description, mimeType })) }));
  mcp.setRequestHandler(ReadResourceRequestSchema, async (r) => {
    const res = RESOURCES.find((x) => x.uri === r.params.uri);
    if (!res) throw new Error(`No resource ${r.params.uri}. Resources: ${RESOURCES.map((x) => x.uri).join(', ')}`);
    const out = await callInWindow(who(), res.tool, res.args);
    if (!out.ok) throw new Error(`${out.error.message}${out.error.hint ? ` ${out.error.hint}` : ''}`);
    return { contents: [{ uri: res.uri, mimeType: res.mimeType, text: JSON.stringify(out.data, null, 2) }] };
  });
  mcp.setRequestHandler(ListPromptsRequestSchema, async () => ({ prompts: PROMPTS.map(({ name, title, description, arguments: a }) => ({ name, title, description, arguments: a })) }));
  mcp.setRequestHandler(GetPromptRequestSchema, async (r) => {
    const p = PROMPTS.find((x) => x.name === r.params.name);
    if (!p) throw new Error(`No prompt ${r.params.name}. Prompts: ${PROMPTS.map((x) => x.name).join(', ')}`);
    return { description: p.description, messages: [{ role: 'user' as const, content: { type: 'text' as const, text: p.text(r.params.arguments ?? {}) } }] };
  });
  return mcp;
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

function authorized(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer (\S+)$/.exec(h);
  if (!m) return false;
  const a = Buffer.from(m[1]!), b = Buffer.from(token());
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readJson(req: IncomingMessage, res: ServerResponse): Promise<{ ok: true; body: unknown } | { ok: false }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) { size += (c as Buffer).length; if (size > 8 * 1024 * 1024) { deny(res, 413, 'Too large'); return { ok: false }; } chunks.push(c as Buffer); }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return { ok: true, body: {} };
  try { return { ok: true, body: JSON.parse(text) }; } catch { deny(res, 400, 'Invalid JSON'); return { ok: false }; }
}

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Plain HTTP for agents that do not speak MCP: tool definitions in three formats, and tool calls. */
async function handleRest(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (url.pathname === '/api/tools' && req.method === 'GET') {
    const format = url.searchParams.get('format') ?? 'mcp';
    if (!['mcp', 'anthropic', 'openai'].includes(format)) return sendJson(res, 400, { error: 'format must be mcp, anthropic or openai' });
    return sendJson(res, 200, { app: 'director', version: app.getVersion(), format, tools: manifest(format as 'mcp') });
  }
  const m = /^\/api\/tools\/([a-z0-9_]{1,64})$/.exec(url.pathname);
  if (m && req.method === 'POST') {
    if (!catalog().has(m[1]!)) return sendJson(res, 404, { ok: false, error: { code: 'UNKNOWN_TOOL', message: `There is no tool called ${m[1]}.`, hint: 'GET /api/tools lists them.' } });
    const body = await readJson(req, res);
    if (!body.ok) return;
    const client = clientName(req, { name: typeof req.headers['x-director-client'] === 'string' ? req.headers['x-director-client'] : undefined });
    const out = await callInWindow(client, m[1]!, body.body);
    return sendJson(res, out.ok ? 200 : 422, out);
  }
  if (m || url.pathname === '/api/tools') return deny(res, 405, 'Use GET /api/tools or POST /api/tools/<name>');
  return deny(res, 404, 'Not found');
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  // DNS-rebinding and browser guards: loopback Host only, and no cross-origin browser requests.
  const host = (req.headers.host ?? '').toLowerCase();
  if (!port || (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`)) return deny(res, 403, 'Forbidden host');
  if (req.headers.origin) return deny(res, 403, 'Browser requests are not allowed');
  if (!authorized(req)) { res.setHeader('www-authenticate', 'Bearer'); return deny(res, 401, 'Missing or wrong token'); }
  const url = new URL(req.url ?? '/', `http://${host}`);
  if (url.pathname.startsWith('/api/')) return handleRest(req, res, url);
  if (url.pathname !== '/mcp') return deny(res, 404, 'Not found');
  const sid = req.headers['mcp-session-id'];
  const session = typeof sid === 'string' ? sessions.get(sid) : undefined;
  if (req.method === 'DELETE' && session) return session.transport.handleRequest(req as never, res);
  if (req.method !== 'POST') return deny(res, 405, 'Use POST');
  const body = await readJson(req, res);
  if (!body.ok) return;
  if (typeof sid === 'string') {
    if (!session) return deny(res, 404, 'Unknown or expired session; send initialize again');
    session.seen = Date.now();
    return session.transport.handleRequest(req as never, res, body.body);
  }
  // A new session starts with initialize; the client's own name labels everything it does.
  const msgs = (Array.isArray(body.body) ? body.body : [body.body]) as Array<{ method?: string; params?: { clientInfo?: { name?: string; version?: string } } }>;
  const init = msgs.find((m) => m?.method === 'initialize');
  if (!init) return deny(res, 400, 'Start with initialize (no mcp-session-id header was sent)');
  const holder = { client: clientName(req, init.params?.clientInfo) };
  const mcp = buildServer(() => holder.client);
  const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    // Server-sent events: headers go out at once and heartbeats can follow during long calls.
    enableJsonResponse: false,
    onsessioninitialized: (id) => { sessions.set(id, { transport, client: holder.client, seen: Date.now() }); prune(); },
  });
  transport.onclose = () => { if (transport.sessionId) sessions.delete(transport.sessionId); };
  await mcp.connect(transport);
  await transport.handleRequest(req as never, res, body.body);
}

const sessions = new Map<string, { transport: StreamableHTTPServerTransport; client: string; seen: number }>();
const SESSION_IDLE_MS = 24 * 3600_000;
function prune(): void {
  const now = Date.now();
  for (const [id, s] of sessions) if (now - s.seen > SESSION_IDLE_MS) { sessions.delete(id); void s.transport.close(); }
  while (sessions.size > 100) { const [oldest] = [...sessions.entries()].sort((a, b) => a[1].seen - b[1].seen); if (!oldest) break; sessions.delete(oldest[0]); void oldest[1].transport.close(); }
}

function writeConnection(): void {
  const file = connectionFile();
  // Where the running app listens, for the stdio bridge. The token is not in it: clients carry their own.
  writeFileSync(file, JSON.stringify({ url: `http://127.0.0.1:${port}/mcp`, port, pid: process.pid, version: app.getVersion(), startedAt: new Date().toISOString() }), { mode: 0o600 });
  chmodSync(file, 0o600);
}

export async function start(): Promise<McpStatus> {
  if (server) return status();
  token();
  const want = process.env.DIRECTOR_MCP_PORT != null ? Number(process.env.DIRECTOR_MCP_PORT) : getSetting<number>('mcp.port', DEFAULT_PORT);
  const s = createServer((req, res) => { handle(req, res).catch((e) => { if (!res.headersSent) deny(res, 500, (e as Error).message); }); });
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(want, '127.0.0.1', () => { s.off('error', reject); resolve(); });
  }).catch((e) => { lastError = (e as Error).message; throw Object.assign(new Error(`Could not start agent access on port ${want}: ${(e as Error).message}`), { code: 'MCP_PORT' }); });
  server = s;
  const addr = s.address();
  port = typeof addr === 'object' && addr ? addr.port : want;
  lastError = null;
  try { writeConnection(); } catch (e) { lastError = `Could not write ${connectionFile()}: ${(e as Error).message}`; }
  broadcast('mcp:status', status());
  return status();
}

export async function stop(): Promise<McpStatus> {
  for (const [id] of calls) result(id, { ok: false, error: { code: 'BRIDGE_OFF', message: 'Agent access was turned off in Director.' } });
  for (const [, x] of sessions) void x.transport.close();
  sessions.clear();
  const s = server;
  server = null;
  port = null;
  rmSync(connectionFile(), { force: true });
  if (s) await new Promise<void>((r) => { s.closeAllConnections?.(); s.close(() => r()); });
  broadcast('mcp:status', status());
  return status();
}

/** Start at launch if the user turned the bridge on. */
export async function initMcp(): Promise<void> {
  if (getSetting<boolean>('mcp.enabled', false)) await start().catch(() => undefined);
}

export const mcpHandlers = {
  'mcp:status': () => status(),
  'mcp:enable': async ({ on, rotateToken }: { on: boolean; rotateToken?: boolean }) => {
    if (rotateToken) setSecret('mcp.token', null);
    setSetting('mcp.enabled', on);
    return on ? start() : stop();
  },
  'agent:setMode': ({ mode: m }: { mode: AgentMode }) => { setSetting('agent.mode', m); broadcast('mcp:status', status()); return status(); },
  'agent:result': ({ requestId, response }: { requestId: string; response: ToolResponse }) => result(requestId, response),
};

