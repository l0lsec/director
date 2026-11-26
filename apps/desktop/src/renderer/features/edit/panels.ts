import type { ComponentType } from 'react';
import type { Panel } from './store';

/** Side panels contributed by later features (transcript, text, audio, effects, captions, director). */
export interface EditPanel { id: Panel; label: string; component: ComponentType; order: number }
const panels: EditPanel[] = [];
export function registerEditPanel(p: EditPanel): void { const i = panels.findIndex((x) => x.id === p.id); if (i >= 0) panels[i] = p; else panels.push(p); panels.sort((a, b) => a.order - b.order); }
export function getEditPanels(): EditPanel[] { return panels; }
