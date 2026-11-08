/**
 * Browser audio transport for Servy's Gemini Live voice.
 *
 * MicStreamer  — captures the mic as 16 kHz mono PCM16 frames via an
 *                AudioWorklet and hands each chunk to a callback (base64'd and
 *                streamed up with `sendRealtimeInput`).
 * SpeakerQueue — gapless playback of the 24 kHz PCM16 chunks Gemini streams
 *                down, with `flush()` for barge-in (stop talking instantly).
 *
 * Ported (and TS-typed) from the partner app (shuli). Pure browser audio APIs —
 * no Gemini coupling, so the session manager owns the SDK and these own sound.
 */

/** Mic capture: 16 kHz mono PCM16 chunks via AudioWorklet. */
export class MicStreamer {
  private readonly onChunk: (chunk: Int16Array) => void;
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private node: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;

  constructor(onChunk: (chunk: Int16Array) => void) {
    this.onChunk = onChunk;
  }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    // Capture at the device's NATIVE rate. Forcing 16 kHz here makes Chrome's
    // createMediaStreamSource emit pure silence on many machines; the worklet
    // downsamples native → 16 kHz instead. Resume in case the context starts
    // suspended (it's created after an await, outside the click gesture).
    this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') await this.ctx.resume();
    // public/pcm-processor.js — served at the site root by Vite. The ?v= bust
    // defeats aggressive worklet caching when the processor changes.
    await this.ctx.audioWorklet.addModule('/pcm-processor.js?v=3-sink');
    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-processor');
    this.node.port.onmessage = (e: MessageEvent<Int16Array>) => this.onChunk(e.data);
    this.source.connect(this.node);
    // Wire the worklet into the destination through a MUTED gain. Some browsers
    // feed an AudioWorkletNode SILENCE unless it's part of a graph that reaches
    // the destination (the render thread only "pulls" connected nodes). The 0
    // gain keeps it inaudible — the worklet writes no output anyway.
    this.sink = this.ctx.createGain();
    this.sink.gain.value = 0;
    this.node.connect(this.sink);
    this.sink.connect(this.ctx.destination);
  }

  stop(): void {
    this.node?.disconnect();
    this.sink?.disconnect();
    this.source?.disconnect();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = null;
    this.sink = null;
    this.source = null;
    this.stream = null;
    this.ctx = null;
  }
}

/** Gapless playback of 24 kHz PCM16 chunks; flush() supports barge-in. */
export class SpeakerQueue {
  private ctx: AudioContext;
  private nextTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 24000 });
  }

  /** Whether any audio is currently scheduled/playing. */
  get playing(): boolean {
    return this.sources.size > 0;
  }

  play(int16: Int16Array): void {
    const f32 = Float32Array.from(int16, (s) => s / 32768);
    const buf = this.ctx.createBuffer(1, f32.length, 24000);
    buf.getChannelData(0).set(f32);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.ctx.destination);
    const t = Math.max(this.ctx.currentTime, this.nextTime);
    src.start(t);
    this.nextTime = t + buf.duration;
    this.sources.add(src);
    src.onended = () => this.sources.delete(src);
  }

  /** Barge-in: stop everything queued and reset the clock. */
  flush(): void {
    for (const s of this.sources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources.clear();
    this.nextTime = 0;
  }

  close(): void {
    this.flush();
    void this.ctx.close().catch(() => undefined);
  }
}

export function base64ToInt16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

export function int16ToBase64(int16: Int16Array): string {
  const bytes = new Uint8Array(int16.buffer, int16.byteOffset, int16.byteLength);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

/** Quick RMS level (0..1) for the mic meter/orb. */
export function rmsLevel(int16: Int16Array): number {
  let sum = 0;
  for (let i = 0; i < int16.length; i++) sum += ((int16[i] ?? 0) / 32768) ** 2;
  return int16.length ? Math.sqrt(sum / int16.length) : 0;
}
