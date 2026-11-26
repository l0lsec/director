import { z } from 'zod';
import { runTool as run, GROUP_LABELS, type AgentContext, type ToolDef, type ToolResponse } from './core';
import { timelineTools } from './tools/timeline';
import { clipTools } from './tools/clip';
import { effectTools } from './tools/effects';
import { textTools } from './tools/text';
import { audioTools, structureTools } from './tools/structure';
import { transcriptTools } from './tools/transcript';
import { readTools } from './tools/read';
import { appTools } from './tools/app';

export * from './core';
export type { AgentHost } from './services';
export { capabilities } from './tools/read';
export { planMakeReel, type MakeReelReport } from './makereel';
export { findPhrase } from './tools/transcript';

let catalog: Map<string, ToolDef> | null = null;

/** Every agent tool, by name, in a stable order (reading first, then editing, then app services). */
export function tools(): Map<string, ToolDef> {
  if (catalog) return catalog;
  const get = () => catalog!;
  const list: ToolDef[] = [
    ...readTools(get), ...timelineTools, ...clipTools, ...effectTools, ...textTools, ...audioTools,
    ...structureTools, ...transcriptTools(get), ...appTools(),
  ];
  catalog = new Map();
  for (const t of list) {
    if (catalog.has(t.name)) throw new Error(`duplicate agent tool ${t.name}`);
    catalog.set(t.name, t);
  }
  return catalog;
}

export function callTool(ctx: AgentContext, name: string, args: unknown): Promise<ToolResponse> {
  return run(tools(), ctx, name, args);
}

export interface ToolManifestEntry { name: string; title: string; group: string; description: string; inputSchema: Record<string, unknown>; annotations: { title: string; readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean; openWorldHint: boolean } }

export function annotations(t: ToolDef): ToolManifestEntry['annotations'] {
  const readOnly = t.access === 'read' || (t.access === 'act' && !t.mutates);
  return { title: t.title, readOnlyHint: readOnly && t.access === 'read', destructiveHint: !!t.destructive, idempotentHint: !!t.idempotent || t.access === 'read', openWorldHint: false };
}

