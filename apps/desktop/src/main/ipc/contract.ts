import { z } from 'zod';
import type { ProbeResult } from '../jobs/probe';
import type { ExportRecord, LoudnessReport } from '../export/handlers';
import type { Transcript } from '../transcribe/transcribe';
import type { ModelInfo } from '../transcribe/models';
import { OpSchema, TakeSchema, TakeMarkerSchema, MediaRefSchema, type Project, type Take, type MediaRef } from '@director/engine';
import type { ImportResult } from '@director/library';
import type { Structure, Draft, HookIdea, VoiceCheck, ReleaseCopy, DirectorAction, ActionProblem, PreviewItem, ActionType } from '@director/ai';
import type { UsageSummary } from '@director/library';
import type { RefAnalysis } from '../library/handlers';
import type { McpStatus } from '../mcp/server';

/** Phantom-typed channel definition: zod validates input, TypeScript carries the output type. */
export const ch = <O>() => <I extends z.ZodType>(input: I) => ({ input, __out: null as unknown as O });

const Empty = z.object({}).strict().optional();
const Path = z.string().min(1).max(4096);
const Id = z.string().min(1).max(64);

export interface AppInfo { version: string; platform: string; arch: string; sidecars: Record<string, string | null>; userData: string; repoRoot: string | null }
export interface NativeDevice { id: string; name: string; kind: 'video' | 'audio'; manufacturer?: string; modelId?: string; isContinuity?: boolean; formats?: Array<{ width: number; height: number; maxFps: number; minFps: number }> }

