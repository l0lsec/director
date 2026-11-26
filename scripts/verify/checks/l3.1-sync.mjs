import { assert, tmp } from '../lib.mjs';
import { launchEditor, importFixtures, fillLane, exportAndWait } from '../edit-lib.mjs';
import { avOffsets } from '../capture-lib.mjs';

// A 10-minute flash/beep timeline must export with audio and video still together at the end.
export default async function () {
  const minutes = Number(process.env.DIRECTOR_EXPORT_SYNC_MINUTES ?? 10);
  const out = tmp('export-sync');
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  let file;
  try {
    const [m] = await importFixtures(win, ['sync-1080p30.mp4']);
    await fillLane(win, m, 'camera', minutes * 60_000_000, 10_000_000);
    file = `${out}/sync.mp4`;
    const job = await exportAndWait(win, 'youtube-1080', file, { loudness: false }, 3_600_000);
    assert(job.status === 'done', `export ${job.status}: ${job.error}`);
  } finally { await app.close(); }
  const offs = avOffsets(file);
  const end = offs.filter((o) => o.t > minutes * 60 - 20).map((o) => o.offset);
  const start = offs.filter((o) => o.t < 20).map((o) => o.offset);
  const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const detail = `${offs.length} flash/beep pairs; offset start ${(med(start) * 1000).toFixed(1)} ms, end ${(med(end) * 1000).toFixed(1)} ms`;
  assert(offs.length >= minutes * 60 * 0.95, `paired only ${offs.length}: ${detail}`);
  assert(Math.abs(med(end)) <= 1 / 30 && Math.abs(med(start)) <= 1 / 30, `out of sync: ${detail}`);
  return detail;
}
