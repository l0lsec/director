import { z } from 'zod';
import { estimateSeconds, parseScript } from '@director/engine';
import type { ClaudeClient, CallRecord } from '../client/claude';
import type { Segment } from '../structure';

/** The parts of a brand voice profile sent to Claude. */
export interface VoiceInput { name: string; description: string; rules: string[]; examples: string[]; banned: string[]; wpm: number }

export function voiceContext(v: VoiceInput): string {
  return [
    `Brand voice: ${v.name}`,
    v.description && `Description: ${v.description}`,
    v.rules.length ? `Rules:\n${v.rules.map((r) => `- ${r}`).join('\n')}` : '',
    v.banned.length ? `Never use these words or phrases: ${v.banned.join(', ')}` : '',
    v.examples.length ? `Examples of this voice:\n${v.examples.map((e, i) => `Example ${i + 1}:\n${e}`).join('\n\n')}` : '',
    `Speaking rate: ${v.wpm} words per minute.`,
  ].filter(Boolean).join('\n\n');
}

const CUE_HELP = `Scripts are read from a teleprompter. Write one spoken sentence or beat per line.
Add production cues in square brackets where they help: [HOOK], [ZOOM], [PAUSE], [B-ROLL: what to show], [SCREEN: what to show], [CTA], [EMPHASIS]. Cues are not spoken.
Write numbers the way they should be said. No hashtags, emojis or stage directions outside cues.`;

// ---------------------------------------------------------------- draft from a reference

export const DraftSchema = z.object({
  title: z.string().describe('Working title, under 60 characters'),
  hook: z.string().describe('The opening line, copied from the script'),
  script: z.string().describe('The full script, one beat per line, with [CUE] markers'),
  notes: z.string().describe('One or two sentences on what was borrowed from the reference structure'),
});
export type Draft = z.infer<typeof DraftSchema>;

export const DRAFT_SYSTEM = `You are a scriptwriter for short-form vertical video. You adapt the structure of a reference reel that performed well into an original script in the creator's own brand voice, about the creator's own topic.
Borrow structure and pacing, never wording: do not copy phrases from the reference.
${CUE_HELP}
Hit the requested length: count spoken words carefully.`;

export interface DraftInput {
  topic: string;
  targetSec: number;
  voice: VoiceInput;
  reference?: { transcript: string; segments: Segment[]; durationSec: number; hookType?: string };
  extra?: string;
}

export function targetWords(targetSec: number, wpm: number): number { return Math.round((targetSec * wpm) / 60); }

export function draftPrompt(i: DraftInput): string {
  const words = targetWords(i.targetSec, i.voice.wpm);
  const ref = i.reference
    ? [
      `Reference reel (${i.reference.durationSec.toFixed(1)} s${i.reference.hookType ? `, hook: ${i.reference.hookType}` : ''}). Structure:`,
      ...i.reference.segments.map((s) => `- ${s.label} ${s.start.toFixed(1)}-${s.end.toFixed(1)} s: ${s.summary}${s.technique ? ` (${s.technique})` : ''}`),
      'Reference transcript (for structure only, do not reuse its wording):',
      i.reference.transcript,
    ].join('\n')
    : 'No reference: use a proven hook, value, payoff, call to action structure.';
  return [
    ref,
    '',
    `Topic: ${i.topic}`,
    i.extra ? `Notes from the creator: ${i.extra}` : '',
    `Length: ${i.targetSec} s at ${i.voice.wpm} words per minute, so about ${words} spoken words (cues do not count; each [PAUSE] adds 0.6 s).`,
  ].filter(Boolean).join('\n');
}

export interface DraftResult { draft: Draft; estimateSec: number; spokenWords: number; withinTolerance: boolean; revisions: number; records: CallRecord[] }

/** Runtime estimate of a script at a WPM, using the teleprompter's own parser. */
export function scriptRuntime(text: string, wpm: number): { seconds: number; words: number } {
  const p = parseScript(text);
  return { seconds: estimateSeconds(p, wpm), words: p.wordCount };
}

/**
 * Draft a script, then check its runtime with the prompter's estimator. If it is more than
 * `tolerance` off target, ask for a revision (up to `maxRevisions` times) with the measured count.
 */
