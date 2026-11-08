/**
 * TrendDelta — the canonical KPI trend-delta glyph (ServWave "KPI — the one standard").
 *
 * A mini line-graph glyph (inline SVG) beside a value, in a tinted 6px chip:
 *   - up   → rising line  + green   (text-success, bg-success/10)
 *   - down → falling line + terracotta (text-danger, bg-danger/10)
 *
 * The SVG uses `currentColor`, so the glyph inherits the chip's text color.
 */
import { cn } from '@/lib/utils';

export interface TrendDeltaProps {
  /** Display value, e.g. "+12%" or "3.2pts". */
  value: string;
  direction: 'up' | 'down';
  /**
   * Overrides the default direction-based tint. Glyph shape always follows
   * `direction`; tint defaults to matching it (up green, down terracotta)
   * but a falling cost is still good - callers with that kind of metric
   * pass `tone` to decouple the two.
   */
  tone?: 'success' | 'danger';
  className?: string;
}

/** Rising mini line-graph (up). Mirrored vertically for the falling (down) glyph. */
const UP_PATH = 'M1 9 L4 6 L6.5 7.5 L11 2.5';
const DOWN_PATH = 'M1 3 L4 6 L6.5 4.5 L11 9.5';
/** Arrow-head tip at the end of the line. */
const UP_HEAD = 'M11 2.5 L8 2.5 M11 2.5 L11 5.5';
const DOWN_HEAD = 'M11 9.5 L8 9.5 M11 9.5 L11 6.5';

export function TrendDelta({ value, direction, tone, className }: TrendDeltaProps) {
  const up = direction === 'up';
  const resolvedTone = tone ?? (up ? 'success' : 'danger');
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-card px-1.5 py-0.5 text-xs font-semibold tabular-nums',
        resolvedTone === 'success' ? 'text-success bg-success/10' : 'text-danger bg-danger/10',
        className
      )}
    >
      <svg
        viewBox="0 0 12 12"
        className="h-3 w-3 shrink-0"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d={up ? UP_PATH : DOWN_PATH} />
        <path d={up ? UP_HEAD : DOWN_HEAD} />
      </svg>
      {value}
    </span>
  );
}
