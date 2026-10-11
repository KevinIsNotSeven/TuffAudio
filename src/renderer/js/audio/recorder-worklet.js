// Captures raw PCM from its input and posts it to the main thread in batches.
const BATCH = 2048;

class TuffRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.running = true;
    this.buf = null;
    this.n = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'stop') {
        this.flush();
        this.running = false;
        this.port.postMessage({ done: true });
      }
    };
  }

  flush() {
    if (!this.buf || !this.n) return;
    const chunk = this.buf.map((c) => c.slice(0, this.n));
    this.port.postMessage({ chunk }, chunk.map((c) => c.buffer));
    this.n = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!this.running) return false;
    if (!input || !input.length) return true;
    if (!this.buf || this.buf.length !== input.length) {
      this.flush();
      this.buf = input.map(() => new Float32Array(BATCH));
      this.n = 0;
    }
    const frames = input[0].length;
    for (let c = 0; c < input.length; c++) this.buf[c].set(input[c], this.n);
    this.n += frames;
    if (this.n + frames > BATCH) this.flush();
    return true;
  }
}

registerProcessor('tuff-recorder', TuffRecorder);
