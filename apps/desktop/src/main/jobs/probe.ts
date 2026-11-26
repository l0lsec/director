import { runJobOk } from './runner';
import { requireSidecar } from './sidecars';

export interface Rational { num: number; den: number }

export interface ProbeVideo {
  index: number;
  codec: string;
  profile?: string;
  width: number;
  height: number;
  /** Display size after rotation metadata. */
  displayWidth: number;
  displayHeight: number;
  fps: Rational;
  frames: number | null;
  rotation: number;
  pixFmt: string | null;
  colorPrimaries: string | null;
  colorTransfer: string | null;
  colorSpace: string | null;
  bitRate: number | null;
  durationUs: number | null;
}

export interface ProbeAudio { index: number; codec: string; sampleRate: number; channels: number; bitRate: number | null; durationUs: number | null }

export interface ProbeResult {
  path: string;
  container: string;
  durationUs: number;
  sizeBytes: number;
  video: ProbeVideo | null;
  audio: ProbeAudio | null;
  kind: 'video' | 'audio' | 'image';
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

export function parseRational(s: string | undefined): Rational {
  if (!s) return { num: 0, den: 1 };
  const [a, b] = s.split('/').map(Number);
  if (!a || !b) return { num: 0, den: 1 };
  return { num: a, den: b };
}

const IMAGE_CODECS = new Set(['png', 'mjpeg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff', 'heic']);

export function parseProbe(path: string, json: any): ProbeResult {
  const streams: any[] = json.streams ?? [];
  const fmt = json.format ?? {};
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition?.attached_pic));
  const a = streams.find((s) => s.codec_type === 'audio');
  let video: ProbeVideo | null = null;
  if (v) {
    let rotation = 0;
    for (const sd of v.side_data_list ?? []) if (typeof sd.rotation === 'number') rotation = sd.rotation;
    if (v.tags?.rotate) rotation = -Number(v.tags.rotate);
    rotation = ((Math.round(rotation) % 360) + 360) % 360;
    const swap = rotation === 90 || rotation === 270;
    const fps = parseRational(v.avg_frame_rate && v.avg_frame_rate !== '0/0' ? v.avg_frame_rate : v.r_frame_rate);
    const vd = num(v.duration);
    video = {
      index: v.index,
      codec: v.codec_name,
      profile: v.profile,
      width: v.width,
      height: v.height,
      displayWidth: swap ? v.height : v.width,
      displayHeight: swap ? v.width : v.height,
      fps,
      frames: num(v.nb_frames),
      rotation,
      pixFmt: v.pix_fmt ?? null,
      colorPrimaries: v.color_primaries ?? null,
      colorTransfer: v.color_transfer ?? null,
      colorSpace: v.color_space ?? null,
      bitRate: num(v.bit_rate),
      durationUs: vd == null ? null : Math.round(vd * 1e6),
    };
  }
  const audio: ProbeAudio | null = a
    ? { index: a.index, codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels, bitRate: num(a.bit_rate), durationUs: num(a.duration) == null ? null : Math.round(num(a.duration)! * 1e6) }
    : null;
  const isImage = !!video && IMAGE_CODECS.has(video.codec) && (video.frames == null || video.frames <= 1) && !audio;
  const dur = num(fmt.duration) ?? video?.durationUs ?? audio?.durationUs ?? 0;
  return {
    path,
    container: fmt.format_name ?? 'unknown',
    durationUs: isImage ? 0 : Math.round((num(fmt.duration) ?? 0) * 1e6) || (typeof dur === 'number' ? dur : 0),
    sizeBytes: num(fmt.size) ?? 0,
    video,
    audio,
    kind: isImage ? 'image' : video ? 'video' : 'audio',
  };
}

export async function probeMedia(path: string): Promise<ProbeResult> {
  const res = await runJobOk({
    kind: 'probe',
    cmd: requireSidecar('ffprobe'),
    args: ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path],
  });
  return parseProbe(path, JSON.parse(res.stdout));
}
