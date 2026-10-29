import { describe, it, expect } from 'vitest';
import { base64ToInt16, int16ToBase64, rmsLevel } from '@/components/copilot/voice/liveAudio';

describe('Servy live audio codec', () => {
  it('round-trips PCM16 through base64 unchanged', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234, -4321]);
    const b64 = int16ToBase64(samples);
    expect(typeof b64).toBe('string');
    const back = base64ToInt16(b64);
    expect(Array.from(back)).toEqual(Array.from(samples));
  });

  it('handles a large buffer without blowing the call stack', () => {
    const big = new Int16Array(200_000);
    for (let i = 0; i < big.length; i++) big[i] = (i % 65536) - 32768;
    const back = base64ToInt16(int16ToBase64(big));
    expect(back.length).toBe(big.length);
    expect(back[123]).toBe(big[123]);
  });

  it('rmsLevel is 0 for silence and rises with amplitude', () => {
    const silence = new Int16Array(512); // all zeros
    expect(rmsLevel(silence)).toBe(0);

    const loud = new Int16Array(512).fill(16384); // half-scale
    expect(rmsLevel(loud)).toBeGreaterThan(0.4);
    expect(rmsLevel(loud)).toBeLessThanOrEqual(1);
  });

  it('rmsLevel handles an empty buffer without NaN', () => {
    expect(rmsLevel(new Int16Array(0))).toBe(0);
  });
});
