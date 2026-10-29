/**
 * Pure voice-activity decision logic for the recorder. No browser APIs — the
 * recorder feeds it RMS levels + timestamps and acts on the verdicts, so the
 * tricky timing rules (when to auto-send, when to give up) are unit-testable.
 *
 *   waiting   — mic open, nothing heard yet
 *   speaking  — speech detected, still going
 *   stop      — speech happened and then went quiet (or hit max) → transcribe
 *   discard   — nothing intelligible ever arrived → drop, don't transcribe
 */

export interface VadConfig {
  /** RMS above this counts as speech starting. */
  startThreshold: number;
  /** RMS below this counts as silence (hysteresis: lower than start). */
  stopThreshold: number;
  /** Silence this long after speech → stop (auto-send). */
  silenceMs: number;
  /** Hard cap on one utterance → stop. */
  maxUtteranceMs: number;
  /** No speech at all for this long → discard. */
  noSpeechMs: number;
}

export const DEFAULT_VAD: VadConfig = {
  startThreshold: 0.015,
  stopThreshold: 0.008,
  silenceMs: 1500,
  maxUtteranceMs: 30_000,
  noSpeechMs: 8_000,
};

export type VadVerdict = 'waiting' | 'speaking' | 'stop' | 'discard';

export interface VadTracker {
  /** Feed one RMS sample; returns the current verdict. */
  update: (rms: number, nowMs: number) => VadVerdict;
  hadSpeech: () => boolean;
}

export function createVadTracker(startMs: number, config: VadConfig = DEFAULT_VAD): VadTracker {
  let speechStartedAt: number | null = null;
  let lastLoudAt: number | null = null;

  return {
    hadSpeech: () => speechStartedAt !== null,
    update(rms: number, nowMs: number): VadVerdict {
      if (speechStartedAt === null) {
        if (rms >= config.startThreshold) {
          speechStartedAt = nowMs;
          lastLoudAt = nowMs;
          return 'speaking';
        }
        return nowMs - startMs >= config.noSpeechMs ? 'discard' : 'waiting';
      }

      if (rms >= config.stopThreshold) lastLoudAt = nowMs;

      if (nowMs - speechStartedAt >= config.maxUtteranceMs) return 'stop';
      if (lastLoudAt !== null && nowMs - lastLoudAt >= config.silenceMs) return 'stop';
      return 'speaking';
    },
  };
}
