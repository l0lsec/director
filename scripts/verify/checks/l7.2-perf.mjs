import { spawn, execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { assert, sh, tmp, ensurePackaged } from '../lib.mjs';

const COLD_BUDGET_MS = 2500;
const IDLE_BUDGET_PCT = 2;

/** CPU seconds used so far by a process and all its descendants. */
function treeCpuSeconds(rootPid) {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time='], { encoding: 'utf8' }).trim().split('\n').map((l) => l.trim().split(/\s+/));
  const kids = new Map();
  const time = new Map();
  for (const [pid, ppid, t] of rows) {
    (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(pid);
    const parts = t.split(':').map(Number);
    time.set(pid, parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1]);
  }
  let sum = 0, n = 0;
  const walk = (p) => { sum += time.get(p) ?? 0; n++; for (const k of kids.get(p) ?? []) walk(k); };
  walk(String(rootPid));
  return { seconds: sum, processes: n };
}

/** Launch the app binary directly and time process start to its first painted window. */
function launch(appPath, home) {
  return new Promise((resolve, reject) => {
    const t0 = performance.now();
    const child = spawn(join(appPath, 'Contents', 'MacOS', 'Director'), [], {
      env: { PATH: '/usr/bin:/bin', HOME: home, TMPDIR: process.env.TMPDIR, DIRECTOR_USER_DATA: join(home, 'ud'), DIRECTOR_PROJECTS_DIR: join(home, 'p'), DIRECTOR_STARTUP_LOG: '1', DIRECTOR_BUNDLED_ONLY: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`no ready line in 30 s: ${out.slice(-300)}`)); }, 30_000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /DIRECTOR_READY (\d+)/.exec(out);
      if (m) { clearTimeout(timer); resolve({ child, wallMs: Math.round(performance.now() - t0), inAppMs: Number(m[1]) }); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`exited ${code} before ready: ${out.slice(-300)}`)); });
  });
}

const stop = (child) => new Promise((r) => { child.removeAllListeners('exit'); child.once('exit', r); child.kill('SIGTERM'); setTimeout(() => child.kill('SIGKILL'), 5000); });

export default async function () {
  const built = ensurePackaged();
  // A fresh copy is a new binary to macOS (first launch pays signature assessment), the coldest
  // start available without purging caches as root.
  const apps = tmp('l7.2-perf-apps');
  const copy = join(apps, 'Director.app');
  sh('ditto', [built, copy]);
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const home = tmp(`l7.2-perf-home-${i}`);
    const r = await launch(copy, home);
    runs.push(r);
    if (i < 3) await stop(r.child);
  }
  const first = runs[0];
  const sorted = runs.slice(1).map((r) => r.wallMs).sort((a, b) => a - b);
  const warm = sorted[1];
  const maxInApp = Math.max(...runs.map((r) => r.inAppMs));
  // Gate on what the app controls: its own start (process start to first paint) on every launch, and
  // spawn-to-window on launches after the OS has accepted the install. The first launch of a new copy
  // also includes macOS's one-time signature assessment, reported separately (leaf-7.2 G3 note).
  assert(maxInApp <= COLD_BUDGET_MS, `app start up to ${maxInApp} ms (budget ${COLD_BUDGET_MS}); runs ${runs.map((r) => `${r.wallMs}/${r.inAppMs}`).join(', ')}`);
  assert(sorted.at(-1) <= COLD_BUDGET_MS, `a launch took ${sorted.at(-1)} ms spawn to window (budget ${COLD_BUDGET_MS})`);
  // Idle: the last instance sits on first-run onboarding (camera off) for 5 s, then 15 s are measured.
  const live = runs[3].child;
  try {
    await new Promise((r) => setTimeout(r, 5000));
    const a = treeCpuSeconds(live.pid);
    const t0 = performance.now();
    await new Promise((r) => setTimeout(r, 15_000));
    const b = treeCpuSeconds(live.pid);
    const pct = ((b.seconds - a.seconds) / ((performance.now() - t0) / 1000)) * 100;
    assert(b.processes >= 3, `only ${b.processes} processes found for the app`);
    assert(pct <= IDLE_BUDGET_PCT, `idle CPU ${pct.toFixed(2)}% over ${b.processes} processes (budget ${IDLE_BUDGET_PCT}%)`);
    return `app start (process start to first painted window, fresh profile) ${runs.map((r) => r.inAppMs).join('/')} ms, spawn to window ${sorted.join('/')} ms (median ${warm}), budget ${COLD_BUDGET_MS} ms; first launch of a newly copied bundle ${first.wallMs} ms, of which ${first.wallMs - first.inAppMs} ms is before the process starts (macOS one-time assessment); idle CPU ${pct.toFixed(2)}% across ${b.processes} processes over 15 s, budget ${IDLE_BUDGET_PCT}%`;
  } finally { await stop(live); }
}
