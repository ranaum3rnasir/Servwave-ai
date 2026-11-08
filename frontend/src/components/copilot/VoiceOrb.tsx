import { useEffect, useState } from 'react';
import { Mic, MicOff, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useCopilotStore } from '@/stores/copilotStore';
import { useCopilot } from './CopilotContext';
import type { VoiceState } from './voice/voiceState';

/**
 * Rotating halo sweep. Kept as a const (not a literal in `style`) so the whole
 * effect reads from the token layer - --ai-600 is the AI indigo, --ai-300 its
 * highlight. Channel-format tokens, so `rgb(var(--x) / a)` is the alpha form.
 */
const HALO_SWEEP =
  'conic-gradient(from 0deg, rgb(var(--ai-600) / 0) 0%, rgb(var(--ai-600) / 0.6) 18%, rgb(var(--ai-300)) 32%, rgb(var(--ai-600) / 0) 55%, rgb(var(--ai-600) / 0.4) 78%, rgb(var(--ai-600) / 0) 100%)';

/** Breathing core fills, one per voice state. Same token rule as the halo. */
const CORE_ERROR =
  'radial-gradient(circle at 35% 30%, rgb(var(--danger) / 0.95), rgb(var(--danger) / 0.55) 60%, rgb(var(--danger) / 0.18))';
const CORE_SPEAKING =
  'radial-gradient(circle at 35% 30%, rgb(var(--ai-300)), rgb(var(--ai-600)) 55%, rgb(var(--ai-600) / 0.4))';
const CORE_IDLE =
  'radial-gradient(circle at 35% 30%, rgb(var(--ai-300)), rgb(var(--ai-600) / 0.85) 55%, rgb(var(--ai-600) / 0.28))';

const LABEL: Record<VoiceState, string> = {
  idle: 'Tap the orb to talk',
  connecting: 'Connecting…',
  listening: 'Listening — just talk',
  thinking: 'Thinking…',
  speaking: 'Speaking',
  error: 'Voice hiccup — tap to retry',
};

/**
 * The Servy orb — a layered, Jarvis-style presence that is also the voice
 * button (tap = start/stop talking).
 *
 *   halo     rotating conic lavender gradient (speed = how busy Servy is)
 *   ripples  expanding rings while listening/speaking
 *   core     radial lavender glow that breathes; while listening it scales
 *            with the LIVE mic level, so you can see Servy hear you
 *
 * `prefers-reduced-motion` collapses the motion to a static badge (motion-safe).
 */
export default function VoiceOrb() {
  const voiceState = useCopilotStore((s) => s.voiceState);
  const micLevel = useCopilotStore((s) => s.micLevel);
  const micActive = useCopilotStore((s) => s.micActive);
  const { startVoice, stopVoice } = useCopilot();

  // Smooth the raw RMS a little so the core doesn't twitch.
  const [smooth, setSmooth] = useState(0);
  useEffect(() => {
    setSmooth((prev) => prev + (micLevel - prev) * 0.55);
  }, [micLevel]);

  const listening = voiceState === 'listening';
  const thinking = voiceState === 'thinking' || voiceState === 'connecting';
  const speaking = voiceState === 'speaking';
  const error = voiceState === 'error';

  const coreScale = listening ? 1 + Math.min(smooth * 3.2, 0.45) : 1;

  return (
    <div className="flex flex-col items-center gap-3 py-5">
      {/* The Servy orb - a 112px circular voice control with layered rotating-halo, ripple
          and mic-reactive core effects. Not Button-shaped by any measure. Deferred. */}
      <button
        type="button"
        aria-label={micActive ? 'Stop voice' : 'Talk to Servy'}
        aria-pressed={micActive}
        onClick={() => (micActive ? stopVoice() : void startVoice())}
        className="group relative flex h-28 w-28 items-center justify-center rounded-full outline-none transition-transform focus-visible:ring-2 focus-visible:ring-ai-500/70 active:scale-95"
      >
        {/* Rotating gradient halo */}
        <div
          aria-hidden
          className={cn(
            'absolute inset-0 rounded-full opacity-90 transition-opacity',
            thinking ? 'motion-safe:animate-servy-rotate-fast' : 'motion-safe:animate-servy-rotate',
            error && 'opacity-30',
          )}
          style={{
            background: HALO_SWEEP,
            WebkitMask: 'radial-gradient(closest-side, transparent 70%, black 72%)',
            mask: 'radial-gradient(closest-side, transparent 70%, black 72%)',
          }}
        />

        {/* Ripples while it hears you / talks to you */}
        {(listening || speaking) && (
          <>
            <span
              aria-hidden
              className="absolute inset-1 rounded-full border-2 border-ai-500/60 motion-safe:animate-servy-ripple"
            />
            <span
              aria-hidden
              className="absolute inset-1 rounded-full border-2 border-ai-500/35 motion-safe:animate-servy-ripple"
              style={{ animationDelay: '0.8s' }}
            />
          </>
        )}

        {/* Breathing core, mic-level reactive while listening */}
        <div
          aria-hidden
          className={cn(
            'absolute inset-3.5 rounded-full transition-transform duration-150 ease-out motion-safe:animate-servy-breathe group-hover:brightness-110',
            error && '!animate-none',
          )}
          style={{
            transform: `scale(${coreScale})`,
            background: error ? CORE_ERROR : speaking ? CORE_SPEAKING : CORE_IDLE,
            boxShadow: error
              ? '0 0 34px rgb(var(--danger) / 0.45)'
              : `0 0 ${listening ? 30 + smooth * 180 : 26}px rgb(var(--ai-600) / ${listening ? 0.65 : 0.45})`,
          }}
        />

        {/* Icon */}
        <div className="relative z-10 text-on-fill drop-shadow-md">
          {error ? (
            <AlertTriangle className="h-8 w-8" aria-hidden />
          ) : voiceState === 'idle' ? (
            <MicOff className="h-8 w-8 opacity-90" aria-hidden />
          ) : speaking ? (
            <SpeakingBars />
          ) : (
            <Mic className="h-8 w-8" aria-hidden />
          )}
        </div>
      </button>

      <span
        role="status"
        aria-live="polite"
        className={cn('text-xs font-medium tracking-wide', error ? 'text-danger-on-dark' : 'text-on-fill/55')}
      >
        {LABEL[voiceState]}
      </span>
    </div>
  );
}

/** Tiny equalizer while Servy talks. */
function SpeakingBars() {
  return (
    <div className="flex h-8 items-center gap-[3px]" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="w-[3px] rounded-full bg-on-fill motion-safe:animate-servy-dot"
          style={{ height: `${[15, 24, 19, 11][i]}px`, animationDelay: `${i * 0.15}s` }}
        />
      ))}
    </div>
  );
}
