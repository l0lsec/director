import type { Fps } from './time';

/**
 * The creative vocabulary of the editor in one place: effects and their parameters, transitions, text
 * animations, blend and fit modes, eases and export presets. The inspector UI, the renderer and the
 * agent tools all read these lists, so what an agent is told exists is exactly what the app can do.
 */

export interface EffectParamDef {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Default value (in the agent/UI unit). Omitted for optional params that are off unless set. */
  def?: number;
  /** 's' params are stored in microseconds relative to the clip start and shown in seconds. */
  unit: 's' | 'x' | 'px' | '';
  description: string;
}

export interface EffectExtraDef {
  key: string;
  kind: 'color' | 'enum' | 'boolean' | 'path';
  values?: string[];
  def?: string | boolean;
  description: string;
}

export interface EffectDef {
  type: string;
  label: string;
  description: string;
  params: EffectParamDef[];
  extras?: EffectExtraDef[];
  /** Effects an agent can add directly (matte is produced by remove_background). */
  addable: boolean;
}

export const EFFECT_DEFS: Record<string, EffectDef> = {
  color: {
    type: 'color', label: 'Color', addable: true,
    description: 'Color correction: exposure, contrast, saturation, warmth, tint and brightness. Stack several for looks.',
    params: [
      { key: 'exposure', label: 'Exposure', min: -2, max: 2, step: 0.05, def: 0, unit: '', description: 'Stops of exposure; +1 doubles the light' },
      { key: 'contrast', label: 'Contrast', min: -1, max: 1, step: 0.02, def: 0, unit: '', description: 'Contrast around mid grey' },
      { key: 'saturation', label: 'Saturation', min: -1, max: 1, step: 0.02, def: 0, unit: '', description: '-1 is black and white' },
      { key: 'temperature', label: 'Warmth', min: -1, max: 1, step: 0.02, def: 0, unit: '', description: 'Negative is cooler (blue), positive warmer (orange)' },
      { key: 'tint', label: 'Tint', min: -1, max: 1, step: 0.02, def: 0, unit: '', description: 'Negative is green, positive magenta' },
      { key: 'brightness', label: 'Brightness', min: -0.5, max: 0.5, step: 0.01, def: 0, unit: '', description: 'Lift or lower the whole image' },
    ],
  },
  lut: {
    type: 'lut', label: 'LUT', addable: true,
    description: 'Apply a .cube color lookup table (a film look or a camera log conversion).',
    params: [{ key: 'strength', label: 'Strength', min: 0, max: 1, step: 0.05, def: 1, unit: '', description: 'Mix between the original and the LUT' }],
    extras: [{ key: 'path', kind: 'path', description: 'Absolute path to an existing .cube file' }],
  },
  blur: {
    type: 'blur', label: 'Blur', addable: true,
    description: 'Gaussian blur of the whole clip.',
    params: [{ key: 'radius', label: 'Radius', min: 0, max: 40, step: 1, def: 10, unit: 'px', description: 'Blur radius in pixels' }],
  },
  vignette: {
    type: 'vignette', label: 'Vignette', addable: true,
    description: 'Darken the edges to pull the eye to the center.',
    params: [{ key: 'amount', label: 'Amount', min: 0, max: 1, step: 0.05, def: 0.5, unit: '', description: 'Strength of the darkening' }],
  },
  zoom: {
    type: 'zoom', label: 'Punch-in zoom', addable: true,
    description: 'A punch-in: eases from 1x to `amount` starting at `at`, over `ramp`; optionally eases back out from `until`.',
    params: [
      { key: 'at', label: 'Starts at (s)', min: 0, max: 600, step: 0.05, def: 0, unit: 's', description: 'Start time in seconds from the clip start' },
      { key: 'amount', label: 'Zoom', min: 1, max: 2, step: 0.01, def: 1.15, unit: 'x', description: 'Final scale factor (1.1 to 1.3 reads as a natural punch-in)' },
      { key: 'ramp', label: 'Ramp (s)', min: 0, max: 2, step: 0.02, def: 0.12, unit: 's', description: 'How long the zoom takes to settle, in seconds' },
      { key: 'until', label: 'Release at (s)', min: 0, max: 600, step: 0.05, unit: 's', description: 'Optional: seconds from the clip start where it eases back to 1x' },
    ],
  },
  shake: {
    type: 'shake', label: 'Shake', addable: true,
    description: 'Camera shake for impact moments.',
    params: [
      { key: 'amount', label: 'Amount', min: 0, max: 60, step: 1, def: 12, unit: 'px', description: 'Shake distance in pixels' },
      { key: 'frequency', label: 'Speed', min: 1, max: 30, step: 0.5, def: 9, unit: '', description: 'Shakes per second' },
    ],
  },
  chromakey: {
    type: 'chromakey', label: 'Chroma key', addable: true,
    description: 'Remove a green (or other) screen color.',
    params: [
      { key: 'similarity', label: 'Similarity', min: 0, max: 1, step: 0.01, def: 0.3, unit: '', description: 'How close a color must be to the key to vanish' },
      { key: 'smoothness', label: 'Smoothness', min: 0, max: 0.5, step: 0.01, def: 0.1, unit: '', description: 'Soft edge width' },
    ],
    extras: [{ key: 'color', kind: 'color', def: '#00ff00', description: 'Key color as #rrggbb' }],
  },
  mask: {
    type: 'mask', label: 'Mask', addable: true,
    description: 'Show only a rectangle or ellipse of the clip (or everything but it, inverted). Coordinates are fractions of the frame.',
    params: [
      { key: 'x', label: 'Left', min: 0, max: 1, step: 0.01, def: 0.1, unit: '', description: 'Left edge as a fraction of the width' },
      { key: 'y', label: 'Top', min: 0, max: 1, step: 0.01, def: 0.1, unit: '', description: 'Top edge as a fraction of the height' },
      { key: 'w', label: 'Width', min: 0, max: 1, step: 0.01, def: 0.8, unit: '', description: 'Width as a fraction of the frame' },
      { key: 'h', label: 'Height', min: 0, max: 1, step: 0.01, def: 0.8, unit: '', description: 'Height as a fraction of the frame' },
      { key: 'feather', label: 'Feather', min: 0, max: 0.5, step: 0.01, def: 0.05, unit: '', description: 'Edge softness' },
    ],
    extras: [
      { key: 'shape', kind: 'enum', values: ['rect', 'ellipse'], def: 'rect', description: 'Mask shape' },
      { key: 'invert', kind: 'boolean', def: false, description: 'Hide the inside instead of the outside' },
    ],
  },
  matte: {
    type: 'matte', label: 'Background removal', addable: false,
    description: 'Person matte made by remove_background; hides everything but the person.',
    params: [],
    extras: [{ key: 'path', kind: 'path', description: 'Matte video made by the app' }],
  },
};

