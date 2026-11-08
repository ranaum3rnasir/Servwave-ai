/**
 * ClampedDescription — line item description clamped to N lines with a "more / less" toggle.
 *
 * The toggle only appears when the text actually overflows the clamp (measured with a
 * ResizeObserver), so short descriptions render clean with no affordance. Chosen over a
 * tooltip/hover because this lives on an edit surface (tooltips fire while aiming at inputs
 * and die on touch) and over full-wrap (a long description would blow up the table row).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

export interface ClampedDescriptionProps {
  text: string | null | undefined;
  /** Lines to show before clamping. Default 2. */
  lines?: number;
  className?: string;
}

export function ClampedDescription({ text, lines = 2, className }: ClampedDescriptionProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [truncated, setTruncated] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const check = () => setTruncated(el.scrollHeight > el.clientHeight + 1);
    check();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded, lines]);

  // Reset to collapsed when the text changes entirely.
  useEffect(() => setExpanded(false), [text]);

  if (!text) return null;

  return (
    <div className={className}>
      <p
        ref={ref}
        className={cn('text-xs leading-relaxed text-text-secondary', !expanded && 'overflow-hidden')}
        style={
          expanded
            ? undefined
            : { display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: lines }
        }
      >
        {text}
      </p>
      {(truncated || expanded) && (
        <Button
          type="button"
          variant="link"
          size={null}
          onClick={() => setExpanded((e) => !e)}
          className="mt-0.5"
        >
          {expanded ? 'less' : 'more'}
        </Button>
      )}
    </div>
  );
}
