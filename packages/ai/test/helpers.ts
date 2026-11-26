import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps, newClip, newProject, type Op, type Project } from '@director/engine';
import type { ClaudeResponse } from '../src';

export const root = join(__dirname, '..', '..', '..');
export const gt = JSON.parse(readFileSync(join(root, 'fixtures', 'ground-truth.json'), 'utf8'));
export const responses = JSON.parse(readFileSync(join(__dirname, '..', 'fixtures', 'responses.json'), 'utf8')) as Record<string, Record<string, ClaudeResponse> & ClaudeResponse>;

const us = (s: number) => Math.round(s * 1e6);

/** The speech fixture as a talking-head project: voice clip, muted camera clip, b-roll and titles lanes, ground-truth transcript. */
export function speechProject(): Project {
  const g = gt.speech;
  const dur = us(g.durationSec);
  let doc = newProject({ name: 'Director test', canvas: { width: 1080, height: 1920 } });
  const lane = (k: string) => doc.lanes.find((l) => l.kind === k)!.id;
  const ops: Op[] = [
    { op: 'addMedia', media: { id: 'm', path: '/Users/alex/Movies/IMG_0042.MOV', hash: 'h1', name: 'IMG_0042.MOV', kind: 'audio', durationUs: dur, hasAudio: true, hasVideo: false, addedAt: '' } },
    { op: 'addMedia', media: { id: 'c', path: '/Users/alex/Movies/camera take 3.mp4', hash: 'h2', name: 'camera take 3.mp4', kind: 'video', durationUs: dur, hasAudio: false, hasVideo: true, width: 1080, height: 1920, addedAt: '' } },
    { op: 'addClip', laneId: lane('voice'), clip: newClip({ id: 'v', kind: 'media', mediaId: 'm', name: 'IMG_0042.MOV', start: 0, in: 0, out: dur }) },
    { op: 'addClip', laneId: lane('camera'), clip: newClip({ id: 'cam', kind: 'media', mediaId: 'c', name: 'camera take 3.mp4', start: 0, in: 0, out: dur }) },
    { op: 'setMeta', patch: { transcript: [{ mediaId: 'm', language: 'en', words: g.words.map((w: { text: string; start: number; end: number }) => ({ text: w.text, start: us(w.start), end: us(w.end) })) }] } },
  ];
  doc = applyOps(doc, ops).doc;
  return doc;
}

export const voice = { name: 'Coach Alex', description: 'Direct, warm, practical. Talks to small business owners.', rules: ['Short sentences', 'Say you, not people'], examples: ['Here is the thing. Most edits are too long.'], banned: ['leverage', 'synergy'], wpm: 160 };
