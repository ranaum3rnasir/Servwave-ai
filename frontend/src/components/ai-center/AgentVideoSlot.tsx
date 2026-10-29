import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';
import { useMediaQuery } from '@/ui-kit/hooks/useMediaQuery';
import { agentMedia } from '@/lib/ai-center/media';
import type { AIAgent } from '@/lib/ai-center/agents';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

/**
 * True while `el` is on screen and the tab is in front. The loop is an animated image, which has
 * no pause, so "paused" means taking the loop layer away and leaving the still. Without
 * IntersectionObserver (old browsers, jsdom) the slot never counts as on screen, the same safe
 * answer AgentPortrait gives: the still stays.
 */
function usePlayable(el: HTMLElement | null, enabled: boolean): boolean {
  const [inView, setInView] = useState(false);
  const [tabVisible, setTabVisible] = useState(
    () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  );
  const watching = enabled && !!el && typeof IntersectionObserver !== 'undefined';

  useEffect(() => {
    if (!watching || !el) return;
    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) setInView(entry.isIntersecting);
    });
    io.observe(el);
    return () => {
      io.disconnect();
      setInView(false);
    };
  }, [el, watching]);

  useEffect(() => {
    const onChange = () => setTabVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onChange);
    return () => document.removeEventListener('visibilitychange', onChange);
  }, []);

  return watching && inView && tabVisible;
}

const heroCls =
  'absolute bottom-0 left-1/2 aspect-square h-full -translate-x-1/2 select-none object-contain mix-blend-multiply';

/**
 * The loop, layered over the still and faded in once its first frame has decoded. Both images
 * multiply onto the wash, so the still is hidden while the loop shows (two multiplied frames of a
 * blinking animal would ghost); `onReady(false)` on unmount brings the still back.
 */
function LoopLayer({ src, ready, onReady, onFail }: {
  src: string;
  ready: boolean;
  onReady: (ready: boolean) => void;
  onFail: () => void;
}) {
  useEffect(() => () => onReady(false), [onReady]);
  return (
    <img
      src={src}
      alt=""
      data-motion="loop"
      decoding="async"
      draggable={false}
      onLoad={() => onReady(true)}
      onError={onFail}
      className={cn(heroCls, 'transition-opacity duration-300 ease-out', ready ? 'opacity-100' : 'opacity-0')}
    />
  );
}

/**
 * The detail modal's 16:9 video slot. The feature videos are not made yet (redesign §6, 29 Sep:
 * the reel was dropped for them), so until one exists the slot shows the animal's ordinary loop,
 * large, on a wash of its own colour, marked "Feature video coming soon". There is no play button:
 * nothing plays until a video exists. Reduced motion, an off-screen slot, a hidden tab or a loop
 * that fails to load all leave the still frame.
 */
export function AgentVideoSlot({ agent }: { agent: AIAgent }) {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const reducedMotion = useMediaQuery(REDUCED_MOTION);
  const media = agentMedia(agent.id);
  const [failedLoop, setFailedLoop] = useState<string | null>(null);
  const wantsLoop = !!media.loop && !reducedMotion && failedLoop !== media.loop;
  const playing = usePlayable(el, wantsLoop);
  const [loopReady, setLoopReady] = useState(false);
  const showLoop = playing && loopReady;

  return (
    <div
      ref={setEl}
      data-testid="agent-video-slot"
      data-playing={playing ? 'true' : 'false'}
      className="relative aspect-video w-full overflow-hidden rounded-card"
      style={{
        // A soft light behind the animal, on a 14% wash of the agent's own colour.
        background: `radial-gradient(60% 70% at 50% 60%, rgb(var(--surface-light) / 0.75), transparent 70%), color-mix(in srgb, ${agent.avatarColor} 14%, rgb(var(--surface-light)))`,
      }}
    >
      {/* Decorative: the animal is named in the header right above. multiply drops the art's
          white backdrop onto the colour wash. */}
      <img
        src={media.still}
        alt=""
        data-motion="still"
        decoding="async"
        draggable={false}
        className={cn(
          heroCls,
          'transition-opacity duration-300 ease-out',
          showLoop ? 'opacity-0' : 'opacity-100',
          // The Master Agent's still is a small flat portrait, not a 272 px animal frame: shown at
          // full slot height it blurs, so it sits smaller, centred, in the same circle its card uses.
          !media.loop && 'bottom-[20%] h-[60%] rounded-full object-cover',
        )}
      />
      {playing && media.loop && (
        <LoopLayer
          key={media.loop}
          src={media.loop}
          ready={loopReady}
          onReady={setLoopReady}
          onFail={() => {
            setLoopReady(false);
            setFailedLoop(media.loop);
          }}
        />
      )}
      <span className="absolute bottom-3 left-3 rounded-full bg-surface-light/95 px-2.5 py-1 text-xs font-semibold text-text-primary shadow-card">
        Feature video coming soon
      </span>
    </div>
  );
}