export async function draftScript(client: ClaudeClient, input: DraftInput, opts: { tolerance?: number; maxRevisions?: number; onText?: (d: string) => void } = {}): Promise<DraftResult> {
  const tol = opts.tolerance ?? 0.1;
  const max = opts.maxRevisions ?? 2;
  const records: CallRecord[] = [];
  const context = voiceContext(input.voice);
  const prompt = draftPrompt(input);
  let { data, record, raw } = await client.call({ task: 'draft', system: DRAFT_SYSTEM, context, prompt, schema: DraftSchema, effort: 'medium', onText: opts.onText });
  records.push(record);
  const history: Array<{ role: 'user' | 'assistant'; text: string }> = [{ role: 'user', text: prompt }];
  let revisions = 0;
  let est = scriptRuntime(data.script, input.voice.wpm);
  while (Math.abs(est.seconds - input.targetSec) / input.targetSec > tol && revisions < max) {
    history.push({ role: 'assistant', text: raw });
    const want = targetWords(input.targetSec, input.voice.wpm);
    const fix = `That script has ${est.words} spoken words, about ${est.seconds.toFixed(1)} s at ${input.voice.wpm} words per minute. The target is ${input.targetSec} s (about ${want} words). ${est.seconds > input.targetSec ? 'Cut' : 'Add'} about ${Math.abs(est.words - want)} words while keeping the hook and structure. Return the full revised script.`;
    ({ data, record, raw } = await client.call({ task: 'draft', system: DRAFT_SYSTEM, context, prompt: fix, history: [...history], schema: DraftSchema, effort: 'medium', onText: opts.onText }));
    history.push({ role: 'user', text: fix });
    records.push(record);
    revisions++;
    est = scriptRuntime(data.script, input.voice.wpm);
  }
  return { draft: data, estimateSec: est.seconds, spokenWords: est.words, withinTolerance: Math.abs(est.seconds - input.targetSec) / input.targetSec <= tol, revisions, records };
}

// ---------------------------------------------------------------- hooks

export const HooksSchema = z.object({
  hooks: z.array(z.object({
    text: z.string(),
    score: z.number().describe('0 to 10: how likely this stops the scroll for this audience'),
    tags: z.array(z.string()).describe('Hook techniques, for example "question", "bold claim", "number", "story", "contrarian"'),
    why: z.string().describe('One short sentence'),
  })),
});
export type HookIdea = { text: string; score: number; tags: string[]; why: string };

export const HOOKS_SYSTEM = `You write scroll-stopping opening lines for short-form vertical video, in the creator's brand voice.
Each hook is one spoken sentence under 18 words. Vary the technique. Score each honestly from 0 to 10.`;

export async function writeHooks(client: ClaudeClient, input: { topic: string; voice: VoiceInput; examples: string[]; count?: number }): Promise<{ hooks: HookIdea[]; record: CallRecord }> {
  const n = input.count ?? 10;
  const { data, record } = await client.call({
    task: 'hooks',
    system: HOOKS_SYSTEM,
    context: voiceContext(input.voice),
    prompt: [`Topic: ${input.topic}`, input.examples.length ? `Hooks from the creator's bank that worked:\n${input.examples.map((e) => `- ${e}`).join('\n')}` : '', `Write ${n} hooks.`].filter(Boolean).join('\n\n'),
    schema: HooksSchema,
    effort: 'low',
    maxTokens: 4000,
  });
  const seen = new Set<string>();
  const hooks = data.hooks
    .map((h) => ({ text: h.text.trim().replace(/\s+/g, ' '), score: Math.max(0, Math.min(10, Math.round(h.score * 10) / 10)), tags: [...new Set(h.tags.map((t) => t.trim().toLowerCase()).filter(Boolean))].slice(0, 6), why: h.why.trim() }))
    .filter((h) => h.text && h.text.length <= 400 && !seen.has(h.text.toLowerCase()) && seen.add(h.text.toLowerCase()))
    .sort((a, b) => b.score - a.score)
    .slice(0, n);
  return { hooks, record };
}

// ---------------------------------------------------------------- check against voice