export const channels = {
  'app:info': ch<AppInfo>()(Empty),
  'media:probe': ch<ProbeResult>()(z.object({ path: Path }).strict()),
  'job:cancel': ch<boolean>()(z.object({ id: z.string().uuid() }).strict()),
  'dialog:open': ch<string[]>()(
    z.object({
      title: z.string().max(200).optional(),
      multi: z.boolean().optional(),
      directory: z.boolean().optional(),
      filters: z.array(z.object({ name: z.string().max(100), extensions: z.array(z.string().max(16)).max(50) })).max(20).optional(),
    }).strict(),
  ),
  'dialog:save': ch<string | null>()(
    z.object({ title: z.string().max(200).optional(), defaultPath: z.string().max(4096).optional(), filters: z.array(z.object({ name: z.string(), extensions: z.array(z.string()) })).optional() }).strict(),
  ),
  'native:version': ch<{ name: string; version: string; protocol: number; macos: string }>()(Empty),
  'native:devices': ch<NativeDevice[]>()(Empty),
  'shell:reveal': ch<boolean>()(z.object({ path: Path }).strict()),
  'project:create': ch<OpenedProject>()(z.object({ name: z.string().min(1).max(200), preset: z.string().max(40).optional(), fps: z.string().max(10).optional(), parentDir: Path.optional() }).strict()),
  'project:open': ch<OpenedProject>()(z.object({ dir: Path }).strict()),
  'project:journal': ch<number>()(z.object({ projectId: z.string().min(1).max(64), seq: z.number().int().positive(), ops: z.array(OpSchema).min(1).max(5000) }).strict()),
  'project:save': ch<{ seq: number }>()(z.object({ projectId: z.string().min(1).max(64) }).strict()),
  'project:close': ch<boolean>()(z.object({ projectId: z.string().min(1).max(64) }).strict()),
  'project:list': ch<Array<{ dir: string; name: string; updatedAt: string }>>()(Empty),
  'project:dir': ch<string>()(z.object({ projectId: z.string().min(1).max(64) }).strict()),
  'take:begin': ch<{ takeId: string; dir: string; camera: string }>()(z.object({
    title: z.string().min(1).max(200), projectDir: Path.optional(), projectId: z.string().max(64).optional(),
    script: TakeSchema.shape.script, devices: TakeSchema.shape.devices, mimeType: z.string().max(120), videoBitsPerSecond: z.number().int().nonnegative(),
  }).strict()),
  'take:chunk': ch<number>()(z.object({ takeId: z.string().max(64), stream: z.enum(['camera', 'mic']), data: z.instanceof(Uint8Array) }).strict()),
  'take:end': ch<{ take: Take; dir: string }>()(z.object({ takeId: z.string().max(64), patch: TakeSchema.partial() }).strict()),
  'take:list': ch<Array<{ take: Take; dir: string }>>()(z.object({ projectDir: Path.optional(), includeTrashed: z.boolean().optional() }).strict()),
  'take:get': ch<{ take: Take; dir: string } | null>()(z.object({ dir: Path }).strict()),
  'take:update': ch<Take>()(z.object({ dir: Path, patch: z.object({ title: z.string().max(200).optional(), rating: z.number().int().min(0).max(5).optional(), notes: z.string().max(4000).optional(), status: z.enum(['ok', 'trashed']).optional(), markers: z.array(TakeMarkerSchema).optional() }).strict() }).strict()),
  'takes:root': ch<string>()(z.object({ projectDir: Path.optional() }).strict()),
  'screen:sources': ch<Array<Record<string, unknown>>>()(Empty),
  'screen:start': ch<{ excludedWindow: number | null }>()(z.object({ takeId: z.string().max(64), displayId: z.number().int().optional(), excludePrompter: z.boolean().optional(), fps: z.number().int().min(1).max(120).optional() }).strict()),
  'follow:start': ch<boolean>()(Empty),
  'follow:audio': ch<boolean>()(z.object({ data: z.instanceof(Uint8Array) }).strict()),
  'follow:stop': ch<boolean>()(Empty),
  'prompter:open': ch<{ windowId: number | null; mode: string }>()(z.object({ mode: z.enum(['overlay', 'display', 'glass']), displayId: z.number().int().optional() }).strict()),
  'prompter:close': ch<boolean>()(Empty),
  'prompter:update': ch<boolean>()(z.object({ state: z.unknown() }).strict()),
  'prompter:command': ch<boolean>()(z.object({ command: z.string().max(40), value: z.number().optional() }).strict()),
  'prompter:info': ch<{ open: boolean; windowId: number | null; bounds: { x: number; y: number; width: number; height: number } | null }>()(Empty),
  'hotkeys:arm': ch<string[]>()(z.object({ on: z.boolean() }).strict()),
  'settings:get': ch<unknown>()(z.object({ key: z.string().min(1).max(100) }).strict()),
  'settings:set': ch<boolean>()(z.object({ key: z.string().min(1).max(100), value: z.unknown() }).strict()),
  'file:exists': ch<boolean>()(z.object({ path: Path }).strict()),
  'file:writeImage': ch<boolean>()(z.object({ path: Path.refine((p) => /\.(png|jpe?g)$/i.test(p), 'images only'), data: z.instanceof(Uint8Array) }).strict()),
  'file:writeText': ch<boolean>()(z.object({ path: Path.refine((p) => /\.(srt|vtt|txt|json|md|cube)$/i.test(p), 'text files only'), text: z.string().max(20_000_000) }).strict()),
  'media:import': ch<Array<{ ok: true; media: MediaRef; derived: { thumbs?: string; thumbCount?: number; peaks?: string; peaksRate?: number }; needsProxy: boolean; reason?: string } | { ok: false; path: string; error: string }>>()(z.object({ paths: z.array(Path).min(1).max(500), projectDir: Path.optional(), proxies: z.boolean().optional(), role: MediaRefSchema.shape.role }).strict()),
  'media:derived': ch<{ thumbs: string | null; peaks: string | null; proxy: string | null }>()(z.object({ hash: z.string().min(8).max(128), projectDir: Path.optional() }).strict()),
  'media:peaks': ch<Uint8Array>()(z.object({ path: Path }).strict()),
  'media:check': ch<Array<{ path: string; exists: boolean }>>()(z.object({ paths: z.array(Path).max(5000) }).strict()),
  'media:relink': ch<string | null>()(z.object({ hash: z.string().min(8).max(128), size: z.number().int().optional(), dirs: z.array(Path).min(1).max(20) }).strict()),
  'media:proxy': ch<string>()(z.object({ path: Path, projectDir: Path.optional() }).strict()),
  'media:size': ch<number | null>()(z.object({ path: Path }).strict()),
  'export:defaultDir': ch<string>()(Empty),
  'export:begin': ch<{ id: string; tmp: string }>()(z.object({ path: Path }).strict()),
  'export:write': ch<number>()(z.object({ id: z.string().uuid(), position: z.number().int().nonnegative(), data: z.instanceof(Uint8Array) }).strict()),
  'export:finish': ch<ExportRecord>()(z.object({
    id: z.string().uuid(), codec: z.enum(['avc', 'hevc']), targetI: z.number().min(-40).max(-5).nullable(), truePeak: z.number().min(-9).max(0), audioBitrate: z.number().int().positive(),
    record: z.object({ preset: z.string().max(40), projectName: z.string().max(200), seconds: z.number().nonnegative(), codec: z.string().max(10), width: z.number().int(), height: z.number().int() }).strict(),
  }).strict()),
  'export:cancel': ch<boolean>()(z.object({ id: z.string().uuid() }).strict()),
  'export:history': ch<ExportRecord[]>()(Empty),
  'export:loudness': ch<LoudnessReport | null>()(z.object({ path: Path }).strict()),
  'transcribe:run': ch<Transcript>()(z.object({ path: Path, model: z.string().max(40).optional(), language: z.string().max(10).optional(), projectDir: Path.optional(), force: z.boolean().optional() }).strict()),
  'models:list': ch<Array<ModelInfo & { path: string | null }>>()(Empty),
  'models:download': ch<string>()(z.object({ id: z.string().max(40), url: z.string().url().optional(), sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional() }).strict()),
  'models:cancel': ch<boolean>()(z.object({ id: z.string().max(40) }).strict()),
  'audio:process': ch<{ path: string; probe: ProbeResult }>()(z.object({ path: Path, denoise: z.boolean().optional(), enhance: z.boolean().optional(), projectDir: Path.optional() }).strict()),
  'audio:beats': ch<number[]>()(z.object({ path: Path, projectDir: Path.optional() }).strict()),
  'audiolib:folders': ch<string[]>()(Empty),
  'audiolib:setFolders': ch<boolean>()(z.object({ folders: z.array(Path).max(20) }).strict()),
  'audiolib:scan': ch<Array<{ path: string; name: string; folder: string; durationUs: number; kind: 'music' | 'sfx' }>>()(z.object({ folders: z.array(Path).max(20).optional() }).strict()),
  'video:faces': ch<Array<{ t: number; faces: Array<{ x: number; y: number; w: number; h: number; c: number }> }>>()(z.object({ path: Path, every: z.number().int().min(1).max(30).optional(), projectDir: Path.optional() }).strict()),
  'video:speakers': ch<{ content: { x: number; y: number; w: number; h: number }; samples: Array<{ t: number; faces: Array<{ x: number; y: number; w: number; h: number; c?: number; m?: number }> }> }>()(z.object({ path: Path, projectDir: Path.optional() }).strict()),
  'video:segment': ch<string>()(z.object({ path: Path, quality: z.enum(['fast', 'balanced', 'accurate']).optional(), projectDir: Path.optional() }).strict()),
  'video:stabilize': ch<{ path: string; probe: ProbeResult }>()(z.object({ path: Path, smoothing: z.number().int().min(1).max(100).optional(), projectDir: Path.optional() }).strict()),
  'app:permissions': ch<Record<'camera' | 'microphone' | 'screen', 'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>>()(Empty),
  'app:requestPermission': ch<'granted' | 'denied' | 'restricted' | 'not-determined' | 'unknown'>()(z.object({ kind: z.enum(['camera', 'microphone', 'screen']) }).strict()),
  'app:openPrivacySettings': ch<boolean>()(z.object({ kind: z.enum(['camera', 'microphone', 'screen']) }).strict()),
  'app:onboarding': ch<{ show: boolean }>()(Empty),
  'library:call': ch<unknown>()(z.object({ method: z.string().min(1).max(60), args: z.array(z.unknown()).max(8) }).strict()),
  'swipe:import': ch<ImportResult>()(z.object({ brandId: Id, paths: z.array(Path).min(1).max(500), folder: z.string().max(200).optional() }).strict()),
  'swipe:importUrl': ch<ImportResult>()(z.object({ brandId: Id, url: z.string().url().max(2000) }).strict()),
  'swipe:analyze': ch<RefAnalysis>()(z.object({ brandId: Id, id: Id, transcribe: z.boolean().optional() }).strict()),
  'claude:status': ch<{ hasKey: boolean; model: string; models: Array<{ id: string; label: string; input: number; output: number }>; usage: UsageSummary }>()(Empty),
  'claude:setKey': ch<boolean>()(z.object({ key: z.string().max(400).nullable() }).strict()),
  'claude:setModel': ch<string>()(z.object({ model: z.string().max(60) }).strict()),
  'claude:structure': ch<{ structure: Structure; costUsd: number }>()(z.object({ brandId: Id, refId: Id }).strict()),
  'claude:draft': ch<{ draft: Draft; estimateSec: number; spokenWords: number; withinTolerance: boolean; revisions: number; costUsd: number }>()(z.object({
    brandId: Id, voiceId: Id.nullable().optional(), topic: z.string().min(1).max(2000), targetSec: z.number().min(5).max(600), refId: Id.nullable().optional(), extra: z.string().max(4000).optional(), requestId: z.string().min(1).max(64),
  }).strict()),
  'claude:hooks': ch<{ hooks: HookIdea[]; costUsd: number }>()(z.object({ brandId: Id, voiceId: Id.nullable().optional(), topic: z.string().min(1).max(2000), count: z.number().int().min(1).max(30).optional() }).strict()),
  'claude:voiceCheck': ch<{ check: VoiceCheck; costUsd: number }>()(z.object({ brandId: Id, voiceId: Id, script: z.string().min(1).max(100_000) }).strict()),
  'claude:release': ch<{ copy: ReleaseCopy; costUsd: number }>()(z.object({ brandId: Id, voiceId: Id.nullable().optional(), transcript: z.string().min(1).max(200_000) }).strict()),
  'claude:director': ch<{ summary: string; actions: DirectorAction[]; plan: { ok: boolean; problems: ActionProblem[]; preview: PreviewItem[]; before: number; after: number; removedUs: number; counts: Record<ActionType, number> }; costUsd: number }>()(z.object({
    doc: z.unknown(), goal: z.string().max(4000), brandId: Id.nullable().optional(), refId: Id.nullable().optional(), targetSec: z.number().min(5).max(3600).nullable().optional(),
  }).strict()),
  'mcp:status': ch<McpStatus>()(Empty),
  'mcp:enable': ch<McpStatus>()(z.object({ on: z.boolean(), rotateToken: z.boolean().optional() }).strict()),
  'agent:setMode': ch<McpStatus>()(z.object({ mode: z.enum(['ask', 'auto']) }).strict()),
  'agent:result': ch<boolean>()(z.object({ requestId: z.string().uuid(), response: z.union([z.object({ ok: z.literal(true), data: z.unknown() }), z.object({ ok: z.literal(false), error: z.object({ code: z.string().max(64), message: z.string().max(20_000), hint: z.string().max(2000).optional() }) })]) }).strict()),
} as const;

