import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { assert, ffprobe } from '../lib.mjs';
import { agentSession, must, tool } from '../agent-lib.mjs';

async function waitJob(client, job, until = ['done', 'error', 'cancelled'], timeoutMs = 600_000) {
  const t0 = Date.now();
  const seen = new Set();
  for (;;) {
    const st = (await must(client, 'get_export_status', { job })).jobs[0];
    seen.add(st.status);
    if (until.includes(st.status)) return { ...st, seen: [...seen] };
    assert(Date.now() - t0 < timeoutMs, `export ${job} stuck at ${st.status} ${st.progress}`);
    await new Promise((r) => setTimeout(r, 300));
  }
}

export default async function () {
  const s = await agentSession({ mode: 'auto' });
  const { client } = s;
  try {
    // A 6 s piece of the talking-head edit as a Reels file.
    const ex = await must(client, 'export_video', { preset: 'reels-30', fileName: 'agent-cut.mp4', from: 2, to: 8 });
    assert(ex.job && ex.file === 'agent-cut.mp4' && ex.status === 'queued', `export_video ${JSON.stringify(ex)}`);
    const done = await waitJob(client, ex.job);
    assert(done.status === 'done' && done.file === 'agent-cut.mp4' && done.result?.sizeBytes > 50_000, `job ${JSON.stringify(done).slice(0, 300)}`);
    assert(done.seen.some((x) => x !== 'done'), 'status was never seen in progress');
    const file = join(s.exportDir, 'agent-cut.mp4');
    const p = ffprobe(file);
    const v = p.streams.find((x) => x.codec_type === 'video'), a = p.streams.find((x) => x.codec_type === 'audio');
    const dur = Number(v.duration);
    const fileDur = Number(p.format.duration);
    assert(v.width === 1080 && v.height === 1920 && v.r_frame_rate === '30/1' && a && Math.abs(dur - 6) < 0.04 && Math.abs(fileDur - 6) < 0.15, `probe ${v.width}x${v.height} ${v.r_frame_rate} audio ${!!a} video ${dur} s file ${fileDur} s`);
    const loud = done.result.loudness;
    assert(loud && Math.abs(loud.integrated + 14) < 1.5 && loud.truePeak <= -0.5, `loudness ${JSON.stringify(loud)}`);
    // Subtitles: one cue per caption.
    const caps = await must(client, 'generate_captions', { style: 'boxed' });
    const sub = await must(client, 'export_subtitles', { format: 'srt' });
    const srt = readFileSync(join(s.exportDir, sub.file), 'utf8');
    const cues = (srt.match(/-->/g) ?? []).length;
    assert(cues === caps.result.captions && sub.cues === cues && /^1\n00:00:0\d,\d{3} --> /.test(srt), `srt cues ${cues} vs captions ${caps.result.captions}`);
    // Outside the export folder: refused, nothing written.
    const files0 = readdirSync(s.exportDir).sort().join();
    const bad = await tool(client, 'export_video', { fileName: '../../agent.mp4' });
    assert(bad.error && /plain file name/.test(bad.error) && readdirSync(s.exportDir).sort().join() === files0, 'escape not refused');
    // Cancel: a whole-timeline export stopped part way leaves no file behind.
    const big = await must(client, 'export_video', { preset: 'reels-60', fileName: 'cancelled.mp4' });
    await waitJob(client, big.job, ['rendering', 'done', 'error', 'cancelled']);
    const c = await must(client, 'cancel_export', { job: big.job });
    const end = await waitJob(client, big.job);
    assert(c.cancelled && end.status === 'cancelled', `cancel: ${JSON.stringify(c)} ${end.status}`);
    await new Promise((r) => setTimeout(r, 500));
    assert(!existsSync(join(s.exportDir, 'cancelled.mp4')) && !readdirSync(s.exportDir).some((f) => f.includes('partial')), `cancelled export left files: ${readdirSync(s.exportDir)}`);
    return `export_video made a 1080x1920 30 fps MP4 (video ${dur.toFixed(3)} s for a 6 s range) with audio at ${loud.integrated.toFixed(1)} LUFS (statuses seen: ${done.seen.join(' > ')}); export_subtitles wrote ${cues} SRT cues for ${caps.result.captions} captions; a path outside the export folder was refused; a cancelled export left no file`;
  } finally { await s.close(); }
}
