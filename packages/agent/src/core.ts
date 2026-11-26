import { z } from 'zod';
import { applyOps, OpError, ProjectSchema, timelineDuration, type Op, type Project } from '@director/engine';
import type { Template } from '@director/engine';

/** What a tool may do. read: never changes anything. edit: a pure project change (one undo step). act: uses app services. */
export type Access = 'read' | 'edit' | 'act';

export type Group =
  | 'start' | 'read' | 'timeline' | 'clip' | 'effects' | 'text' | 'audio' | 'structure'
  | 'transcript' | 'history' | 'media' | 'render' | 'export' | 'app' | 'library';

export const GROUP_LABELS: Record<Group, string> = {
  start: 'Getting started', read: 'Reading the project', timeline: 'Cutting and arranging', clip: 'Clip properties, motion and speed',
  effects: 'Effects, color and transitions', text: 'Titles, text and captions', audio: 'Audio mixing', structure: 'Lanes, markers, canvas and templates',
  transcript: 'Text-based editing and automation', history: 'Undo and batches', media: 'Media import and processing', render: 'Seeing the edit',
  export: 'Exporting', app: 'App, projects and playback', library: 'Swipe references, scripts and sounds',
};

export class AgentError extends Error {
  public code: string;
  public hint?: string;
  constructor(code: string, message: string, hint?: string) { super(message); this.code = code; this.hint = hint; }
}

export interface ApprovalRequest { tool: string; summary: string; preview: string[]; kind: 'edit' | 'act'; alwaysAsk?: boolean }
export interface Approval { ok: boolean; reason?: string }

/** Templates and file checks that pure edit tools may need from the app. */
export interface PlanEnv {
  templates?: Template[];
  fileExists?: (path: string) => boolean;
}

export interface Plan { ops: Op[]; summary: string; result?: Record<string, unknown>; preview?: string[]; /** Undo label override. */ label?: string }

/** The app (or a test) implements this; tools reach services only through it. */
export interface AgentContext {
  client: string;
  getDoc(): Project | null;
  revision(): number;
  /** Apply ops as one undo step. Returns the new revision, or throws. */
  apply(ops: Op[], label: string): number;
  approve(req: ApprovalRequest): Promise<Approval>;
  env: PlanEnv;
  /** App services for act tools (see services.ts). Tests may omit what they do not use. */
  host: Partial<import('./services').AgentHost>;
}

export interface Example { args: Record<string, unknown>; note?: string }

export interface ToolDef {
  name: string;
  title: string;
  group: Group;
  description: string;
  input: z.ZodObject;
  examples: Example[];
  access: Access;
  /** act tools: true when they change the project or write files (asks in Ask mode). */
  mutates?: boolean;
  /** Removes content (still undoable). */
  destructive?: boolean;
  idempotent?: boolean;
  /** Always wait for the person, even in Auto mode. */
  alwaysAsk?: boolean;
  plan?: (doc: Project, args: never, env: PlanEnv) => Plan;
  run?: (ctx: AgentContext, args: never) => Promise<unknown> | unknown;
}

/** Arguments every edit tool accepts on top of its own. */
export const EDIT_COMMON = {
  dryRun: z.boolean().optional().describe('Preview: return what would change without changing anything'),
  expectRevision: z.number().int().nonnegative().optional().describe('Refuse if the project changed since you read this revision (from any read tool)'),
};

export function defineEdit<S extends z.ZodRawShape>(d: Omit<ToolDef, 'input' | 'access' | 'plan' | 'run'> & { input: S; plan: (doc: Project, args: z.output<z.ZodObject<S>>, env: PlanEnv) => Plan }): ToolDef {
  return { ...d, access: 'edit', input: z.object({ ...d.input, ...EDIT_COMMON }).strict(), plan: d.plan as ToolDef['plan'] };
}

