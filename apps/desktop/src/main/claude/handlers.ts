import { BrowserWindow } from 'electron';
import { appendFileSync, readFileSync, statSync } from 'node:fs';
import {
  ClaudeClient, ClaudeError, PrivacyError, ReplayTransport, sdkTransport, isModelId, DEFAULT_MODEL, MODELS,
  labelStructure, draftScript, writeHooks, checkVoice, releaseCopy, runDirector,
  type Transport, type CallRecord, type VoiceInput, type ClaudeResponse,
} from '@director/ai';
import type { Pacing } from '@director/analysis';
import { ProjectSchema, type Project } from '@director/engine';
import { getSecret, setSecret, hasSecret, getSetting, setSetting } from '../settings';
import { library, libraryChangedEvent, type RefAnalysis } from '../library/handlers';

const broadcast = (event: string, payload: unknown) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(`director:event:${event}`, payload); };

let replay: { t: ReplayTransport; mtime: number } | null = null;

/** Logs every request exactly as sent (test runs, or when the user turns on the request log). */
function logged(inner: Transport): Transport {
  const path = process.env.DIRECTOR_CLAUDE_LOG;
  if (!path) return inner;
  return {
    send(req, opts) {
      appendFileSync(path, JSON.stringify({ task: opts.task, at: new Date().toISOString(), request: req }) + '\n');
      return inner.send(req, opts);
    },
  };
}

function transport(): Transport {
  // Test runs replay recorded responses; nothing reaches the network.
  if (process.env.DIRECTOR_TEST === '1' && process.env.DIRECTOR_CLAUDE_REPLAY) {
    // Reloaded when the file changes, so a check can add responses written for the state it reached.
    const file = process.env.DIRECTOR_CLAUDE_REPLAY;
    const mtime = statSync(file).mtimeMs;
    if (!replay || replay.mtime !== mtime) replay = { t: new ReplayTransport(JSON.parse(readFileSync(file, 'utf8')) as Record<string, ClaudeResponse | ClaudeResponse[]>), mtime };
    return logged(replay.t);
  }
  const key = getSecret('claude.apiKey');
  if (!key) throw new ClaudeError('NO_KEY', 'Add your Claude API key in Settings to use this feature.');
  return logged(sdkTransport(key));
}

export function currentModel(): string {
  const m = getSetting<string>('claude.model', DEFAULT_MODEL);
  return isModelId(m) ? m : DEFAULT_MODEL;
}

export function claudeClient(brandId?: string | null): ClaudeClient {
  return new ClaudeClient(transport(), currentModel(), (r: CallRecord) => {
    library().usage.record({ task: r.task, model: r.model, input: r.usage.input_tokens, output: r.usage.output_tokens, cacheRead: r.usage.cache_read_input_tokens ?? 0, cacheWrite: r.usage.cache_creation_input_tokens ?? 0, costUsd: r.costUsd, brandId, at: r.at });
    broadcast('claude:usage', { task: r.task, costUsd: r.costUsd });
  });
}

const DEFAULT_VOICE: VoiceInput = { name: 'Default', description: 'Clear, direct and friendly.', rules: [], examples: [], banned: [], wpm: 160 };
function voiceFor(brandId: string, voiceId?: string | null): VoiceInput {
  if (!voiceId) return DEFAULT_VOICE;
  const v = library().studio.voice(brandId, voiceId);
  if (!v) throw Object.assign(new Error('Voice profile not found in this brand'), { code: 'NOT_FOUND' });
  return { name: v.name, description: v.description, rules: v.rules, examples: v.examples, banned: v.banned, wpm: v.wpm };
}

/** Errors cross IPC as code + message so the UI can show the right action (add a key, retry, shorten). */
async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); } catch (e) {
    if (e instanceof ClaudeError) throw Object.assign(new Error(e.message), { code: `CLAUDE_${e.code}` });
    if (e instanceof PrivacyError) throw Object.assign(new Error(e.message), { code: 'PRIVACY' });
    throw e;
  }
}

function referenceFor(brandId: string, refId: string) {
  const ref = library().swipe.require(brandId, refId);
  const a = ref.analysis as (RefAnalysis & { structure?: { segments: never[]; hookType?: string } }) | null;
  const t = library().swipe.transcript<{ words: Array<{ text: string; start: number; end: number }> }>(brandId, refId);
  return { ref, analysis: a, words: t?.words ?? [] };
}

