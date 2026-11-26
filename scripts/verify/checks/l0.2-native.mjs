import { sh, assert, root } from '../lib.mjs';
import { join } from 'node:path';

export default async function () {
  const pkg = join(root, 'native/DirectorKit');
  sh('swift', ['build', '-c', 'release'], { cwd: pkg, timeout: 900_000 });
  const bin = join(pkg, '.build/release/director-native');
  const parse = (out) => out.trim().split('\n').map((l) => JSON.parse(l));
  const [v] = parse(sh(bin, ['version']).stdout);
  assert(v.name === 'director-native' && typeof v.version === 'string' && v.protocol >= 1 && /^\d+\.\d+/.test(v.macos), `version: ${JSON.stringify(v)}`);
  const devices = parse(sh(bin, ['devices']).stdout);
  for (const d of devices) {
    assert(typeof d.id === 'string' && d.id && typeof d.name === 'string' && (d.kind === 'video' || d.kind === 'audio'), `device shape: ${JSON.stringify(d)}`);
    if (d.kind === 'video') assert(Array.isArray(d.formats) && d.formats.every((f) => f.width > 0 && f.height > 0 && f.maxFps > 0), `formats for ${d.name}`);
  }
  assert(devices.some((d) => d.kind === 'audio'), 'at least one microphone listed');
  const bad = sh(bin, ['no-such-command'], { allowFail: true });
  assert(bad.status === 2 && JSON.parse(bad.stdout.trim()).error, 'unknown command exits 2 with JSON error');
  return `director-native ${v.version} on macOS ${v.macos}; ${devices.length} devices`;
}
