/**
 * WAV encoding for the voice recorder. The browser's MediaRecorder produces
 * webm/opus (or mp4), which Gemini's audio understanding doesn't reliably
 * accept — so we decode to PCM, downmix to 16 kHz mono, and wrap it in a WAV
 * header (universally accepted, tiny code). The encoder is pure and tested;
 * only blobToWavBase64 touches browser audio APIs.
 */

export const TARGET_SAMPLE_RATE = 16_000;

/** Float32 [-1,1] samples → 16-bit PCM WAV file bytes. Pure. */
export function encodeWavPcm16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const dataLength = samples.length * 2;
  const buffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(buffer);

  const writeAscii = (offset: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(offset + i, s.charCodeAt(i));
  };

  writeAscii(0, 'RIFF');
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, 'WAVE');
  writeAscii(12, 'fmt ');
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate
  view.setUint16(32, 2, true); // block align
  view.setUint16(34, 16, true); // bits per sample
  writeAscii(36, 'data');
  view.setUint32(40, dataLength, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return buffer;
}

/** ArrayBuffer → base64 without blowing the call stack on big buffers. Pure-ish. */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Recorder blob (webm/mp4) → 16 kHz mono WAV base64, ready for the transcribe
 * endpoint. Decodes with a throwaway AudioContext, resamples via OfflineAudioContext.
 */
export async function blobToWavBase64(blob: Blob): Promise<string> {
  const arrayBuffer = await blob.arrayBuffer();

  const DecodeCtx: typeof AudioContext | undefined =
    window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!DecodeCtx) throw new Error('AudioContext unsupported');

  const decodeCtx = new DecodeCtx();
  try {
    const decoded = await decodeCtx.decodeAudioData(arrayBuffer);

    const length = Math.ceil((decoded.duration || 0) * TARGET_SAMPLE_RATE);
    if (length === 0) throw new Error('empty recording');

    const offline = new OfflineAudioContext(1, length, TARGET_SAMPLE_RATE);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();

    const wav = encodeWavPcm16(rendered.getChannelData(0), TARGET_SAMPLE_RATE);
    return arrayBufferToBase64(wav);
  } finally {
    void decodeCtx.close().catch(() => undefined);
  }
}
