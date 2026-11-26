import workletUrl from './pcm-worklet.js?url';

export interface AudioTap { context: AudioContext; level: () => number; peak: () => number; stop: () => void }

/** Taps a mic stream: 16 kHz PCM for voice-follow and a live level for the meter. */
export async function tapAudio(stream: MediaStream, onPcm: (pcm: Int16Array, rms: number) => void): Promise<AudioTap> {
  const context = new AudioContext({ sampleRate: 16000 });
  if (context.state === 'suspended') await context.resume().catch(() => undefined);
  await context.audioWorklet.addModule(workletUrl);
  const src = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'pcm-tap');
  let last = 0;
  let peak = 0;
  node.port.onmessage = (e: MessageEvent<{ pcm: Int16Array; rms: number }>) => {
    last = e.data.rms;
    peak = Math.max(peak * 0.9, e.data.rms);
    onPcm(e.data.pcm, e.data.rms);
  };
  src.connect(node);
  // Keep the graph pulling without making sound.
  const mute = context.createGain();
  mute.gain.value = 0;
  node.connect(mute).connect(context.destination);
  return {
    context,
    level: () => last,
    peak: () => peak,
    stop: () => { try { src.disconnect(); node.disconnect(); } catch { /* already gone */ } void context.close(); },
  };
}
