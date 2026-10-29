import { useEffect, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { cn } from '@/lib/utils';
import { agentMedia } from '@/lib/ai-center/media';

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';

function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {};
  const mq = window.matchMedia(REDUCED_MOTION);
  mq.addEventListener?.('change', onChange);
  return () => mq.removeEventListener?.('change', onChange);
}
function readReducedMotion(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(REDUCED_MOTION).matches
    : false;
}

/** True while the OS asks for reduced motion. Follows the setting live. */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReducedMotion, readReducedMotion, () => false);
}

/**
 * True while `el` is on screen (with a small margin, so a loop is ready as it scrolls in). The
 * observer uses the viewport as its root, which also clips by every scrolling ancestor, so a card
 * scrolled out of the catalog's own scroll area counts as off screen. No IntersectionObserver
 * (old browsers, jsdom) means never on screen: the still stays, which is the safe answer.
 */
function useOnScreen(el: HTMLElement | null, enabled: boolean): boolean {
  const [onScreen, setOnScreen] = useState(false);
  const watching = enabled && !!el && typeof IntersectionObserver !== 'undefined';
  useEffect(() => {
    if (!watching || !el) return;
    const io = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setOnScreen(entry.isIntersecting);
      },
      { rootMargin: '120px 0px' },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      setOnScreen(false);
    };
  }, [el, watching]);
  return watching && onScreen;
}

/**
 * The loop layer. Mounted only while the loop should play, so its "has it decoded yet" state
 * starts fresh every time it comes back on screen: it stays transparent over the still until the
 * first frame is ready, then fades in. Unmounting it stops the animation's decode work.
 */
function LoopLayer({
  src,
  size,
  imgStyle,
  onFail,
}: {
  src: string;
  size: number;
  imgStyle: CSSProperties | undefined;
  onFail: () => void;
}) {
  const [ready, setReady] = useState(false);
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      width={size}
      height={size}
      decoding="async"
      draggable={false}
      onLoad={() => setReady(true)}
      onError={onFail}
      style={imgStyle}
      className={cn(
        'absolute inset-0 h-full w-full object-cover transition-opacity duration-200 ease-out',
        ready ? 'opacity-100' : 'opacity-0',
      )}
    />
  );
}

export interface AgentPortraitProps {
  /** The agent id from `agents.ts`; it picks the files (see `agentMedia`). */
  agentId: string;
  /** The animal's name. Used as the image's alt text. */
  name: string;
  /** Rendered width and height in px. */
  size: number;
  /** `circle` (default) for avatars and cards, `square` for a stage or hero. */
  shape?: 'circle' | 'square';
  /**
   * Allow the idle loop. Off for surfaces that stay still (the job page tiles, D8) and for the
   * catalog grid while a modal covers it. Reduced motion and being off screen also keep the still.
   */
  animate?: boolean;
  /**
   * Hide the image from assistive tech, for a portrait whose name is already the visible label
   * right next to it (a card or chip), so a screen reader does not hear the name twice.
   */
  decorative?: boolean;
  /** Scale the art inside its frame (1 = the full animal), anchored a little above centre. */
  zoom?: number;
  className?: string;
  style?: CSSProperties;
}

/**
 * An AI Farm agent's portrait: the still poster first, swapped for the animal's idle loop only
 * while it is on screen and motion is allowed. The loop fades in over the still once it has
 * decoded, so there is never a blank frame, and it is removed again when the portrait scrolls
 * away, so off-screen cards cost nothing to animate.
 */
export function AgentPortrait({
  agentId,
  name,
  size,
  shape = 'circle',
  animate = true,
  decorative = false,
  zoom = 1,
  className,
  style,
}: AgentPortraitProps) {
  const media = agentMedia(agentId);
  const reducedMotion = usePrefersReducedMotion();
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  // Remembered per agent id, so a portrait reused for another agent tries that agent's loop.
  const [failedLoop, setFailedLoop] = useState<string | null>(null);
  const wantsLoop = !!media.loop && animate && !reducedMotion && failedLoop !== media.loop;
  const onScreen = useOnScreen(el, wantsLoop);
  const playing = wantsLoop && onScreen;

  // The still always carries the name; the loop is a visual layer over it, so it is never
  // announced a second time.
  const alt = decorative ? '' : name;
  const imgStyle: CSSProperties | undefined =
    zoom === 1 ? undefined : { transform: `scale(${zoom})`, transformOrigin: '50% 40%' };

  return (
    <span
      ref={setEl}
      data-agent-portrait={agentId}
      data-playing={playing ? 'true' : 'false'}
      aria-hidden={decorative || undefined}
      className={cn(
        'relative inline-block shrink-0 overflow-hidden bg-surface-light',
        shape === 'circle' ? 'rounded-full' : 'rounded-md',
        className,
      )}
      style={{ width: size, height: size, ...style }}
    >
      <img
        src={media.still}
        alt={alt}
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        draggable={false}
        style={imgStyle}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {playing && media.loop && (
        <LoopLayer
          key={media.loop}
          src={media.loop}
          size={size}
          imgStyle={imgStyle}
          onFail={() => setFailedLoop(media.loop)}
        />
      )}
    </span>
  );
}
