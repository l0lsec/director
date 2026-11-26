import { assert, tmp, sh } from '../lib.mjs';
import { launchEditor, importFixtures, fillLane, exportAndWait } from '../edit-lib.mjs';

const CASES = [
  { canvas: 'vertical-1080', fixture: 'vertical-1080x1920.mp4', presets: [['reels-30', 1080, 1920, '30/1', 'h264'], ['reels-60', 1080, 1920, '60/1', 'h264']] },
  { canvas: 'landscape-1080', fixture: 'sync-1080p30.mp4', presets: [['youtube-1080', 1920, 1080, '30/1', 'h264'], ['youtube-4k', 3840, 2160, '30/1', 'hevc']] },
  { canvas: 'square-1080', fixture: 'still.png', presets: [['square-1080', 1080, 1080, '30/1', 'h264']] },
];

export default async function () {
  const out = tmp('presets');
  const lines = [];
  for (const c of CASES) {
    const { app, win } = await launchEditor({ preset: c.canvas });
    try {
      const [m] = await importFixtures(win, [c.fixture]);
      await fillLane(win, m, 'camera', 3_000_000, c.fixture.endsWith('.png') ? 3_000_000 : 3_000_000);
      for (const [preset, w, h, fps, codec] of c.presets) {
        const file = `${out}/${preset}.mp4`;
        const job = await exportAndWait(win, preset, file, { loudness: false });
        assert(job.status === 'done', `${preset}: ${job.status} ${job.error ?? ''}`);
        const v = JSON.parse(sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=codec_name,width,height,r_frame_rate,color_primaries,color_transfer,color_space,nb_read_frames:format=duration', '-of', 'json', file]).stdout);
        const s = v.streams[0];
        const dur = Number(v.format.duration);
        const fpsN = Number(fps.split('/')[0]);
        const problems = [];
        if (s.width !== w || s.height !== h) problems.push(`size ${s.width}x${s.height}`);
        if (s.r_frame_rate !== fps) problems.push(`fps ${s.r_frame_rate}`);
        if (s.codec_name !== codec) problems.push(`codec ${s.codec_name}`);
        if (s.color_primaries !== 'bt709' || s.color_transfer !== 'bt709' || s.color_space !== 'bt709') problems.push(`color ${s.color_primaries}/${s.color_transfer}/${s.color_space}`);
        if (Math.abs(Number(s.nb_read_frames) - 3 * fpsN) > 1) problems.push(`frames ${s.nb_read_frames}`);
        if (Math.abs(dur - 3) > 1 / fpsN + 0.03) problems.push(`duration ${dur}`);
        assert(problems.length === 0, `${preset}: ${problems.join(', ')}`);
        lines.push(`${preset} ${s.width}x${s.height} ${s.r_frame_rate} ${s.codec_name} bt709 ${s.nb_read_frames} frames`);
      }
    } finally { await app.close(); }
  }
  return lines.join('; ');
}
