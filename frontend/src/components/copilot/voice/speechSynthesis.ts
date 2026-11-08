/**
 * Thin wrapper over the browser SpeechSynthesis (Web Speech API) for Servy's
 * spoken replies. Picks a voice matching the requested language when one is
 * installed, and no-ops gracefully where unsupported. Dependencies are
 * injectable so the orchestration can be unit-tested without a browser engine.
 */
export interface Speaker {
  /** Speak `text`; cancels any in-progress utterance first. */
  speak: (text: string, opts: { lang?: string; onStart?: () => void; onEnd?: () => void }) => void;
  cancel: () => void;
  supported: boolean;
}

export interface SpeakerDeps {
  synth?: SpeechSynthesis;
  UtteranceCtor?: typeof SpeechSynthesisUtterance;
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export function createSpeaker(deps: SpeakerDeps = {}): Speaker {
  const synth = deps.synth ?? (typeof window !== 'undefined' ? window.speechSynthesis : undefined);
  const Utterance = deps.UtteranceCtor ?? (typeof window !== 'undefined' ? window.SpeechSynthesisUtterance : undefined);
  const supported = Boolean(synth && Utterance);

  function pickVoice(lang: string): SpeechSynthesisVoice | undefined {
    if (!synth?.getVoices) return undefined;
    const voices = synth.getVoices();
    const norm = lang.toLowerCase();
    return (
      voices.find((v) => v.lang?.toLowerCase() === norm) ??
      voices.find((v) => v.lang?.toLowerCase().startsWith(norm.slice(0, 2)))
    );
  }

  return {
    supported,
    cancel: () => {
      try {
        synth?.cancel();
      } catch {
        /* noop */
      }
    },
    speak: (text, opts) => {
      if (!synth || !Utterance || !text.trim()) {
        opts.onEnd?.();
        return;
      }
      try {
        synth.cancel();
      } catch {
        /* noop */
      }
      const u = new Utterance(text);
      u.lang = opts.lang ?? 'en-US';
      const voice = pickVoice(u.lang);
      if (voice) u.voice = voice;
      u.rate = 1;
      u.pitch = 1;
      u.onstart = () => opts.onStart?.();
      u.onend = () => opts.onEnd?.();
      u.onerror = () => opts.onEnd?.();
      synth.speak(u);
    },
  };
}