export function defineRead<S extends z.ZodRawShape>(d: Omit<ToolDef, 'input' | 'access' | 'plan' | 'run'> & { input: S; run: (ctx: AgentContext, args: z.output<z.ZodObject<S>>) => unknown }): ToolDef {
  return { ...d, access: 'read', idempotent: true, input: z.object(d.input).strict(), run: d.run as ToolDef['run'] };
}

export function defineAct<S extends z.ZodRawShape>(d: Omit<ToolDef, 'input' | 'access' | 'plan' | 'run'> & { input: S; run: (ctx: AgentContext, args: z.output<z.ZodObject<S>>) => unknown; describe?: (args: z.output<z.ZodObject<S>>) => string }): ToolDef & { describe?: (args: never) => string } {
  return { ...d, access: 'act', input: z.object(d.input).strict(), run: d.run as ToolDef['run'], describe: d.describe as never };
}

export type ToolResponse = { ok: true; data: unknown } | { ok: false; error: { code: string; message: string; hint?: string } };

const ms = (us: number) => Math.round(us / 1000) / 1000;

/** Compact description of what an op list changed, for previews and results. */
export function describeChanges(before: Project, after: Project): Record<string, unknown> {
  const clips = (d: Project) => new Map(d.lanes.flatMap((l) => l.clips.map((c) => [c.id, { c, lane: l.id }] as const)));
  const a = clips(before), b = clips(after);
  const added = [...b.keys()].filter((k) => !a.has(k));
  const removed = [...a.keys()].filter((k) => !b.has(k));
  const changed = [...b.keys()].filter((k) => a.has(k) && (JSON.stringify(a.get(k)!.c) !== JSON.stringify(b.get(k)!.c) || a.get(k)!.lane !== b.get(k)!.lane));
  const out: Record<string, unknown> = {};
  if (added.length) out.clipsAdded = added;
  if (removed.length) out.clipsRemoved = removed;
  if (changed.length) out.clipsChanged = changed;
  const ids = (xs: Array<{ id: string }>) => new Set(xs.map((x) => x.id));
  const la = ids(before.lanes), lb = ids(after.lanes);
  const lanesAdded = [...lb].filter((x) => !la.has(x)), lanesRemoved = [...la].filter((x) => !lb.has(x));
  if (lanesAdded.length) out.lanesAdded = lanesAdded;
  if (lanesRemoved.length) out.lanesRemoved = lanesRemoved;
  const ma = ids(before.markers), mb = ids(after.markers);
  const mAdd = [...mb].filter((x) => !ma.has(x)), mRem = [...ma].filter((x) => !mb.has(x));
  if (mAdd.length) out.markersAdded = mAdd;
  if (mRem.length) out.markersRemoved = mRem;
  const mediaAdded = Object.keys(after.media).filter((k) => !before.media[k]);
  if (mediaAdded.length) out.mediaAdded = mediaAdded;
  const d0 = timelineDuration(before), d1 = timelineDuration(after);
  if (d0 !== d1) { out.durationBefore = ms(d0); out.durationAfter = ms(d1); }
  return out;
}

/** Turn engine and validation errors into messages an agent can act on. */
export function friendly(e: unknown, tool: string): AgentError {
  if (e instanceof AgentError) return e;
  if (e instanceof z.ZodError) {
    const lines = e.issues.slice(0, 8).map((i) => `${i.path.length ? i.path.join('.') : '(arguments)'}: ${i.message}`);
    return new AgentError('INVALID_ARGS', `Invalid arguments for ${tool}: ${lines.join('; ')}`, `Call describe_tool {"name":"${tool}"} for the schema and examples.`);
  }
  if (e instanceof OpError) {
    const hints: Record<string, string> = {
      NOT_FOUND: 'Ids come from get_timeline (clips, lanes, markers) and list_media (media). Read again: ids change when clips are split or re-created.',
      RANGE: 'Check times against the clip with get_clip; times are seconds on the timeline.',
      DUPLICATE: 'Ids must be unique; leave ids out and Director makes them.',
      IN_USE: 'Remove the clips that use it first.',
    };
    return new AgentError(e.code, e.message, hints[e.code]);
  }
  const err = e as Error;
  return new AgentError('FAILED', err?.message ?? String(e), undefined);
}