/** Help for common argument names, added to schemas where a tool did not describe the argument itself. */
const ARG_HELP: Record<string, string> = {
  clip: 'Clip id (from get_timeline)', clips: 'Clip ids (from get_timeline)', media: 'Media id or exact name (from list_media)', lane: 'Lane id, or a lane kind such as camera, broll, titles, music',
  lanes: 'Lane ids or kinds', at: 'Timeline time in seconds', start: 'Timeline start in seconds', duration: 'Length in seconds', from: 'Start of the range, timeline seconds',
  to: 'End of the range, timeline seconds', by: 'Seconds to move by (negative is earlier)', t: 'Timeline time in seconds', edge: 'Which edge of the clip', ripple: 'Move later clips to close or open the space (default true)',
  insert: 'Push later clips to make room instead of overwriting', text: 'The words', label: 'Shown to the person', marker: 'Marker id (from get_timeline)', markers: 'Marker ids (from get_timeline)',
  index: 'Position from the top, 0 is first', effect: 'Effect id (from get_clip) or its type', params: 'Parameters by name; get_capabilities lists each with its range. Time parameters are seconds from the clip start',
  keyframes: 'Keyframes: time in seconds, value, and the ease into the next one', property: 'What to animate', layout: 'Layout preset', rate: 'Speed multiplier (2 is twice as fast, 0.5 half speed)',
  ramp: 'Speed ramp preset', points: 'Custom ramp: the rate at positions 0 to 1 along the clip', steps: 'Edit tool calls to run in order: { tool, args }', ops: 'Primitive ops as in the project file (times in microseconds)',
  summary: 'What this change does, shown to the person', format: 'File format', fileName: 'A plain file name; written to the export folder', width: 'Width in pixels', job: 'Export job id (from export_video)',
  take: 'Take id or title (from list_takes)', template: 'Template id or name (from list_templates)', texts: 'Text for each text slot, in order', paths: 'Absolute file or folder paths on this Mac',
  role: 'What the media is; decides its natural lane', id: 'Id from the matching list tool', version: 'Version number (default: the current one)', query: 'Search text', topic: 'Narrow to one topic',
  detail: '"summary" (default) or "full" (every clip property)', count: 'How many frames', columns: 'Grid columns', preset: 'Preset name', enabled: 'On (true) or off (false)', force: 'Do it even though it removes content',
  workspace: 'Which workspace to show', name: 'Name', kind: 'Kind', type: 'Type', link: 'true links, false unlinks', mode: 'Mode', occurrence: 'Which match (1 is the first) or "all"', first: 'First word index (from get_transcript)',
  last: 'Last word index, inclusive', indices: 'Word indices (from get_transcript)', minPause: 'Seconds; pauses longer than this are shortened', keep: 'Seconds of air kept each side of a cut', fillers: 'true (default list), false, or your own filler words',
  trimEnds: 'Also trim silence before the first and after the last word', style: 'Style preset', position: 'Vertical center as a fraction of the frame height', maxWords: 'Most words per caption card', maxChars: 'Most characters per caption card',
  volume: 'Gain in dB (0 unchanged, -6 half as loud)', pan: '-1 left to 1 right', fadeIn: 'Fade-in length in seconds', fadeOut: 'Fade-out length in seconds', muted: 'Silence it', duckUnderVoice: 'Dip automatically under speech',
  sourceIn: 'Seconds into the file where the clip starts', sourceOut: 'Seconds into the file where the clip ends', x: 'Pixels from the frame center, + is right', y: 'Pixels from the frame center, + is down',
  scale: '1 fills the frame (per fit)', rotation: 'Degrees', opacity: '0 transparent to 1 opaque', crop: 'Fraction cut from each side', flipH: 'Mirror left to right', flipV: 'Mirror top to bottom', fit: 'How media fills the frame',
  blend: 'Blend mode', reverse: 'Play backwards', color: 'A color like #ffcc00', size: 'Size', radius: 'Corner radius in pixels', shape: 'Shape', smoothing: 'Smoothing strength 1 to 100', denoise: 'Remove background noise', enhance: 'EQ and compress the voice',
  includePaths: 'Also return file paths on this Mac', tag: 'Only references with this tag', referenceId: 'Swipe reference id (from list_references)', actions: 'High-level actions: cut, zoom, broll, text, marker (seconds)',
  timeBase: '"timeline" (default): keyframe times are timeline seconds; "clip": seconds from the clip start', preservePitch: 'Keep voices at their natural pitch', includeTimed: 'Also copy time-based effects such as zoom',
  weight: 'Font weight 100 to 1000 (900 is black)', align: 'Text alignment', uppercase: 'Show in capitals', shadow: 'Drop shadow; null removes it', lineHeight: 'Line spacing (1 is tight)',
  animationIn: 'Entrance animation, or "none"', animationOut: 'Exit animation, or "none"', solo: 'Hear only soloed lanes', hidden: 'Hide its picture', locked: 'Protect it from edits',
  height: 'Height in pixels (even)', fps: 'Frame rate', background: 'A color, or "blur" to fill empty space with a blurred copy of the video', blurAmount: 'Blur strength 0 to 1',
  snapping: 'Snap edits to clip edges and markers in the app', rippleByDefault: 'Whether the person\'s own deletes close gaps', safeZone: 'Platform interface area captions avoid',
  captionStyle: 'Caption style preset', model: 'Transcription model id (default: the best installed)', project: 'Project folder (from list_projects) or exact name',
  left: 'Clip on the left of the edit point', right: 'Clip on the right of the edit point', clipsFrom: 'Source clip', normalizeLoudness: 'Set -14 LUFS for social platforms (default true)',
};

export function jsonSchema(t: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(t.input, { io: 'input', unrepresentable: 'any' }) as { $schema?: string; properties?: Record<string, { description?: string; maximum?: number }> };
  delete s.$schema;
  for (const [k, p] of Object.entries(s.properties ?? {})) {
    if (!p.description && ARG_HELP[k]) p.description = ARG_HELP[k];
    if (p.maximum != null && p.maximum >= Number.MAX_SAFE_INTEGER) delete p.maximum;
    if ((p as { minimum?: number }).minimum != null && (p as { minimum: number }).minimum <= Number.MIN_SAFE_INTEGER) delete (p as { minimum?: number }).minimum;
  }
  return s as Record<string, unknown>;
}

/** The catalog as tool definitions for MCP, the Anthropic Messages API or OpenAI-style function calling. */
export function manifest(format: 'mcp' | 'anthropic' | 'openai' = 'mcp'): unknown[] {
  return [...tools().values()].map((t) => {
    const schema = jsonSchema(t);
    const description = `${t.description}${t.access === 'edit' ? ' Accepts dryRun and expectRevision.' : ''}`;
    if (format === 'anthropic') return { name: t.name, description, input_schema: schema };
    if (format === 'openai') return { type: 'function', function: { name: t.name, description: description.slice(0, 1024), parameters: schema } };
    return { name: t.name, title: t.title, group: GROUP_LABELS[t.group], description, inputSchema: schema, annotations: annotations(t) };
  });
}
