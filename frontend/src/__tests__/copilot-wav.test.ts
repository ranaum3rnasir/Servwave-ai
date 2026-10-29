import { describe, it, expect } from 'vitest';
import { encodeWavPcm16, arrayBufferToBase64 } from '@/components/copilot/voice/wav';

function ascii(view: DataView, offset: number, len: number): string {
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(view.getUint8(offset + i));
  return s;
}

describe('copilot WAV encoder', () => {
  it('writes a valid 16-bit mono PCM WAV header', () => {
    const samples = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeWavPcm16(samples, 16_000);
    const view = new DataView(buf);

    expect(buf.byteLength).toBe(44 + samples.length * 2);
    expect(ascii(view, 0, 4)).toBe('RIFF');
    expect(view.getUint32(4, true)).toBe(36 + samples.length * 2);
    expect(ascii(view, 8, 4)).toBe('WAVE');
    expect(ascii(view, 12, 4)).toBe('fmt ');
    expect(view.getUint16(20, true)).toBe(1); // PCM
    expect(view.getUint16(22, true)).toBe(1); // mono
    expect(view.getUint32(24, true)).toBe(16_000); // sample rate
    expect(view.getUint32(28, true)).toBe(32_000); // byte rate
    expect(view.getUint16(34, true)).toBe(16); // bits/sample
    expect(ascii(view, 36, 4)).toBe('data');
    expect(view.getUint32(40, true)).toBe(samples.length * 2);
  });

  it('clamps and scales samples to int16', () => {
    const buf = encodeWavPcm16(new Float32Array([0, 1, -1, 2, -2]), 16_000);
    const view = new DataView(buf);
    expect(view.getInt16(44, true)).toBe(0);
    expect(view.getInt16(46, true)).toBe(0x7fff); // 1 → max
    expect(view.getInt16(48, true)).toBe(-0x8000); // -1 → min
    expect(view.getInt16(50, true)).toBe(0x7fff); // clamped
    expect(view.getInt16(52, true)).toBe(-0x8000); // clamped
  });

  it('base64-encodes buffers of any size (chunked, no stack overflow)', () => {
    const big = new Uint8Array(200_000).fill(65); // 'A' x 200k crosses chunk boundaries
    const b64 = arrayBufferToBase64(big.buffer);
    expect(b64.length).toBeGreaterThan(0);
    expect(atob(b64).length).toBe(200_000);
    expect(atob(b64)[0]).toBe('A');
  });
});
