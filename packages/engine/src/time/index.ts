/** All timeline time is integer microseconds. */
export type Micros = number;
export interface Fps { num: number; den: number }

export const SECOND: Micros = 1_000_000;

export function fpsValue(fps: Fps): number { return fps.num / fps.den; }

/** Exact duration of one frame in (fractional) microseconds. */
export function frameDurationExact(fps: Fps): number { return (SECOND * fps.den) / fps.num; }

/** Timeline position of frame index n, rounded to an integer microsecond. */
export function frameToMicros(n: number, fps: Fps): Micros { return Math.round((n * SECOND * fps.den) / fps.num); }

/** Frame index containing time t (floor), robust to rounding at exact boundaries. */
export function microsToFrame(t: Micros, fps: Fps): number {
  // Frame times are rounded to whole microseconds; absorb that rounding (up to 0.5 us).
  return Math.floor((t * fps.num) / (SECOND * fps.den) + 1e-3);
}

/** Snap t to the nearest frame boundary. */
export function snapToFrame(t: Micros, fps: Fps): Micros {
  return frameToMicros(Math.round((t * fps.num) / (SECOND * fps.den)), fps);
}

export function secondsToMicros(s: number): Micros { return Math.round(s * SECOND); }
export function microsToSeconds(t: Micros): number { return t / SECOND; }

/** HH:MM:SS:FF (or MM:SS:FF under an hour). */
export function formatTimecode(t: Micros, fps: Fps): string {
  const rate = Math.round(fpsValue(fps));
  const frame = microsToFrame(Math.max(0, t), fps);
  const ff = frame % rate;
  const totalSec = Math.floor(frame / rate);
  const ss = totalSec % 60;
  const mm = Math.floor(totalSec / 60) % 60;
  const hh = Math.floor(totalSec / 3600);
  const p = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${p(hh)}:${p(mm)}:${p(ss)}:${p(ff)}` : `${p(mm)}:${p(ss)}:${p(ff)}`;
}

/** Short human duration, for example 1:05.3 */
export function formatDuration(t: Micros): string {
  const s = Math.max(0, t) / SECOND;
  const m = Math.floor(s / 60);
  const rest = s - m * 60;
  return `${m}:${rest.toFixed(1).padStart(4, '0')}`;
}

export function clamp(v: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, v)); }

export const COMMON_FPS: Record<string, Fps> = {
  '24': { num: 24, den: 1 },
  '25': { num: 25, den: 1 },
  '29.97': { num: 30000, den: 1001 },
  '30': { num: 30, den: 1 },
  '50': { num: 50, den: 1 },
  '59.94': { num: 60000, den: 1001 },
  '60': { num: 60, den: 1 },
};
