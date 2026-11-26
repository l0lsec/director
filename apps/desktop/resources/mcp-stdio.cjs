#!/usr/bin/env node
'use strict';
// Director MCP bridge for clients that launch servers over stdio (Claude Desktop). It forwards each
// JSON-RPC message to the running Director app on 127.0.0.1 and writes the answers back.
// Run it with the Director binary in Node mode (ELECTRON_RUN_AS_NODE=1); it has no dependencies.
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const TOKEN = process.env.DIRECTOR_MCP_TOKEN || '';
const FILE = process.env.DIRECTOR_CONNECTION_FILE || path.join(os.homedir(), 'Library', 'Application Support', 'Director', 'agent-connection.json');
const NOT_RUNNING = 'Director is not running, or "Allow AI assistants to control Director" is off. Open Director, then Settings (Cmd+,) > Connect an AI, and try again.';
let protocolVersion = null;
let sessionId = null;
let initLine = null;

const write = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
const fail = (id, message) => { if (id !== undefined && id !== null) write({ jsonrpc: '2.0', id, error: { code: -32000, message } }); };

function connection() {
  try {
    const c = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    const u = new URL(c.url);
    if (u.hostname !== '127.0.0.1' || u.protocol !== 'http:') return null;
    return u;
  } catch { return null; }
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${TOKEN}`, 'user-agent': 'director-mcp-stdio', 'content-length': Buffer.byteLength(body) };
    if (protocolVersion) headers['mcp-protocol-version'] = protocolVersion;
    if (sessionId) headers['mcp-session-id'] = sessionId;
    const req = http.request({ host: '127.0.0.1', port: url.port, path: url.pathname, method: 'POST', headers }, (res) => {
      let text = '';
      const sse = /text\/event-stream/.test(String(res.headers['content-type'] || ''));
      const messages = [];
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (!sse) { text += c; return; }
        // Server-sent events: pass notifications (progress, "still working") through as they arrive; keep results.
        buf += c;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const event = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = event.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).replace(/^ /, '')).join('\n');
          if (!data) continue;
          let o; try { o = JSON.parse(data); } catch { continue; }
          if (o && o.method && o.id === undefined) write(o); else messages.push(o);
        }
      });
      res.on('end', () => resolve({ status: res.statusCode, text: sse ? (messages.length ? JSON.stringify(messages) : '') : text, session: res.headers['mcp-session-id'] }));
    });
    req.on('error', reject);
    req.setTimeout(65 * 60_000, () => req.destroy(new Error('timed out')));
    req.end(body);
  });
}

async function forward(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return; }
  const id = Array.isArray(msg) ? undefined : msg.id;
  const url = connection();
  if (!url) return fail(id, NOT_RUNNING);
  if (!TOKEN) return fail(id, 'No token. Copy the Claude Desktop setup again from Director > Settings > Connect an AI.');
  const isInit = !Array.isArray(msg) && msg.method === 'initialize';
  if (isInit) { initLine = line; sessionId = null; }
  let res;
  try {
    res = await post(url, line);
    // Director restarted (or the session expired): open a new session the same way and try once more.
    if (res.status === 404 && sessionId && initLine && !isInit) {
      sessionId = null;
      const again = await post(url, initLine);
      if (again.session) sessionId = again.session;
      await post(url, JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
      res = await post(url, line);
    }
  } catch (e) { return fail(id, e && e.code === 'ECONNREFUSED' ? NOT_RUNNING : `Could not reach Director: ${e.message}`); }
  if (isInit && res.session) sessionId = res.session;
  if (res.status === 202 || !res.text.trim()) return;
  if (res.status === 401) return fail(id, 'Director refused the token (it was probably changed). Copy the Claude Desktop setup again from Director > Settings > Connect an AI.');
  let out;
  try { out = JSON.parse(res.text); } catch { return fail(id, `Director answered ${res.status}: ${res.text.slice(0, 200)}`); }
  for (const o of Array.isArray(out) ? out : [out]) {
    if (o && o.result && o.result.protocolVersion && msg.method === 'initialize') protocolVersion = o.result.protocolVersion;
    write(o);
  }
}

// One message at a time, in order.
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => { if (line.trim()) chain = chain.then(() => forward(line)).catch(() => undefined); });
rl.on('close', () => { chain.then(() => process.exit(0)); });
