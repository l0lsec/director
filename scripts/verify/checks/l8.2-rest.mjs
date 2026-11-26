import { assert } from '../lib.mjs';
import { agentSession, http, appDoc } from '../agent-lib.mjs';

export default async function () {
  const s = await agentSession({ mode: 'auto' });
  const { win, port, token } = s;
  try {
    // Tool definitions in three formats, same tools in each.
    const fmt = {};
    for (const f of ['mcp', 'anthropic', 'openai']) {
      const r = await http(port, { path: `/api/tools?format=${f}`, token });
      assert(r.status === 200 && r.json.format === f && r.json.tools.length === s.status.tools, `${f}: ${r.status} ${r.json?.tools?.length}`);
      fmt[f] = r.json.tools;
    }
    const names = (f, pick) => fmt[f].map(pick).sort().join();
    assert(names('mcp', (t) => t.name) === names('anthropic', (t) => t.name) && names('mcp', (t) => t.name) === names('openai', (t) => t.function.name), 'formats disagree');
    const an = fmt.anthropic.find((t) => t.name === 'add_text');
    assert(an.input_schema.type === 'object' && an.input_schema.properties.text && an.input_schema.required.includes('text') && an.input_schema.required.includes('start') && /seconds/.test(an.description), 'anthropic add_text definition');
    const oa = fmt.openai.find((t) => t.function.name === 'set_audio');
    assert(oa.type === 'function' && oa.function.parameters.properties.volume && oa.function.description.length <= 1024, 'openai set_audio definition');
    // A function-calling loop: read, then call a write tool with arguments shaped by its schema.
    const tl = await http(port, { method: 'POST', path: '/api/tools/get_timeline', token, body: {}, headers: { 'x-director-client': 'My agent' } });
    assert(tl.status === 200 && tl.json.ok && tl.json.data.name === (await appDoc(win)).name, `get_timeline: ${tl.status} ${tl.text.slice(0, 200)}`);
    const add = await http(port, { method: 'POST', path: '/api/tools/add_text', token, body: { text: 'Hello from HTTP', start: 1, duration: 2 }, headers: { 'x-director-client': 'My agent' } });
    assert(add.status === 200 && add.json.data.applied && add.json.data.result.clip, `add_text: ${add.text.slice(0, 200)}`);
    const doc = await appDoc(win);
    assert(doc.lanes.find((l) => l.kind === 'titles').clips.some((c) => c.text?.content === 'Hello from HTTP'), 'title not in the app');
    assert((await win.evaluate(() => globalThis.__directorProject().undoLabel)).startsWith('My agent: '), 'client header not used as the label');
    const img = await http(port, { method: 'POST', path: '/api/tools/render_frame', token, body: { t: 1.5, width: 270 } });
    const png = Buffer.from(img.json.data.image.data, 'base64');
    assert(img.json.data.image.mimeType === 'image/png' && png.subarray(1, 4).toString() === 'PNG' && png.readUInt32BE(16) === 270, 'render_frame over HTTP');
    // Errors: unknown tool, bad arguments (with the fix), wrong method.
    const unknown = await http(port, { method: 'POST', path: '/api/tools/do_magic', token, body: {} });
    const badArgs = await http(port, { method: 'POST', path: '/api/tools/split', token, body: { at: 'later' } });
    const getCall = await http(port, { method: 'GET', path: '/api/tools/split', token });
    assert(unknown.status === 404 && unknown.json.error.code === 'UNKNOWN_TOOL', `unknown ${unknown.status}`);
    assert(badArgs.status === 422 && badArgs.json.error.code === 'INVALID_ARGS' && /describe_tool/.test(badArgs.json.error.hint), `bad args ${badArgs.text}`);
    assert(getCall.status === 405, `GET on a tool ${getCall.status}`);
    // Same guards as MCP.
    const guards = [
      ['no token', await http(port, {}), 401], ['wrong token', await http(port, { token: token.slice(0, -1) + 'x' }), 401],
      ['foreign host', await http(port, { token, host: 'evil.example' }), 403], ['browser origin', await http(port, { token, origin: 'https://evil.example' }), 403],
      ['no token on a call', await http(port, { method: 'POST', path: '/api/tools/add_text', body: { text: 'x', start: 0 } }), 401],
    ];
    const bad = guards.filter(([, r, want]) => r.status !== want).map(([n, r, want]) => `${n}: ${r.status} want ${want}`);
    assert(!bad.length, bad.join('; '));
    const titles = (await appDoc(win)).lanes.find((l) => l.kind === 'titles').clips.length;
    assert(titles === 1, `a refused call changed the project (${titles} titles)`);
    return `GET /api/tools serves ${s.status.tools} tools as MCP, Anthropic and OpenAI definitions; POST calls read the project, added a title labelled "My agent", and returned a PNG; unknown tool 404, bad arguments 422 with a fix, GET on a tool 405; no or wrong token 401, foreign host or browser origin 403`;
  } finally { await s.close(); }
}
