import type { ReactNode } from 'react';
import { TrendDelta } from '@/components/data/TrendDelta';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { useFitToWidth } from '@/ui-kit/lib/useFitToWidth';

/** The smallest the figure is set when its tile is too narrow for it (a two-up tile at 200% text). */
const VALUE_FLOOR_PX = 12;

/**
 * The KPI figure, on ONE line and never cut off. It is a size in rem so 200% text enlarges it,
 * but a two-up tile is only ~160 px wide on a phone, so a figure like "$1,985/mo" is wider than
 * the tile at that size. It is not allowed to break inside the number ("$1,985/" over "mo" reads
 * as a different amount) and the tile's `overflow-hidden` would clip it, so it is set smaller, in
 * steps, until it fits (see `useFitToWidth`, the same rule the list pages' stat cards follow).
 * `min-w-0 max-w-full` lets the flex item be narrower than its text, which is what lets the fit
 * see the overflow at all.
 */
function FittedValue({ className, children }: { className: string; children: string }) {
  const ref = useFitToWidth(VALUE_FLOOR_PX, children);
  return (
    <span ref={ref} data-slot="kpi-value" className={`min-w-0 max-w-full whitespace-nowrap ${className}`}>
      {children}
    </span>
  );
}

export interface KpiCardProps {
  icon: ReactNode;
  iconBg: string; // tailwind bg class for the icon chip
  label: string;
  /** The word the server sends when the figure is not the whole company's ("Yours", "Your team"). */
  scopeLabel?: string | null;
  value: string; // pre-formatted
  meta?: ReactNode;
  delta?: { value: number; good: boolean; suffix?: string } | null;
  valueClass?: string;
  /** Opens the page the server sent for this tile. With none the tile is drawn but is not clickable. */
  onClick?: () => void;
  /**
   * A plain line to show instead of the figure when the tile has nothing to show ("No jobs today"). Set only once the
   * answer has landed, so it is never claimed while the value is still loading.
   */
  empty?: string;
  /** First fetch only (see WidgetRenderCtx.isLoading) - shows skeleton bars instead of the value. */
  loading?: boolean;
}

/**
 * Generic KPI card — used for every KPI cell via the registry. Aligned to the
 * ServWave "KPI — the one standard": value-first, with the canonical
 * <TrendDelta> glyph chip beside the value (rising/falling line, success/danger
 * tinted). Direction follows the sign; color follows `good`.
 */
export default function KpiCard({ icon, iconBg, label, scopeLabel, value, meta, delta, valueClass = 'text-text-primary', onClick, loading, empty }: KpiCardProps) {
  const showDelta = delta && delta.value !== 0;
  // A tile the server sent no address for is not a control: same box, no button (and no hover lift, which only an
  // enabled button gets).
  const Tag = onClick ? 'button' : 'div';
  return (
    // Composed clickable card (icon+label, value, delta chip, meta as a laid-out grid), not a
    // text/icon Button control - the grid-tile equivalent of the excluded list-row click
    // target shape, left raw per the program's non-Button-shape carve-out.
    //
    // `disabled` while loading: the value isn't in yet, so there is nothing for
    // a click to act on. Same tag and padding either way so the tile doesn't
    // change shape when the real content lands.
    <Tag
      {...(onClick ? { type: 'button' as const, onClick, disabled: loading } : {})}
      // The tile is a size container (mobile slice 18): at 200% text a two-up tile is only a few
      // words wide, and a viewport breakpoint cannot see that (a rem media query reads the
      // browser's default size, not the page's). `rem` in a container query follows the page's
      // own root size, so below 7rem the icon stacks above the label and the padding halves.
      className="w-full min-w-0 overflow-hidden text-left bg-surface-light rounded-card border border-border h-full transition-all [container-type:inline-size] enabled:hover:shadow-hover enabled:hover:-translate-y-0.5 disabled:cursor-default"
    >
      <div className="p-4 [@container(max-width:7rem)]:p-2">
      <div className="flex items-center gap-2 mb-2.5 [@container(max-width:7rem)]:flex-col [@container(max-width:7rem)]:items-start [@container(max-width:7rem)]:gap-1">
        <span className="shrink-0">{icon}</span>
        {/* The title and the scope chip wrap as a group: when both do not fit on a line the chip drops
            below the title, so the title keeps the whole width and breaks between words. Left as two
            siblings of the icon, the chip (which never shrinks) squeezed the title to a few letters and
            it broke inside a word ("Complete / d jobs value"). `break-words` stays as the last resort for
            one word wider than the whole tile, which would otherwise be cut off by its `overflow-hidden`. */}
        <div data-slot="kpi-heading" className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <p className="min-w-0 break-words text-xs font-medium text-text-secondary">{label}</p>
          {scopeLabel && <Badge variant="softNeutral" size="sm" className="shrink-0">{scopeLabel}</Badge>}
        </div>
      </div>
      {loading ? (
        <>
          <Skeleton className="mb-1 h-[26px] w-16" />
          {meta !== undefined && <Skeleton className="h-3.5 w-24" />}
        </>
      ) : empty ? (
        <p className="min-w-0 break-words text-sm font-medium text-text-secondary">{empty}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 mb-1">
            {/* The value NEVER truncates and never breaks inside the number - it is the one
                thing a KPI tile exists to show. It is set smaller until it fits its tile
                (FittedValue); the smaller size at/below `xl` is the first step of that, and
                `flex-wrap` on the row is the fallback for the pair as a whole - if the delta
                chip doesn't fit beside the value on one line, it drops to its own line below
                rather than either being clipped or squeezing the value. */}
            <FittedValue className={`text-[1.25rem] xl:text-[1.625rem] font-bold tabular-nums tracking-[-1px] leading-none ${valueClass}`}>{value}</FittedValue>
            {showDelta && (
              <span className="self-center shrink-0">
                <TrendDelta
                  value={`${Math.abs(delta.value)}${delta.suffix ?? ''}`}
                  direction={delta.value > 0 ? 'up' : 'down'}
                  // Tone is driven by `good` (semantic), not by the arrow direction -
                  // a falling cost can be good. TrendDelta keeps glyph (sign) and
                  // tint (good/bad) independent for exactly this case.
                  tone={delta.good ? 'success' : 'danger'}
                />
              </span>
            )}
          </div>
          {meta && <p className="min-w-0 break-words text-xs text-text-secondary">{meta}</p>}
        </>
      )}
      </div>
    </Tag>
  );
}
