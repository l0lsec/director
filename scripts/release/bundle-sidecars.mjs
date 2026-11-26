#!/usr/bin/env node
// Copy the sidecar executables into apps/desktop/build/sidecars/bin together with every non-system
// dynamic library they load (recursively), rewrite their load commands to point inside the bundle,
// and ad-hoc sign every Mach-O file. The result runs on a Mac without Homebrew.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, copyFileSync, chmodSync, realpathSync, readdirSync, statSync, writeFileSync, readFileSync } from 'node:fs';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'apps', 'desktop', 'build', 'sidecars');
const BIN = join(out, 'bin');
const LIB = join(out, 'lib');

const which = (name, extra = []) => {
  for (const d of [...extra, '/opt/homebrew/bin', '/usr/local/bin']) { const p = join(d, name); if (existsSync(p)) return realpathSync(p); }
  throw new Error(`${name} not found; install it first`);
};
const SOURCES = {
  ffmpeg: which('ffmpeg'),
  ffprobe: which('ffprobe'),
  'whisper-cli': which('whisper-cli'),
  'director-native': which('director-native', [join(root, 'native', 'DirectorKit', '.build', 'release')]),
};

const run = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 << 20 });
const isSystem = (p) => p.startsWith('/usr/lib/') || p.startsWith('/System/');

function rpaths(file) {
  const lines = run('otool', ['-l', file]).split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) if (/cmd LC_RPATH/.test(lines[i])) { const m = /path (\S+)/.exec(lines[i + 2] ?? ''); if (m) out.push(m[1]); }
  return out;
}

/** Resolve a load command (absolute, @rpath, @loader_path, @executable_path) for a given Mach-O file. */
function resolveDep(dep, file, exe) {
  const fileDir = dirname(realpathSync(file));
  if (dep.startsWith('@loader_path/')) return join(fileDir, dep.slice('@loader_path/'.length));
  if (dep.startsWith('@executable_path/')) return join(dirname(exe), dep.slice('@executable_path/'.length));
  if (dep.startsWith('@rpath/')) {
    const rest = dep.slice('@rpath/'.length);
    for (const rp of [...rpaths(file), ...rpaths(exe)]) {
      const base = rp.replace('@loader_path', fileDir).replace('@executable_path', dirname(exe));
      const p = join(base, rest);
      if (existsSync(p)) return p;
    }
    for (const guess of ['/opt/homebrew/lib', '/usr/local/lib']) if (existsSync(join(guess, rest))) return join(guess, rest);
    throw new Error(`cannot resolve ${dep} for ${file}`);
  }
  return dep;
}

function deps(file) {
  return run('otool', ['-L', file]).split('\n').slice(1).map((l) => l.trim().split(' (')[0]).filter(Boolean);
}

rmSync(out, { recursive: true, force: true });
mkdirSync(BIN, { recursive: true });
mkdirSync(LIB, { recursive: true });

const copied = new Map(); // real source path -> bundled file name
const queue = [];
for (const [name, src] of Object.entries(SOURCES)) {
  const dest = join(BIN, name);
  copyFileSync(src, dest);
  chmodSync(dest, 0o755);
  queue.push({ src, dest, exe: src, kind: 'bin' });
}

// ggml (whisper) loads its CPU and Metal backends at runtime from a directory compiled into libggml.
// Ship them next to the executable, which ggml also searches, and blank the compiled-in path below.
const ggmlDir = (() => {
  try { return run('strings', ['-a', realpathSync('/opt/homebrew/opt/ggml/lib/libggml.dylib')]).split('\n').find((l) => /\/libexec$/.test(l) && existsSync(l)) ?? null; } catch { return null; }
})();
if (ggmlDir) for (const f of readdirSync(ggmlDir).filter((f) => f.endsWith('.so'))) {
  const dest = join(BIN, f);
  copyFileSync(join(ggmlDir, f), dest);
  chmodSync(dest, 0o755);
  queue.push({ src: join(ggmlDir, f), dest, exe: SOURCES['whisper-cli'], kind: 'plugin' });
}

const work = [];
while (queue.length) {
  const item = queue.shift();
  const changes = [];
  const id = item.kind !== 'bin' ? run('otool', ['-D', item.src]).split('\n')[1]?.trim() : null;
  for (const dep of deps(item.src)) {
    if (dep === id) continue;
    if (isSystem(dep)) continue;
    const real = realpathSync(resolveDep(dep, item.src, item.exe));
    let name = copied.get(real);
    if (!name) {
      name = basename(dep.startsWith('@') ? dep : real);
      // Keep the name the binary asks for (often a versioned symlink name).
      if (dep.startsWith('/')) name = basename(dep);
      copied.set(real, name);
      const dest = join(LIB, name);
      copyFileSync(real, dest);
      chmodSync(dest, 0o755);
      queue.push({ src: real, dest, exe: item.exe, kind: 'lib' });
    }
    changes.push([dep, item.kind === 'bin' ? `@executable_path/../lib/${name}` : item.kind === 'plugin' ? `@loader_path/../lib/${name}` : `@loader_path/${name}`]);
  }
  work.push({ ...item, changes, id });
}

for (const w of work) {
  const args = [];
  for (const [from, to] of w.changes) args.push('-change', from, to);
  if (w.kind !== 'bin') args.push('-id', `@rpath/${basename(w.dest)}`);
  if (args.length) execFileSync('install_name_tool', [...args, w.dest], { stdio: 'pipe' });
  // Old rpaths would point back into Homebrew or the build tree.
  for (const rp of rpaths(w.dest)) execFileSync('install_name_tool', ['-delete_rpath', rp, w.dest], { stdio: 'pipe' });
}
if (ggmlDir) {
  // Same-length replacement keeps the binary layout intact; the new path does not exist anywhere.
  for (const f of readdirSync(LIB).filter((f) => f.startsWith('libggml'))) {
    const p = join(LIB, f);
    const buf = readFileSync(p);
    const needle = Buffer.from(ggmlDir);
    let at = buf.indexOf(needle);
    while (at >= 0) {
      Buffer.from('/nonexistent/director-ggml'.padEnd(needle.length, '\0')).copy(buf, at);
      at = buf.indexOf(needle, at + needle.length);
    }
    writeFileSync(p, buf);
  }
}
for (const w of work) execFileSync('codesign', ['--force', '--sign', '-', w.dest], { stdio: 'pipe' });

// Any library still pointing outside the bundle or the OS is a packaging bug.
const leaks = [];
for (const dir of [BIN, LIB]) for (const f of readdirSync(dir)) {
  for (const d of deps(join(dir, f))) if (!isSystem(d) && !d.startsWith('@executable_path/../lib/') && !d.startsWith('@loader_path/') && !d.startsWith('@rpath/')) leaks.push(`${f} -> ${d}`);
  if (ggmlDir && readFileSync(join(dir, f)).includes(Buffer.from(ggmlDir))) leaks.push(`${f} still names ${ggmlDir}`);
}
if (leaks.length) { console.error(`BUNDLE FAIL: external references remain:\n${leaks.join('\n')}`); process.exit(1); }
const size = [...readdirSync(BIN).map((f) => join(BIN, f)), ...readdirSync(LIB).map((f) => join(LIB, f))].reduce((n, p) => n + statSync(p).size, 0);
writeFileSync(join(out, 'manifest.json'), JSON.stringify({ sources: SOURCES, libs: [...copied.values()].sort(), bytes: size }, null, 2));
console.log(`bundled ${Object.keys(SOURCES).length} sidecars and ${copied.size} libraries (${(size / 1e6).toFixed(1)} MB) into ${out}`);