export interface OpenedProject { doc: Project; seq: number; recoveredOps: number; migratedFrom: number | null; dir: string }

export type Channels = typeof channels;
export type Channel = keyof Channels;
export type ChannelInput<C extends Channel> = z.input<Channels[C]['input']>;
export type ChannelParsed<C extends Channel> = z.output<Channels[C]['input']>;
export type ChannelOutput<C extends Channel> = Channels[C]['__out'];

export interface Events {
  'job:start': { id: string; kind: string };
  'job:progress': { id: string; kind: string; units: number; ratio: number | null };
  'job:done': { id: string; kind: string; code: number | null; cancelled: boolean };
  'app:error': { message: string };
  'follow:event': { type: string; text?: string; start?: number; end?: number; wall?: number; rms?: number; t?: number; recvMs: number; error?: string };
  'screen:event': { takeId: string; event?: string; t?: number; error?: string };
  'prompter:state': unknown;
  'prompter:command': { command: string; value?: number };
  'hotkey': { key: string; source: 'global' | 'window' };
  'models:progress': { id: string; got: number; total: number | null };
  'claude:text': { requestId: string; delta: string };
  'library:changed': Record<string, never>;
  'claude:usage': { task: string; costUsd: number };
  'mcp:status': McpStatus;
  'agent:call': { requestId: string; client: string; tool: string; args: unknown };
}
export type EventName = keyof Events;
export type EventPayload<E extends EventName> = Events[E];

export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; issues?: unknown } };
