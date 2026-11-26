import { assert, groundTruth, tmp, sh } from '../lib.mjs';
import { launchEditor, speechProject, importFixtures, fillLane, exportAndWait } from '../edit-lib.mjs';

// Recorded-style session -> Make Reel -> export: vertical, captioned, no long pauses, loudness on target.
export default async function () {
  const g = groundTruth().retakes;
  const out = tmp('node4');
  const { app, win } = await launchEditor({ preset: 'landscape-1080' });
  try {
    const [cam] = await importFixtures(win, ['vertical-1080x1920.mp4']);
    await fillLane(win, cam, 'camera', Math.round(g.durationSec * 1e6), 5_000_000);
    await win.evaluate(() => { const d = globalThis.__directorProject().doc; globalThis.__directorProjectApply(d.lanes.find((l) => l.kind === 'camera').clips.map((c) => ({ op: 'updateClip', id: c.id, patch: { audio: { ...c.audio, muted: true } } })), 'mute camera'); });
    await speechProject(win, 'retakes.wav', { script: g.lines.join('\n') });
    const report = await win.evaluate(() => globalThis.__directorMakeReel.makeReel());
    const job = await exportAndWait(win, 'reels-30', `${out}/reel.mp4`);
    assert(job.status === 'done', `export ${job.status}: ${job.error}`);
    const v = JSON.parse(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height,duration', '-of', 'json', `${out}/reel.mp4`]).stdout);
    assert(v.streams[0].width === 1080 && v.streams[0].height === 1920, 'vertical export');
    // The video track is the timeline rounded up to whole frames; AAC priming can make the container a touch longer.
    const vd = Number(v.streams[0].duration);
    assert(Math.abs(vd - Math.ceil((report.after / 1e6) * 30) / 30) <= 1 / 30 + 0.001, `video ${vd} s vs timeline ${report.after / 1e6} s`);
    // Silence check on the export itself: no gap over 0.4 s once speech starts.
    const sil = sh('ffmpeg', ['-v', 'info', '-i', `${out}/reel.mp4`, '-vn', '-af', 'silencedetect=n=-35dB:d=0.4', '-f', 'null', '-']).stderr;
    const gaps = [...sil.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => Number(m[1]));
    assert(gaps.length === 0, `silences over 0.4 s in the export: ${gaps.join(', ')}`);
    // Captions are burned in: the caption band has bright pixels in the middle of the reel.
    const mid = (report.after / 2e6).toFixed(2);
    const band = sh('ffmpeg', ['-v', 'error', '-ss', mid, '-i', `${out}/reel.mp4`, '-frames:v', '1', '-vf', 'crop=1080:300:0:1080,signalstats,metadata=print:key=lavfi.signalstats.YMAX:file=-', '-f', 'null', '-']).stdout;
    assert(/YMAX=2[3-5]\d/.test(band), `no caption text in the caption band: ${band.trim().slice(-60)}`);
    const l = job.result.loudness;
    assert(l && Math.abs(l.integrated + 14) <= 1 && l.truePeak <= -1, `loudness ${JSON.stringify(l)}`);
    return `Make Reel ${(report.before / 1e6).toFixed(1)} s -> ${(report.after / 1e6).toFixed(1)} s, exported 1080x1920 with captions, no silence over 0.4 s, ${l.integrated} LUFS`;
  } finally { await app.close(); }
}
