// AudioWorklet: emits 100 ms chunks of 16-bit PCM (at the context's sample rate) plus RMS.
class PcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Int16Array(Math.round(sampleRate / 10));
    this.n = 0;
    this.sum = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const v = Math.max(-1, Math.min(1, ch[i]));
      this.sum += v * v;
      this.buf[this.n++] = v * 32767;
      if (this.n === this.buf.length) {
        const rms = Math.sqrt(this.sum / this.n);
        this.port.postMessage({ pcm: this.buf.slice(0), rms }, []);
        this.n = 0;
        this.sum = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-tap', PcmTap);