function validate(doc: Project, ops: Op[]): Project {
  const after = applyOps(doc, ops).doc;
  const p = ProjectSchema.safeParse(after);
  if (!p.success) throw new AgentError('INVALID_RESULT', `The change would make the project invalid: ${p.error.issues.slice(0, 3).map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`, 'Check the values against get_capabilities ranges.');
  return after;
}

export function labelFor(ctx: AgentContext, summary: string): string {
  return `${ctx.client}: ${summary}`.slice(0, 120);
}

/** Plan an edit tool against a doc and validate the result, without applying it. */
export function planEdit(tool: ToolDef, doc: Project, args: unknown, env: PlanEnv): { plan: Plan; after: Project } {
  const plan = tool.plan!(doc, args as never, env);
  const after = plan.ops.length ? validate(doc, plan.ops) : doc;
  return { plan, after };
}

export async function runTool(tools: Map<string, ToolDef>, ctx: AgentContext, name: string, raw: unknown): Promise<ToolResponse> {
  const tool = tools.get(name);
  if (!tool) {
    const near = [...tools.keys()].filter((k) => k.includes(name.split('_')[0] ?? name) || name.includes(k.split('_')[1] ?? '\u0000')).slice(0, 5);
    return { ok: false, error: { code: 'UNKNOWN_TOOL', message: `There is no tool called ${name}.`, hint: near.length ? `Did you mean ${near.join(', ')}? get_started lists every tool by group.` : 'get_started lists every tool by group.' } };
  }
  try {
    const parsed = tool.input.safeParse(raw ?? {});
    if (!parsed.success) throw parsed.error;
    const args = parsed.data as Record<string, unknown>;
    if (tool.access === 'edit') return { ok: true, data: await runEdit(tool, ctx, args) };
    // An action asked as a dry run changes nothing, so it never needs approval.
    if (tool.access === 'act' && tool.mutates && args.dryRun !== true) {
      if (!ctx.getDoc() && !NO_PROJECT_OK.has(tool.name)) throw noProject();
      const describe = (tool as { describe?: (a: unknown) => string }).describe;
      const summary = describe ? describe(args) : tool.title;
      const ok = await ctx.approve({ tool: tool.name, summary, preview: [], kind: 'act' });
      if (!ok.ok) return { ok: true, data: { applied: false, rejected: true, summary, message: ok.reason ?? 'The person declined this action. Nothing changed.' } };
    }
    return { ok: true, data: await tool.run!(ctx, args as never) };
  } catch (e) {
    const err = friendly(e, name);
    return { ok: false, error: { code: err.code, message: err.message, ...(err.hint ? { hint: err.hint } : {}) } };
  }
}

/** Act tools that work with no project open. */
export const NO_PROJECT_OK = new Set(['open_project', 'create_project']);

export function noProject(): AgentError {
  return new AgentError('NO_PROJECT', 'No project is open in Director.', 'Call list_projects then open_project, or create_project {"name": "..."}.');
}

