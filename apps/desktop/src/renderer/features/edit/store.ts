import { create } from 'zustand';
import type { LaneKind } from '@director/engine';

export type Tool = 'select' | 'blade' | 'slip' | 'roll';
export type Panel = 'media' | 'files' | 'transcript' | 'text' | 'audio' | 'effects' | 'captions' | 'director' | 'assistant' | 'agent';

interface EditState {
  t: number;
  playing: boolean;
  selection: string[];
  zoom: number; // pixels per second
  scrollX: number;
  tool: Tool;
  snapping: boolean;
  ripple: boolean;
  panel: Panel;
  mode: 'video' | 'gfx';
  previewScale: number;
  loop: boolean;
  dragOverLane: LaneKind | null;
  inPoint: number | null;
  outPoint: number | null;
}

export const useEdit = create<EditState>(() => ({
  t: 0,
  playing: false,
  selection: [],
  zoom: 80,
  scrollX: 0,
  tool: 'select',
  snapping: true,
  ripple: true,
  panel: 'media',
  mode: 'video',
  previewScale: 0.5,
  loop: false,
  dragOverLane: null,
  inPoint: null,
  outPoint: null,
}));

export const setEdit = useEdit.setState;
export const getEdit = useEdit.getState;