export const claudeHandlers = {
  'claude:status': () => ({
    hasKey: hasSecret('claude.apiKey') || (process.env.DIRECTOR_TEST === '1' && !!process.env.DIRECTOR_CLAUDE_REPLAY),
    model: currentModel(),
    models: Object.entries(MODELS).map(([id, m]) => ({ id, label: m.label, input: m.input, output: m.output })),
    usage: library().usage.summary(),
  }),
  'claude:setKey': ({ key }: { key: string | null }) => {
    const k = key?.trim() || null;
    if (k && !/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(k)) throw Object.assign(new Error('That does not look like a Claude API key (it starts with sk-ant-).'), { code: 'INVALID' });
    setSecret('claude.apiKey', k);
    return hasSecret('claude.apiKey');
  },
  'claude:setModel': ({ model }: { model: string }) => {
    if (!isModelId(model)) throw Object.assign(new Error(`unknown model ${model}`), { code: 'INVALID' });
    setSetting('claude.model', model);
    return model;
  },
  'claude:structure': ({ brandId, refId }: { brandId: string; refId: string }) => guard(async () => {
    const { analysis, words } = referenceFor(brandId, refId);
    if (!analysis) throw Object.assign(new Error('Analyze the reference first'), { code: 'NOT_ANALYZED' });
    const { structure, record } = await labelStructure(claudeClient(brandId), { words, shots: analysis.shots, durationSec: analysis.durationSec });
    library().swipe.setAnalysis(brandId, refId, { ...analysis, structure });
    libraryChangedEvent();
    return { structure, costUsd: record.costUsd };
  }),
  'claude:draft': ({ brandId, voiceId, topic, targetSec, refId, extra, requestId }: { brandId: string; voiceId?: string | null; topic: string; targetSec: number; refId?: string | null; extra?: string; requestId: string }) => guard(async () => {
    let reference;
    if (refId) {
      const { analysis, words } = referenceFor(brandId, refId);
      const st = analysis?.structure as { segments: never[]; hookType?: string } | undefined;
      reference = { transcript: words.map((w) => w.text).join(' '), segments: st?.segments ?? [], durationSec: analysis?.durationSec ?? 0, hookType: st?.hookType };
    }
    const r = await draftScript(claudeClient(brandId), { topic, targetSec, voice: voiceFor(brandId, voiceId), reference, extra }, { onText: (delta) => broadcast('claude:text', { requestId, delta }) });
    return { draft: r.draft, estimateSec: r.estimateSec, spokenWords: r.spokenWords, withinTolerance: r.withinTolerance, revisions: r.revisions, costUsd: r.records.reduce((s, x) => s + x.costUsd, 0) };
  }),
  'claude:hooks': ({ brandId, voiceId, topic, count }: { brandId: string; voiceId?: string | null; topic: string; count?: number }) => guard(async () => {
    const examples = library().studio.hooks(brandId).slice(0, 12).map((h) => h.text);
    const { hooks, record } = await writeHooks(claudeClient(brandId), { topic, voice: voiceFor(brandId, voiceId), examples, count });
    return { hooks, costUsd: record.costUsd };
  }),
  'claude:voiceCheck': ({ brandId, voiceId, script }: { brandId: string; voiceId: string; script: string }) => guard(async () => {
    const { check, record } = await checkVoice(claudeClient(brandId), { script, voice: voiceFor(brandId, voiceId) });
    return { check, costUsd: record.costUsd };
  }),
  'claude:release': ({ brandId, voiceId, transcript }: { brandId: string; voiceId?: string | null; transcript: string }) => guard(async () => {
    const { copy, record } = await releaseCopy(claudeClient(brandId), { transcript, voice: voiceFor(brandId, voiceId) });
    return { copy, costUsd: record.costUsd };
  }),
  'claude:director': ({ doc, goal, brandId, refId, targetSec }: { doc: unknown; goal: string; brandId?: string | null; refId?: string | null; targetSec?: number | null }) => guard(async () => {
    const project = ProjectSchema.parse(doc) as Project;
    let reference: Pacing | null = null;
    if (brandId && refId) reference = (referenceFor(brandId, refId).analysis?.pacing as Pacing | undefined) ?? null;
    const r = await runDirector(claudeClient(brandId), project, { goal, reference, targetSec });
    return { summary: r.summary, actions: r.actions, plan: { ok: r.plan.ok, problems: r.plan.problems, preview: r.plan.preview, before: r.plan.before, after: r.plan.after, removedUs: r.plan.removedUs, counts: r.plan.counts }, costUsd: r.record.costUsd };
  }),
};
