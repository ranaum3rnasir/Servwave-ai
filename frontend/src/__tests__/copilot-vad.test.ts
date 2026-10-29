import { describe, it, expect } from 'vitest';
import { createVadTracker, DEFAULT_VAD, type VadConfig } from '@/components/copilot/voice/vad';

const CFG: VadConfig = {
  startThreshold: 0.015,
  stopThreshold: 0.008,
  silenceMs: 1500,
  maxUtteranceMs: 30_000,
  noSpeechMs: 8_000,
};

describe('copilot voice activity detection', () => {
  it('waits while quiet, then discards after the no-speech window', () => {
    const vad = createVadTracker(0, CFG);
    expect(vad.update(0.001, 1000)).toBe('waiting');
    expect(vad.update(0.001, 7999)).toBe('waiting');
    expect(vad.update(0.001, 8000)).toBe('discard');
    expect(vad.hadSpeech()).toBe(false);
  });

  it('detects speech start and keeps going while loud', () => {
    const vad = createVadTracker(0, CFG);
    expect(vad.update(0.001, 500)).toBe('waiting');
    expect(vad.update(0.05, 1000)).toBe('speaking');
    expect(vad.hadSpeech()).toBe(true);
    expect(vad.update(0.04, 2000)).toBe('speaking');
  });

  it('stops after sustained silence following speech (auto-send)', () => {
    const vad = createVadTracker(0, CFG);
    vad.update(0.05, 1000); // speech starts; last loud = 1000
    expect(vad.update(0.001, 2000)).toBe('speaking'); // 1000ms of silence — not yet
    expect(vad.update(0.001, 2499)).toBe('speaking'); // 1499ms — not yet
    expect(vad.update(0.001, 2500)).toBe('stop'); // 1500ms of silence
  });

  it('brief dips below the stop threshold do not end the turn (hysteresis)', () => {
    const vad = createVadTracker(0, CFG);
    vad.update(0.05, 1000);
    vad.update(0.001, 1800); // dip
    expect(vad.update(0.02, 2400)).toBe('speaking'); // loud again resets silence
    expect(vad.update(0.001, 3000)).toBe('speaking');
    expect(vad.update(0.001, 3899)).toBe('speaking');
    expect(vad.update(0.001, 3900)).toBe('stop'); // 1500ms after last loud at 2400
  });

  it('hard-caps an utterance at maxUtteranceMs even if still loud', () => {
    const vad = createVadTracker(0, CFG);
    vad.update(0.05, 0);
    expect(vad.update(0.05, 29_999)).toBe('speaking');
    expect(vad.update(0.05, 30_000)).toBe('stop');
  });

  it('default config keeps sane orderings', () => {
    expect(DEFAULT_VAD.stopThreshold).toBeLessThan(DEFAULT_VAD.startThreshold);
    expect(DEFAULT_VAD.silenceMs).toBeLessThan(DEFAULT_VAD.noSpeechMs);
    expect(DEFAULT_VAD.noSpeechMs).toBeLessThan(DEFAULT_VAD.maxUtteranceMs);
  });
});
