// Servy voice mic worklet — captures at the AudioContext's NATIVE sample rate
// and downsamples to 16 kHz mono Int16 (what Gemini Live requires).
//
// Why not just force the AudioContext to 16 kHz? Because on many machines Chrome's
// createMediaStreamSource emits SILENCE (all-zero samples) when the context rate
// doesn't match the mic's native rate (usually 48 kHz). So we capture native and
// resample here with linear interpolation — robust on every machine.
const OUT_RATE = 16000;

class PCMProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._pos = 0; // fractional read position carried across render quanta
    this._tail = new Float32Array(0); // unconsumed input samples from last quantum
  }

  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input || input.length === 0) return true;

    const ratio = sampleRate / OUT_RATE; // `sampleRate` (worklet global) = context rate
    // Join the leftover tail with this quantum so interpolation spans the seam.
    const buf = new Float32Array(this._tail.length + input.length);
    buf.set(this._tail, 0);
    buf.set(input, this._tail.length);

    const out = [];
    let pos = this._pos;
    while (pos + 1 < buf.length) {
      const i = pos | 0;
      const frac = pos - i;
      out.push(buf[i] * (1 - frac) + buf[i + 1] * frac);
      pos += ratio;
    }
    // Keep whatever input we didn't consume (and the sub-sample phase) for next time.
    const consumed = Math.min(pos | 0, buf.length);
    this._tail = buf.slice(consumed);
    this._pos = pos - consumed;

    if (out.length > 0) {
      const int16 = new Int16Array(out.length);
      for (let j = 0; j < out.length; j++) {
        const s = out[j] < -1 ? -1 : out[j] > 1 ? 1 : out[j];
        int16[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this.port.postMessage(int16, [int16.buffer]);
    }
    return true;
  }
}

registerProcessor('pcm-processor', PCMProcessor);