async function runEdit(tool: ToolDef, ctx: AgentContext, args: Record<string, unknown>): Promise<unknown> {
  const doc = ctx.getDoc();
  if (!doc) throw noProject();
  const rev = ctx.revision();
  if (args.expectRevision != null && args.expectRevision !== rev) {
    throw new AgentError('STALE', `The project changed since revision ${args.expectRevision} (it is now ${rev}). Nothing was changed.`, 'Read it again (get_timeline) and redo your plan against the current state, or leave out expectRevision.');
  }
  let { plan, after } = planEdit(tool, doc, args, ctx.env);
  if (!plan.ops.length || JSON.stringify(after) === JSON.stringify(doc)) return { applied: false, summary: plan.ops.length ? 'Already that way; nothing changed' : plan.summary || 'Nothing to change', revision: rev, ...(plan.result ? { result: plan.result } : {}) };
  const changes = describeChanges(doc, after);
  if (args.dryRun) return { applied: false, dryRun: true, summary: plan.summary, changes, ...(plan.result ? { result: plan.result } : {}), revision: rev, note: 'Dry run: nothing changed. Call again without dryRun to apply. Ids in a dry run are not kept.' };
  const decision = await ctx.approve({ tool: tool.name, summary: plan.summary, preview: plan.preview ?? previewLines(changes), kind: 'edit', alwaysAsk: tool.alwaysAsk });
  if (!decision.ok) return { applied: false, rejected: true, summary: plan.summary, message: decision.reason ?? 'The person rejected the proposal. Nothing changed.', revision: ctx.revision() };
  // The person may have edited while deciding: plan again against what is there now.
  const now = ctx.getDoc();
  if (!now) throw noProject();
  let finalChanges = changes;
  if (now !== doc) {
    ({ plan, after } = planEdit(tool, now, args, ctx.env));
    finalChanges = describeChanges(now, after);
    if (!plan.ops.length) return { applied: false, summary: 'Nothing to change any more', revision: ctx.revision() };
  }
  const revision = ctx.apply(plan.ops, plan.label ?? labelFor(ctx, plan.summary));
  const message = tool.alwaysAsk ? `Accepted and applied as one undo step: ${plan.summary.slice(0, 200)}` : 'Applied as one undo step.';
  const warning = overlapWarning(tool.name, finalChanges);
  return { applied: true, message, summary: plan.summary, changes: finalChanges, ...(plan.result ? { result: plan.result } : {}), ...(warning ? { warning } : {}), revision };
}

/** Tools that place something new; if they cut into clips already there, say so (lanes hold one clip at a time). */
const PLACING = new Set(['add_clip', 'add_text', 'add_shape', 'add_placeholder', 'duplicate_clip', 'freeze_frame']);
export function overlapWarning(name: string, changes: Record<string, unknown>): string | undefined {
  if (!PLACING.has(name)) return undefined;
  const hit = [...((changes.clipsChanged as string[] | undefined) ?? []), ...((changes.clipsRemoved as string[] | undefined) ?? [])];
  if (!hit.length) return undefined;
  return `This overlapped ${hit.length} clip(s) already on that lane, which were trimmed, split or replaced: ${hit.slice(0, 8).join(', ')}. A lane holds one clip at a time; to show things at the same time, put them on another lane (add_lane, then pass its id as lane). undo reverts this.`;
}

export function previewLines(changes: Record<string, unknown>): string[] {
  const out: string[] = [];
  const n = (k: string) => (Array.isArray(changes[k]) ? (changes[k] as unknown[]).length : 0);
  if (n('clipsAdded')) out.push(`${n('clipsAdded')} clip(s) added`);
  if (n('clipsRemoved')) out.push(`${n('clipsRemoved')} clip(s) removed`);
  if (n('clipsChanged')) out.push(`${n('clipsChanged')} clip(s) changed`);
  if (n('lanesAdded')) out.push(`${n('lanesAdded')} lane(s) added`);
  if (n('lanesRemoved')) out.push(`${n('lanesRemoved')} lane(s) removed`);
  if (n('markersAdded')) out.push(`${n('markersAdded')} marker(s) added`);
  if (n('markersRemoved')) out.push(`${n('markersRemoved')} marker(s) removed`);
  if (n('mediaAdded')) out.push(`${n('mediaAdded')} media item(s) added`);
  if (changes.durationAfter != null) out.push(`Length ${changes.durationBefore} s to ${changes.durationAfter} s`);
  return out.length ? out : ['Project settings changed'];
}
