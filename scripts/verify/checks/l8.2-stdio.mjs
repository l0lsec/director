import { spawn } from 'node:child_process';
import { assert, requireFromDesktop } from '../lib.mjs';
import { call } from '../swipe-lib.mjs';
import { agentSession, appDoc } from '../agent-lib.mjs';

/** Raw stdio exchange with the bridge: write JSON-RPC lines, collect the answers. */
function rawStdio(entry, messages, envPatch = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(entry.command, entry.args, { env: { PATH: '/usr/bin:/bin', HOME: process.env.HOME, ...entry.env, ...envPatch }, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error(`stdio bridge timed out: ${out}`)); }, 20_000);
    child.stdout.on('data', (d) => { out += d; if (out.split('\n').filter(Boolean).length >= messages.filter((m) => m.id != null).length) child.stdin.end(); });
    child.on('exit', () => { clearTimeout(timer); resolve(out.split('\n').filter(Boolean).map((l) => JSON.parse(l))); });
    for (const m of messages) child.stdin.write(`${JSON.stringify(m)}\n`);
  });
}

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } } };

export default async function () {
  const s = await agentSession({ mode: 'auto' });
  const { win } = s;
  try {
    // The snippet Settings shows for Claude Desktop, run exactly as Claude Desktop would.
    const cfg = JSON.parse(s.status.setup.claudeDesktop);
    const entry = cfg.mcpServers.director;
    assert(entry.command && entry.args?.length === 1 && entry.env.ELECTRON_RUN_AS_NODE === '1' && entry.env.DIRECTOR_MCP_TOKEN === s.token, `snippet ${JSON.stringify({ ...entry, env: Object.keys(entry.env) })}`);
    const { Client } = requireFromDesktop('@modelcontextprotocol/sdk/client/index.js');
    const { StdioClientTransport, getDefaultEnvironment } = requireFromDesktop('@modelcontextprotocol/sdk/client/stdio.js');
    const client = new Client({ name: 'claude-ai', version: '1.0.0' });
    await client.connect(new StdioClientTransport({ command: entry.command, args: entry.args, env: { ...getDefaultEnvironment(), ...entry.env } }));
    let n, name, marker;
    try {
      n = (await client.listTools()).tools.length;
      const tl = JSON.parse((await client.callTool({ name: 'get_timeline', arguments: {} })).content[0].text);
      name = tl.name;
      const r = JSON.parse((await client.callTool({ name: 'add_marker', arguments: { at: 4, label: 'from Claude Desktop' } })).content[0].text);
      marker = r.applied;
      // Director restarts its agent server (sessions are gone); the same running bridge reconnects by itself.
      await call(win, 'mcp:enable', { on: false });
      await call(win, 'mcp:enable', { on: true });
      const again = await client.callTool({ name: 'get_state', arguments: {} });
      assert(!again.isError && JSON.parse(again.content[0].text).project === name, `after a server restart: ${JSON.stringify(again).slice(0, 200)}`);
    } finally { await client.close(); }
    const doc = await appDoc(win);
    assert(n === s.status.tools && name === doc.name && marker, `stdio: ${n} tools, name ${name}, marker ${marker}`);
    const act = await win.evaluate(() => globalThis.__directorAgent.state().activity);
    assert(act.some((a) => a.client === 'Claude Desktop' && a.tool === 'add_marker' && a.status === 'applied'), `stdio client label: ${act.map((a) => a.client).join()}`);
    assert(doc.markers.some((m) => m.label === 'from Claude Desktop'), 'marker not in the app');
    // Bridge off: a clear message, not a hang.
    await call(win, 'mcp:enable', { on: false });
    const off = await rawStdio(entry, [INIT]);
    assert(off[0]?.error && /not running|is off/.test(off[0].error.message) && /Connect an AI/.test(off[0].error.message), `bridge off: ${JSON.stringify(off)}`);
    // Wrong token: says so.
    await call(win, 'mcp:enable', { on: true });
    const bad = await rawStdio(entry, [INIT], { DIRECTOR_MCP_TOKEN: 'wrong-token-wrong-token-wrong' });
    assert(bad[0]?.error && /refused the token/.test(bad[0].error.message), `wrong token: ${JSON.stringify(bad)}`);
    // Back on with the right token: works again.
    const ok = await rawStdio(entry, [INIT, { jsonrpc: '2.0', method: 'notifications/initialized' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
    assert(ok.length === 2 && ok[0].result?.serverInfo?.name === 'director' && ok[1].result?.tools?.length === n, `after re-enable: ${JSON.stringify(ok).slice(0, 300)}`);
    return `Claude Desktop snippet launched the bundled bridge as a separate process (${entry.command.split('/').pop()} in Node mode): ${n} tools, read "${name}", added a marker labelled Claude Desktop, and reconnected by itself after the server restarted; with access off it answered "${off[0].error.message.slice(0, 70)}..."; a wrong token was named as such; turning access back on worked`;
  } finally { await s.close(); }
}
