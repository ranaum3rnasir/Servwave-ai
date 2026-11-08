/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi } from 'vitest';
import { createSpeaker } from '@/components/copilot/voice/speechSynthesis';

function makeFakeSynth(voices: Array<{ lang: string; name: string }> = []) {
  const spoken: any[] = [];
  const synth = {
    cancel: vi.fn(),
    getVoices: vi.fn(() => voices),
    speak: vi.fn((u: any) => spoken.push(u)),
  } as unknown as SpeechSynthesis;
  class FakeUtterance {
    text: string;
    lang = '';
    voice: any = null;
    rate = 1;
    pitch = 1;
    onstart: any = null;
    onend: any = null;
    onerror: any = null;
    constructor(t: string) {
      this.text = t;
    }
  }
  return { synth, UtteranceCtor: FakeUtterance as unknown as typeof SpeechSynthesisUtterance, spoken };
}

describe('createSpeaker', () => {
  it('is unsupported when synth/utterance are missing, but onEnd still resolves', () => {
    const sp = createSpeaker({ synth: undefined, UtteranceCtor: undefined });
    expect(sp.supported).toBe(false);
    const onEnd = vi.fn();
    sp.speak('hi', { onEnd });
    expect(onEnd).toHaveBeenCalled();
  });

  it('speaks text (cancelling any prior utterance) and fires onStart/onEnd', () => {
    const { synth, UtteranceCtor, spoken } = makeFakeSynth();
    const sp = createSpeaker({ synth, UtteranceCtor });
    const onStart = vi.fn();
    const onEnd = vi.fn();

    sp.speak('Four jobs today.', { lang: 'en-US', onStart, onEnd });

    expect(synth.cancel).toHaveBeenCalled(); // barge-in / no overlap
    expect(spoken).toHaveLength(1);
    const u = spoken[0];
    expect(u.text).toBe('Four jobs today.');
    expect(u.lang).toBe('en-US');
    u.onstart();
    u.onend();
    expect(onStart).toHaveBeenCalled();
    expect(onEnd).toHaveBeenCalled();
  });

  it('picks a voice matching the requested language', () => {
    const { synth, UtteranceCtor, spoken } = makeFakeSynth([
      { lang: 'en-US', name: 'English' },
      { lang: 'he-IL', name: 'Hebrew' },
    ]);
    const sp = createSpeaker({ synth, UtteranceCtor });
    sp.speak('שלום', { lang: 'he-IL', onEnd: vi.fn() });
    expect(spoken[0].voice).toEqual({ lang: 'he-IL', name: 'Hebrew' });
  });

  it('skips empty text but still resolves onEnd', () => {
    const { synth, UtteranceCtor, spoken } = makeFakeSynth();
    const sp = createSpeaker({ synth, UtteranceCtor });
    const onEnd = vi.fn();
    sp.speak('   ', { onEnd });
    expect(spoken).toHaveLength(0);
    expect(onEnd).toHaveBeenCalled();
  });
});
