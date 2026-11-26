import { assert, fixture, groundTruth } from '../lib.mjs';
import { agentSession, must, tool, appDoc } from '../agent-lib.mjs';

const norm = (s) => s.toLowerCase().replace(/[^a-z' ]/g, '');

export default async function () {
  // From nothing: no project open, everything through MCP.
  const s = await agentSession({ mode: 'auto', project: false });
  const { client, win } = s;
  try {
    const gt = groundTruth().speech.words;
    const start = await must(client, 'get_started');
    assert(start.project === null && /create_project/.test(start.next), `get_started with nothing open: ${start.next}`);
    const created = await must(client, 'create_project', { name: 'Agent reel' });
    assert(created.created === 'Agent reel' && created.canvas === '1080x1920', `create_project ${JSON.stringify(created)}`);
    assert(start.workflow.length >= 6 && Object.keys(start.tools).length >= 10, 'get_started orientation');
    const imp = await must(client, 'import_media', { paths: [fixture('speech.wav')], role: 'mic' });
    const cam = await must(client, 'import_media', { paths: [fixture('reference-reel.mp4')], role: 'camera' });
    const voiceId = imp.added[0].id, camId = cam.added[0].id;
    assert(imp.added[0].kind === 'audio' && cam.added[0].kind === 'video', 'import kinds');
    const dur = imp.added[0].duration;
    const v = await must(client, 'add_clip', { media: voiceId, start: 0 });
    const c = await must(client, 'add_clip', { media: camId, start: 0, sourceOut: Math.min(dur, cam.added[0].duration) });
    assert(v.result.lane.length && c.result.end > 20, 'clips placed');
    await must(client, 'set_audio', { clips: [c.result.clip], muted: true });
    // Local transcription through the app's whisper sidecar.
    const tr = await must(client, 'transcribe', {}, 600_000);
    assert(tr.wordsOnTimeline >= 40, `transcribed ${tr.wordsOnTimeline} words`);
    const words = (await must(client, 'get_transcript')).words;
    const heard = new Set(words.map((w) => norm(w.text)));
    const hit = gt.filter((w) => heard.has(norm(w.text))).length / gt.length;
    assert(hit >= 0.9, `transcript matched ${(hit * 100).toFixed(0)}% of the script`);
    // Find a phrase by text, then cut exactly those words.
    const phrase = 'pick the best one';
    const found = await must(client, 'find_in_transcript', { text: phrase });
    const g0 = gt.find((w) => w.text === 'pick');
    assert(found.matches === 1 && Math.abs(found.hits[0].start - g0.start) < 0.25, `find: ${JSON.stringify(found).slice(0, 200)} (truth ${g0.start})`);
    const len0 = (await must(client, 'get_timeline')).durationSec;
    const cut = await must(client, 'cut_words', { text: phrase });
    const after = await must(client, 'get_transcript');
    const text = after.words.map((w) => norm(w.text)).join(' ');
    assert(!text.includes('pick the best one') && text.includes('options and') && text.includes('write this'), `after cut: ...${text.slice(60, 160)}...`);
    assert(after.count === words.length - 4, `${words.length} -> ${after.count} words`);
    const len1 = (await must(client, 'get_timeline')).durationSec;
    assert(Math.abs(len0 - len1 - cut.result.removedSeconds) < 0.002 && cut.result.removedSeconds > 0.8 && cut.result.removedSeconds < 3, `removed ${cut.result.removedSeconds} s (${len0} -> ${len1})`);
    // Picture and sound stayed in sync: every voice cut has a camera cut at the same time.
    const doc = await appDoc(win);
    const starts = (k) => doc.lanes.find((l) => l.kind === k).clips.map((x) => x.start).join();
    assert(starts('voice') === starts('camera'), `voice ${starts('voice')} vs camera ${starts('camera')}`);
    const nope = await tool(client, 'cut_words', { text: 'purple elephant' });
    assert(/not in the transcript/.test(nope.error) && /find_in_transcript/.test(nope.error), 'missing phrase error');
    return `from no project: created one, imported speech and camera, placed both, transcribed locally (${tr.wordsOnTimeline} words, ${(hit * 100).toFixed(0)}% of the script), found "${phrase}" at ${found.hits[0].start} s (truth ${g0.start} s), cut exactly those 4 words (${cut.result.removedSeconds} s) with picture and sound still in sync`;
  } finally { await s.close(); }
}
