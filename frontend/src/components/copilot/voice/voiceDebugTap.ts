/**
 * Debug tap: records the exact 16 kHz PCM we stream to Gemini Live so you can
 * HEAR what the model hears. After talking, run in the DevTools console:
 *
 *   __servyMic.seconds()    // how much audio we've captured
 *   __servyMic.play()       // play it back through your speakers
 *   __servyMic.download()   // save servy-mic.wav to listen / inspect
 *   __servyMic.clear()      // reset the buffer
 *
 * If it sounds like clear speech → our capture + resample is correct and any
 * failure is downstream (Gemini config). If it's garbled / too fast / silent →
 * the problem is in our mic path. Keeps only the last ~60 s (capped memory).
 * Dev aid only; install is idempotent and gated by the voice debug flag.
 */
import { encodeWavPcm16 } from './wav';

const SAMPLE_RATE = 16000;
const MAX_SAMPLES = SAMPLE_RATE * 60; // ~60 s cap

let chunks: Int16Array[] = [];
let installed = false;

function totalSamples(): number {
  let n = 0;
  for (const c of chunks) n += c.length;
  return n;
}

function merged(): Float32Array {
  const out = new Float32Array(totalSamples());
  let o = 0;
  for (const c of chunks) for (let i = 0; i < c.length; i++) out[o++] = (c[i] ?? 0) / 32768;
  return out;
}

function wavBlob(): Blob {
  return new Blob([encodeWavPcm16(merged(), SAMPLE_RATE)], { type: 'audio/wav' });
}

function enabled(): boolean {
  try {
    return typeof localStorage === 'undefined' || localStorage.getItem('servy_voice_debug') !== 'off';
  } catch {
    return true;
  }
}

function install(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  (window as unknown as { __servyMic: unknown }).__servyMic = {
    seconds: () => +(totalSamples() / SAMPLE_RATE).toFixed(1),
    clear: () => {
      chunks = [];
      // eslint-disable-next-line no-console
      console.log('[servy] mic tap cleared');
    },
    play: () => {
      const a = new Audio(URL.createObjectURL(wavBlob()));
      void a.play();
      // eslint-disable-next-line no-console
      console.log(`[servy] playing back ${(totalSamples() / SAMPLE_RATE).toFixed(1)}s of what we send to Gemini`);
    },
    download: () => {
      const url = URL.createObjectURL(wavBlob());
      const a = document.createElement('a');
      a.href = url;
      a.download = 'servy-mic.wav';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      // eslint-disable-next-line no-console
      console.log(`[servy] downloaded servy-mic.wav (${(totalSamples() / SAMPLE_RATE).toFixed(1)}s)`);
    },
  };
  // eslint-disable-next-line no-console
  console.log('%c[servy] mic tap ready — talk, then run __servyMic.play() or __servyMic.download()', 'color:#5B6DFF;font-weight:bold');
}

/** Called for every PCM chunk we send to Gemini. Copies (the source buffer may be reused). */
export function tapSentChunk(chunk: Int16Array): void {
  if (!enabled()) return;
  install();
  chunks.push(chunk.slice());
  while (totalSamples() > MAX_SAMPLES && chunks.length > 1) chunks.shift();
}
