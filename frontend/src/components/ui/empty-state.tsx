import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * Vocabulary-standard spacing scale (program plan section 2a, rev 3): `padY`
 * is a 4px-grid numeric step, not a size word - VOCAB_V3 rule "Do NOT use
 * none/xs/sm/md/lg/xl as pad or gap values anywhere." `12` (48px) is always
 * the default and always today's rendered geometry. `0`/`6`/`12`/`24` are the
 * exact four pixel values the retired `density` prop below already shipped
 * (flush/compact/default/roomy = 0/24/48/96px), per the explicit EmptyState
 * remap table in the settled vocabulary, so moving a call site from
 * `density` to `padY` cannot move a pixel. No other step is minted here -
 * rule 5 ("a cell/prop is only added where measured demand exists") applies:
 * 132 real call sites were grepped and none need a fifth or sixth step.
 * Named `padY` (not `pad`) because EmptyState only ever controls vertical
 * padding - `variant="card"` owns the horizontal px-6, and there is no
 * horizontal axis on this component to collide with (see heading.tsx's own
 * naming-rationale doc comment, which lists this as Card's `pad` vs
 * EmptyState's `padY`).
 */
const EMPTY_STATE_PAD = {
  0: 'py-0',
  6: 'py-6',
  12: 'py-12',
  24: 'py-24',
} as const

/**
 * @deprecated Retired into `padY` (program plan section 2a lists `density`
 * among the names this vocabulary retires). Kept as a working alias so the
 * ~28 existing `density=` call sites (flush x12, compact x14, roomy x2) do
 * not have to move - this session touches zero call sites outside
 * components/ui/. Removed in phase 12c along with the rest of the retired
 * names. A plain string-literal union, not an object map like
 * `EMPTY_STATE_PAD` above - the four `density` words never resolve to a
 * class string on their own, only through `DENSITY_TO_PAD` below, so there
 * is no runtime value here to hold, just the type.
 */
type EmptyStateDensity = 'flush' | 'compact' | 'default' | 'roomy'

/** Same pixels, old word -> new numeric step. Used only to resolve the
 *  deprecated `density` prop into a `padY` step when `padY` itself is not
 *  passed. Numeric keys, per the settled vocabulary's explicit EmptyState
 *  remap table (flush -> 0, compact -> 6, default -> 12, roomy -> 24). */
const DENSITY_TO_PAD: Record<EmptyStateDensity, keyof typeof EMPTY_STATE_PAD> = {
  flush: 0,
  compact: 6,
  default: 12,
  roomy: 24,
}

interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: string;
  action?: ReactNode;
  /**
   * 'bare' has no chrome of its own - drop it inside any container (a
   * `<td colSpan>`, a dropdown's results panel, a page section). 'card' adds
   * bordered chrome for a standalone empty page state. Default 'bare'.
   */
  variant?: 'bare' | 'card';
  /**
   * Vertical padding, a 4px-grid numeric step (`padY={6}` is 24px) from the
   * shared spacing scale - not a size word. Orthogonal to `variant` -
   * `variant="card"` owns border/radius/surface/px-6 only, never vertical
   * padding. Default `12` (py-12, 48px), the single most common override
   * value in the tree before this prop existed - byte-identical to the old
   * implicit default. Overrides `density` when both are passed.
   */
  padY?: keyof typeof EMPTY_STATE_PAD;
  /**
   * @deprecated Use `padY`: flush -> 0, compact -> 6, default -> 12,
   * roomy -> 24. Same pixels. Ignored when `padY` is also passed.
   */
  density?: EmptyStateDensity;
  /** Layout-only (width/margin) - e.g. a report page's `max-w` clamp. */
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = 'bare',
  padY,
  density = 'default',
  className,
}: EmptyStateProps) {
  const resolvedPad = padY ?? DENSITY_TO_PAD[density];
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-2 text-center',
        EMPTY_STATE_PAD[resolvedPad],
        variant === 'card' && 'rounded-card border border-dashed border-border bg-surface-light px-6',
        className
      )}
    >
      {Icon && (
        <div className="flex h-11 w-11 items-center justify-center rounded-ic bg-background-light">
          <Icon className="h-5 w-5 text-text-secondary" aria-hidden />
        </div>
      )}
      <div className="space-y-1">
        <p className="text-sm font-semibold text-text-primary">{title}</p>
        {description && <p className="max-w-sm text-sm text-text-secondary">{description}</p>}
      </div>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
