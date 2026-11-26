// Helpers for M8 checks: an app with a project open and an MCP client connected the way Claude Code connects.
import { request } from 'node:http';
import { assert, fixture, groundTruth, tmp } from './lib.mjs';
import { launchStudio, call, directorProject, mcpConnect } from './swipe-lib.mjs';

/** Launch, open the talking-head fixture project, turn agent access on in `mode`, connect a client. */
export async function agentSession({ mode = 'auto', project = true, env = {}, name = 'director-check' } = {}) {
  const exportDir = tmp(`m8-exports-${Math.random().toString(16).slice(2)}`);
  const { app, win, userData, projects, work } = await launchStudio({ tab: 'edit', env: { DIRECTOR_EXPORT_DIR: exportDir, ...env } });
  if (project) await directorProject(win, groundTruth(), fixture);
  const { client, status } = await mcpConnect(win, { name });
  await call(win, 'agent:setMode', { mode });
  const close = async () => { await client.close().catch(() => undefined); await app.close(); };
  return { app, win, client, status: await call(win, 'mcp:status', {}), port: status.port, token: status.token, userData, projects, work, exportDir, close };
}

/** Call a tool; returns { error: text } for tool errors, the parsed JSON otherwise (and the image, if any). */
export async function tool(client, name, args = {}, timeout = 600_000) {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout });
  const text = r.content.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) return { error: text };
  const image = r.content.find((c) => c.type === 'image');
  const data = text ? JSON.parse(text) : {};
  return image ? { ...data, image } : data;
}

/** Like tool() but throws on a tool error. */
export async function must(client, name, args = {}, timeout) {
  const r = await tool(client, name, args, timeout);
  assert(!r.error, `${name} ${JSON.stringify(args).slice(0, 200)} failed: ${r.error}`);
  return r;
}

export const appDoc = (win) => win.evaluate(() => globalThis.__directorProject().doc);
export const appRevision = (win) => win.evaluate(() => globalThis.__directorProject().revision);
export const undoLabel = (win) => win.evaluate(() => globalThis.__directorProject().undoLabel);

/** Plain HTTP to the agent server (REST API and security probes). */
export function http(port, { method = 'GET', path = '/api/tools', token, body, host = `127.0.0.1:${port}`, origin, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { host, 'content-type': 'application/json', ...headers };
    if (token) h.authorization = `Bearer ${token}`;
    if (origin) h.origin = origin;
    const req = request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch { /* not json */ } resolve({ status: res.statusCode, text, json }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