export const VoiceCheckSchema = z.object({
  score: z.number().describe('0 to 10: how well the script matches the voice'),
  findings: z.array(z.object({
    line: z.number().describe('1-based line number in the script as given'),
    severity: z.enum(['info', 'warn', 'fix']),
    issue: z.string(),
    suggestion: z.string().describe('A rewritten version of the line, or empty'),
  })),
  rewrite: z.string().describe('The full script rewritten in the voice, keeping cues'),
});
export interface VoiceFinding { line: number; severity: 'info' | 'warn' | 'fix'; issue: string; suggestion: string; text: string }
export interface VoiceCheck { score: number; findings: VoiceFinding[]; rewrite: string; dropped: number }

export const VOICE_SYSTEM = `You are an editor who enforces a creator's brand voice. Review the numbered script line by line against the voice profile.
Flag only real problems: banned words, rule breaks, lines that sound unlike the examples, weak hooks, unclear lines. Reference lines by their number.`;

/** Numbered script lines exactly as the model sees them; blank lines are not numbered. */
export function numberedLines(script: string): string[] {
  return script.replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
}

export async function checkVoice(client: ClaudeClient, input: { script: string; voice: VoiceInput }): Promise<{ check: VoiceCheck; record: CallRecord }> {
  const lines = numberedLines(input.script);
  const { data, record } = await client.call({
    task: 'voice',
    system: VOICE_SYSTEM,
    context: voiceContext(input.voice),
    prompt: `Script (${lines.length} lines):\n${lines.map((l, i) => `${i + 1}. ${l}`).join('\n')}`,
    schema: VoiceCheckSchema,
    effort: 'medium',
  });
  // Line references must point at a real line; anything else is dropped (and counted), never guessed.
  const findings: VoiceFinding[] = [];
  let dropped = 0;
  for (const f of data.findings) {
    if (!Number.isInteger(f.line) || f.line < 1 || f.line > lines.length || !f.issue.trim()) { dropped++; continue; }
    findings.push({ line: f.line, severity: f.severity, issue: f.issue.trim(), suggestion: f.suggestion.trim(), text: lines[f.line - 1]! });
  }
  findings.sort((a, b) => a.line - b.line);
  // Banned words are checked locally too, so a miss by the model cannot hide one.
  for (const [i, l] of lines.entries()) {
    for (const b of input.voice.banned) {
      if (b && new RegExp(`\\b${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(l) && !findings.some((f) => f.line === i + 1 && f.issue.toLowerCase().includes(b.toLowerCase()))) {
        findings.push({ line: i + 1, severity: 'fix', issue: `Uses the banned phrase "${b}"`, suggestion: '', text: l });
      }
    }
  }
  findings.sort((a, b) => a.line - b.line);
  return { check: { score: Math.max(0, Math.min(10, data.score)), findings, rewrite: data.rewrite.trim(), dropped }, record };
}

// ---------------------------------------------------------------- release copy

export const ReleaseSchema = z.object({
  captions: z.array(z.string()).describe('Three post captions, each under 220 characters'),
  hashtags: z.array(z.string()).describe('Up to 8 hashtags without the # sign'),
  covers: z.array(z.string()).describe('Three cover text options, each under 6 words'),
});
export type ReleaseCopy = z.infer<typeof ReleaseSchema>;

export async function releaseCopy(client: ClaudeClient, input: { transcript: string; voice: VoiceInput }): Promise<{ copy: ReleaseCopy; record: CallRecord }> {
  const { data, record } = await client.call({
    task: 'release',
    system: 'You write post copy for short-form vertical video in the creator\'s voice: captions, hashtags and cover text. Be concrete; no clickbait the video does not deliver.',
    context: voiceContext(input.voice),
    prompt: `Transcript of the finished video:\n${input.transcript}`,
    schema: ReleaseSchema,
    effort: 'low',
    maxTokens: 3000,
  });
  return {
    copy: {
      captions: data.captions.map((c) => c.trim()).filter(Boolean).slice(0, 3),
      hashtags: [...new Set(data.hashtags.map((h) => h.trim().replace(/^#/, '').replace(/\s+/g, '').toLowerCase()).filter(Boolean))].slice(0, 8),
      covers: data.covers.map((c) => c.trim()).filter(Boolean).slice(0, 3),
    },
    record,
  };
}