/** Effect params stored in microseconds (shown and accepted in seconds). */
export const EFFECT_TIME_KEYS = new Set(Object.values(EFFECT_DEFS).flatMap((d) => d.params.filter((p) => p.unit === 's').map((p) => p.key)));

export interface NamedOption { id: string; label: string; description: string }

export const TRANSITIONS: NamedOption[] = [
  { id: 'crossfade', label: 'Crossfade', description: 'The incoming clip fades in over the outgoing one' },
  { id: 'dissolve', label: 'Dissolve', description: 'Same as crossfade' },
  { id: 'dip-black', label: 'Dip to black', description: 'Fade down to black, then up into the next clip' },
  { id: 'dip-white', label: 'Dip to white', description: 'Flash to white between clips' },
  { id: 'slide-left', label: 'Slide', description: 'The incoming clip slides in from the right' },
  { id: 'slide-up', label: 'Slide up', description: 'The incoming clip slides up from the bottom' },
  { id: 'zoom', label: 'Zoom', description: 'The incoming clip zooms in from 1.6x while fading in' },
  { id: 'whip', label: 'Whip', description: 'Fast whip pan with motion blur' },
];

export const TEXT_ANIMATIONS: NamedOption[] = [
  { id: 'fade', label: 'Fade', description: 'Fade in or out' },
  { id: 'pop', label: 'Pop', description: 'Scale up with a slight overshoot' },
  { id: 'slide-up', label: 'Slide up', description: 'Rise into place' },
  { id: 'slide-left', label: 'Slide left', description: 'Slide in from the right' },
  { id: 'zoom', label: 'Zoom', description: 'Shrink from 1.4x into place' },
  { id: 'typewriter', label: 'Typewriter', description: 'Reveal letter by letter' },
];

export const BLEND_MODES = ['normal', 'screen', 'multiply', 'overlay', 'add'] as const;
export const FIT_MODES = ['cover', 'contain', 'stretch'] as const;
export const EASES = ['linear', 'ease', 'easeIn', 'easeOut', 'hold'] as const;

export interface ExportPreset { label: string; width: number; height: number; fps: Fps; videoBitrate: number; codec: 'avc' | 'hevc'; platform: string }

export const EXPORT_PRESETS: Record<string, ExportPreset> = {
  'reels-30': { label: 'Reels / TikTok / Shorts 1080x1920 30 fps', width: 1080, height: 1920, fps: { num: 30, den: 1 }, videoBitrate: 16_000_000, codec: 'avc', platform: 'vertical' },
  'reels-60': { label: 'Reels / TikTok / Shorts 1080x1920 60 fps', width: 1080, height: 1920, fps: { num: 60, den: 1 }, videoBitrate: 24_000_000, codec: 'avc', platform: 'vertical' },
  'youtube-1080': { label: 'YouTube 1920x1080 30 fps', width: 1920, height: 1080, fps: { num: 30, den: 1 }, videoBitrate: 16_000_000, codec: 'avc', platform: 'landscape' },
  'youtube-4k': { label: 'YouTube 3840x2160 30 fps (HEVC)', width: 3840, height: 2160, fps: { num: 30, den: 1 }, videoBitrate: 45_000_000, codec: 'hevc', platform: 'landscape' },
  'square-1080': { label: 'Square 1080x1080 30 fps', width: 1080, height: 1080, fps: { num: 30, den: 1 }, videoBitrate: 12_000_000, codec: 'avc', platform: 'square' },
};

/** Default parameter values for a new effect of this type, in storage units (time params in microseconds). */
export function effectDefaults(type: string): Record<string, number | string | boolean> {
  const def = EFFECT_DEFS[type];
  if (!def) return {};
  const out: Record<string, number | string | boolean> = {};
  for (const p of def.params) if (p.def !== undefined) out[p.key] = p.unit === 's' ? Math.round(p.def * 1e6) : p.def;
  for (const x of def.extras ?? []) if (x.def !== undefined) out[x.key] = x.def;
  return out;
}

/**
 * Frame rate to export at: the preset's, except when the project runs at that rate's NTSC twin (29.97 for 30,
 * 59.94 for 60, 23.976 for 24); then the project's exact rate, so no frame is duplicated or dropped.
 */
export function exportFps(presetFps: { num: number; den: number }, canvasFps: { num: number; den: number }): { num: number; den: number } {
  const p = presetFps.num / presetFps.den, c = canvasFps.num / canvasFps.den;
  return Math.abs(p - c) < 0.1 ? { num: canvasFps.num, den: canvasFps.den } : presetFps;
}
