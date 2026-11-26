#!/usr/bin/env node
// Confirms the tools Director needs to build and run are installed.
// Prints "TOOLCHAIN PASS" only when every probe succeeds.
import { spawnSync } from 'node:child_process';

const failures = [];
const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8' });
const probe = (label, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'MISS'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures.push(label);
};

const major = Number(process.versions.node.split('.')[0]);
probe('node >= 20', major >= 20, process.versions.node);

const pnpm = run('pnpm', ['--version']);
probe('pnpm', pnpm.status === 0, (pnpm.stdout || '').trim());

const enc = run('ffmpeg', ['-hide_banner', '-encoders']);
const out = enc.stdout || '';
probe('ffmpeg', enc.status === 0);
probe('ffmpeg h264_videotoolbox', out.includes('h264_videotoolbox'));
probe('ffmpeg hevc_videotoolbox', out.includes('hevc_videotoolbox'));

const filters = run('ffmpeg', ['-hide_banner', '-filters']).stdout || '';
probe('ffmpeg scdet (shot detection)', /\bscdet\b/.test(filters));
probe('ffmpeg silencedetect', /\bsilencedetect\b/.test(filters));
probe('ffmpeg loudnorm', /\bloudnorm\b/.test(filters));

const probeBin = run('ffprobe', ['-version']);
probe('ffprobe', probeBin.status === 0);

const whisper = run('whisper-cli', ['--help']);
const wtext = `${whisper.stdout}${whisper.stderr}`;
probe('whisper-cli (whisper.cpp)', /output-json-full|-ojf/.test(wtext));

const swift = run('swift', ['--version']);
probe('swift toolchain', swift.status === 0, ((swift.stdout || swift.stderr || '').split('\n')[0] || '').trim());

const arch = run('uname', ['-m']).stdout.trim();
probe('Apple Silicon', arch === 'arm64', arch);

if (failures.length) {
  console.error(`TOOLCHAIN FAIL: ${failures.join(', ')}`);
  process.exit(1);
}
console.log('TOOLCHAIN PASS');
