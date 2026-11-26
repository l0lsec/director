import type { ReactNode } from 'react';
import type { Clip } from '@director/engine';

/** Later milestones (effects, transitions, captions, audio tools) plug extra inspector sections in here. */
export interface EditExtensions {
  speed?: (clip: Clip) => ReactNode;
  audio?: (clip: Clip) => ReactNode;
  effects?: (clip: Clip) => ReactNode;
  transitions?: (clip: Clip) => ReactNode;
  text?: (clip: Clip) => ReactNode;
  video?: (clip: Clip) => ReactNode;
}
const ext: EditExtensions = {};
export function registerEditExtensions(e: EditExtensions): void { Object.assign(ext, e); }
export function getEditExtensions(): EditExtensions { return ext; }
