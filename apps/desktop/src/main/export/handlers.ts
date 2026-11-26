import { app } from 'electron';
import { closeSync, existsSync, mkdirSync, openSync, renameSync, rmSync, writeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runJobOk } from '../jobs/runner';
import { requireSidecar } from '../jobs/sidecars';
import { probeMedia } from '../jobs/probe';
import { getSetting, setSetting } from '../settings';

interface OpenExport { fd: number; tmp: string; final: string; bytes: number }
const open = new Map<string, OpenExport>();

export interface LoudnessReport { integrated: number; truePeak: number; lra: number }
export interface ExportRecord { id: string; path: string; preset: string; projectName: string; at: string; seconds: number; sizeBytes: number; loudness: LoudnessReport | null; codec: string; width: number; height: number }

export function defaultExportDir(): string {
  const d = process.env.DIRECTOR_EXPORT_DIR ?? join(app.getPath('videos'), 'Director Exports');
  mkdirSync(d, { recursive: true });
  return d;
}

/** EBU R128 integrated loudness and true peak, measured by ffmpeg. */
export async function measureLoudness(path: string): Promise<LoudnessReport | null> {
  const res = await runJobOk({ kind: 'ebur128', cmd: requireSidecar('ffmpeg'), args: ['-hide_banner', '-nostats', '-i', path, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'] }).catch(() => null);
  if (!res) return null;
  const txt = res.stderr;
  const summary = txt.slice(txt.lastIndexOf('Summary:'));
  const i = /I:\s+(-?[\d.]+|-inf)\s+LUFS/.exec(summary);
  const tp = /Peak:\s+(-?[\d.]+|-inf)\s+dBFS/.exec(summary);
  const lra = /LRA:\s+(-?[\d.]+)\s+LU/.exec(summary);
  if (!i) return null;
  const n = (m: RegExpExecArray | null) => (m && m[1] !== '-inf' ? Number(m[1]) : -Infinity);
  return { integrated: n(i), truePeak: n(tp), lra: lra ? Number(lra[1]) : 0 };
}

/**
 * Finishing pass: two-pass EBU R128 normalization (target I, true-peak ceiling), BT.709 color tags,
 * and fast start. Video is stream-copied (no re-encode).
 */
export async function finish(tmp: string, final: string, opts: { codec: 'avc' | 'hevc'; targetI: number | null; truePeak: number; audioBitrate: number }): Promise<void> {
  const ffmpeg = requireSidecar('ffmpeg');
  const probe = await probeMedia(tmp);
  const bsf = opts.codec === 'hevc' ? 'hevc_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1' : 'h264_metadata=colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1';
  const videoArgs = ['-c:v', 'copy', '-bsf:v', bsf, '-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
  const out = `${final}.finishing.mp4`;
  // AAC encoding adds inter-sample overshoot after the limiter, so limit 1 dB below the requested ceiling.
  const limitTP = opts.truePeak - 1;
  let audioArgs: string[] = ['-c:a', 'copy'];
  if (probe.audio && opts.targetI != null) {
    const first = await runJobOk({ kind: 'loudnorm-measure', cmd: ffmpeg, args: ['-hide_banner', '-nostats', '-i', tmp, '-vn', '-af', `loudnorm=I=${opts.targetI}:TP=${limitTP}:LRA=11:print_format=json`, '-f', 'null', '-'] });
    const json = JSON.parse(first.stderr.slice(first.stderr.lastIndexOf('{'), first.stderr.lastIndexOf('}') + 1)) as Record<string, string>;
    const inputI = Number(json.input_i);
    if (Number.isFinite(inputI) && inputI > -60) {
      const filter = `loudnorm=I=${opts.targetI}:TP=${limitTP}:LRA=11:measured_I=${json.input_i}:measured_TP=${json.input_tp}:measured_LRA=${json.input_lra}:measured_thresh=${json.input_thresh}:offset=${json.target_offset}:linear=true:print_format=summary`;
      audioArgs = ['-af', `${filter},aresample=48000`, '-c:a', 'aac', '-b:a', String(opts.audioBitrate), '-ar', '48000'];
    }
  }
  await runJobOk({ kind: 'export-finish', cmd: ffmpeg, args: ['-v', 'error', '-y', '-i', tmp, '-map', '0', ...videoArgs, ...audioArgs, '-movflags', '+faststart', out] });
  // If the linear pass could not reach the target without clipping, a second dynamic pass fixes it.
  if (probe.audio && opts.targetI != null) {
    const m = await measureLoudness(out);
    if (m && Number.isFinite(m.integrated) && m.integrated > -60 && (Math.abs(m.integrated - opts.targetI) > 0.8 || m.truePeak > opts.truePeak + 0.05)) {
      const fixed = `${final}.finishing2.mp4`;
      await runJobOk({ kind: 'export-finish-dynamic', cmd: ffmpeg, args: ['-v', 'error', '-y', '-i', out, '-map', '0', '-c:v', 'copy', '-af', `loudnorm=I=${opts.targetI}:TP=${limitTP - 0.5}:LRA=11,aresample=48000`, '-c:a', 'aac', '-b:a', String(opts.audioBitrate), '-ar', '48000', '-movflags', '+faststart', fixed] });
      renameSync(fixed, out);
    }
  }
  renameSync(out, final);
}

export const exportHandlers = {
  'export:defaultDir': () => defaultExportDir(),
  'export:begin': (i: { path: string }) => {
    mkdirSync(dirname(i.path), { recursive: true });
    const id = randomUUID();
    const tmp = `${i.path}.partial-${id.slice(0, 6)}.mp4`;
    open.set(id, { fd: openSync(tmp, 'w'), tmp, final: i.path, bytes: 0 });
    return { id, tmp };
  },
  'export:write': (i: { id: string; position: number; data: Uint8Array }) => {
    const e = open.get(i.id);
    if (!e) throw Object.assign(new Error('export not open'), { code: 'NOT_FOUND' });
    writeSync(e.fd, i.data, 0, i.data.byteLength, i.position);
    e.bytes += i.data.byteLength;
    return e.bytes;
  },
  'export:finish': async (i: { id: string; codec: 'avc' | 'hevc'; targetI: number | null; truePeak: number; audioBitrate: number; record: Omit<ExportRecord, 'id' | 'path' | 'at' | 'sizeBytes' | 'loudness'> }) => {
    const e = open.get(i.id);
    if (!e) throw Object.assign(new Error('export not open'), { code: 'NOT_FOUND' });
    closeSync(e.fd);
    open.delete(i.id);
    try {
      await finish(e.tmp, e.final, { codec: i.codec, targetI: i.targetI, truePeak: i.truePeak, audioBitrate: i.audioBitrate });
    } finally {
      if (existsSync(e.tmp)) rmSync(e.tmp, { force: true });
    }
    const loudness = await measureLoudness(e.final);
    const rec: ExportRecord = { ...i.record, id: i.id, path: e.final, at: new Date().toISOString(), sizeBytes: statSync(e.final).size, loudness };
    const hist = getSetting<ExportRecord[]>('export.history', []);
    setSetting('export.history', [rec, ...hist].slice(0, 100));
    return rec;
  },
  'export:cancel': (i: { id: string }) => {
    const e = open.get(i.id);
    if (!e) return false;
    try { closeSync(e.fd); } catch { /* already closed */ }
    rmSync(e.tmp, { force: true });
    open.delete(i.id);
    return true;
  },
  'export:history': () => getSetting<ExportRecord[]>('export.history', []).filter((r) => existsSync(r.path)),
  'export:loudness': (i: { path: string }) => measureLoudness(i.path),
};
