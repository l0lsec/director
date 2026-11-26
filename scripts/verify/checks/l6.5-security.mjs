import { request } from 'node:http';
import { connect } from 'node:net';
import { networkInterfaces } from 'node:os';
import { assert, sh } from '../lib.mjs';
import { launchStudio, call } from '../swipe-lib.mjs';

const INIT = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } } });

function post(port, { host = `127.0.0.1:${port}`, token, auth, origin, method = 'POST', path = '/mcp', address = '127.0.0.1' } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { host, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
    if (token) headers.authorization = `Bearer ${token}`;
    if (auth) headers.authorization = auth;
    if (origin) headers.origin = origin;
    const req = request({ host: address, port, path, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(method === 'POST' ? INIT : undefined);
  });
}

const refused = (address, port) => new Promise((resolve) => {
  const s = connect({ host: address, port, timeout: 1500 });
  s.on('connect', () => { s.destroy(); resolve(false); });
  s.on('error', () => resolve(true));
  s.on('timeout', () => { s.destroy(); resolve(true); });
});

export default async function () {
  const { app, win } = await launchStudio({ tab: 'edit' });
  try {
    const off = await call(win, 'mcp:status', {});
    assert(!off.enabled && !off.running, 'the bridge must be off until turned on');
    const st = await call(win, 'mcp:enable', { on: true });
    const { port, token } = st;
    assert(st.running && port > 0 && token.length >= 32, `status ${JSON.stringify({ running: st.running, port })}`);
    // Bound to loopback only: the OS listener table and a connect from a LAN address.
    const lsof = sh('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { allowFail: true }).stdout;
    const listen = lsof.split('\n').filter((l) => /LISTEN/.test(l));
    assert(listen.length >= 1 && listen.every((l) => l.includes(`127.0.0.1:${port}`)), `listeners: ${listen.join(' / ')}`);
    const lan = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
    for (const ip of lan) assert(await refused(ip, port), `reachable on ${ip}:${port}`);
    // Positive control first: the right token on the right host works.
    const ok = await post(port, { token });
    assert(ok.status === 200 && /"name":"director"/.test(ok.body), `valid request: ${ok.status} ${ok.body.slice(0, 200)}`);
    const cases = [
      ['no token', await post(port, {}), 401],
      ['wrong token', await post(port, { token: token.slice(0, -2) + 'xx' }), 401],
      ['token in a different scheme', await post(port, { auth: `Basic ${token}` }), 401],
      ['foreign Host (DNS rebinding)', await post(port, { token, host: 'evil.example:80' }), 403],
      ['browser Origin', await post(port, { token, origin: 'https://evil.example' }), 403],
      ['GET', await post(port, { token, method: 'GET' }), 405],
      ['other path', await post(port, { token, path: '/admin' }), 404],
    ];
    const bad = cases.filter(([, r, want]) => r.status !== want).map(([n, r, want]) => `${n}: ${r.status} (want ${want})`);
    assert(!bad.length, bad.join('; '));
    // A new token invalidates the old one.
    const rotated = await call(win, 'mcp:enable', { on: true, rotateToken: true });
    assert(rotated.token !== token, 'token did not change');
    assert((await post(rotated.port, { token })).status === 401, 'old token still accepted');
    assert((await post(rotated.port, { token: rotated.token })).status === 200, 'new token rejected');
    // Off means off.
    await call(win, 'mcp:enable', { on: false });
    assert(await refused('127.0.0.1', rotated.port), 'still listening after turning off');
    return `listens on 127.0.0.1:${port} only (${lan.length} LAN address(es) refused); valid token 200; no or wrong token 401, foreign Host or browser Origin 403, GET 405, other path 404; rotated token revokes the old one; off closes the port`;
  } finally { await app.close(); }
}
