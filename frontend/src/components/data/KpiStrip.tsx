/**
 * KpiStrip / KpiTile — the one KPI summary used across the whole app.
 *
 * Design: ServWave "KPI cards — the one standard" — value-first.
 *   uppercase 11px/700 tracked label (muted)
 *     → 26px/800 value (tabular-nums; tone-colored only when it signals state)
 *       → optional <TrendDelta> glyph beside the value
 *         → 12px muted caption.
 * White surface, 6px radius (rounded-card), border-border, shadow-card, 18px padding.
 * Interactive tiles (onClick) act as filters and show a ring when `active`.
 *
 * - ALPHA pages render <KpiStrip items={[...]} /> (grid of tiles).
 * - Pages with a custom layout can render individual <KpiTile /> in their own grid.
 */
import type { CSSProperties, ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TrendDelta } from './TrendDelta';

/**
 * What the tile MEANS, never what colour it is. Call sites pass one of these;
 * the mapping to a token lives below and nowhere else.
 */
export type KpiTone =
  | 'neutral'
  | 'strong'
  | 'primary'
  | 'success'
  | 'warning'
  | 'danger'
  | 'info';

const TONE: Record<KpiTone, string> = {
  neutral: 'text-text-secondary',
  strong: 'text-text-primary',
  primary: 'text-primary',
  success: 'text-success',
  warning: 'text-warning',
  danger: 'text-danger',
  info: 'text-info',
};

export interface KpiTileProps {
  icon: LucideIcon;
  label: string;
  value: ReactNode;
  sub?: string;
  /** What the tile means. The only appearance input a call site may give. */
  tone?: KpiTone;
  /** Layout-only (width/margin/grid placement) — e.g. a parent grid's col-span. */
  className?: string;
  /** Value text takes the accent color (money / alert emphasis). */
  emphasize?: boolean;
  /** Optional trend chip beside the value, e.g. "+12%". Renders a <TrendDelta> when set. */
  delta?: string;
  /** Direction of the trend chip. Defaults to 'up'. */
  deltaDirection?: 'up' | 'down';
  /** This tile is currently driving a filter/sort → ring. */
  active?: boolean;
  /** Text of the active pill. When omitted, NO pill renders (servwave list-page behavior). */
  activeLabel?: string;
  onClick?: () => void;
  /** Show a skeleton in place of the value. */
  loading?: boolean;
}

export function KpiTile({
  icon: Icon,
  label,
  value,
  sub,
  tone = 'neutral',
  emphasize,
  delta,
  deltaDirection = 'up',
  active,
  activeLabel,
  onClick,
  loading,
  className,
}: KpiTileProps) {
  const resolvedAccent = TONE[tone];
  const interactive = !!onClick;
  const Wrapper = interactive ? 'button' : 'div';

  return (
    <Wrapper
      {...(interactive ? { type: 'button' as const, onClick } : {})}
      className={cn(
        'flex min-h-[104px] flex-col justify-between gap-2 rounded-card border bg-surface-light p-[18px] text-left shadow-card transition',
        active
          ? 'border-primary/40 ring-2 ring-primary/15'
          : 'border-border',
        interactive && !active && 'hover:border-primary/30 hover:bg-background-light',
        className
      )}
    >
      <p className="flex items-start gap-1.5 text-[11px] font-bold uppercase tracking-wider text-text-secondary">
        <Icon className={cn('h-3.5 w-3.5 shrink-0', resolvedAccent)} />
        <span className="min-w-0 leading-tight">{label}</span>
        {active && activeLabel && (
          <span className="shrink-0 rounded-card bg-primary px-1.5 py-0.5 text-[9px] font-bold uppercase leading-none text-on-fill">
            {activeLabel}
          </span>
        )}
      </p>
      <div className="min-w-0">
        {loading ? (
          <div className="h-[26px] w-16 animate-pulse rounded-card bg-background-light" />
        ) : (
          <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <p
              className={cn(
                'text-[26px] font-extrabold leading-none tabular-nums',
                emphasize ? resolvedAccent : 'text-text-primary'
              )}
            >
              {value}
            </p>
            {delta && (
              <span className="self-center">
                <TrendDelta value={delta} direction={deltaDirection} />
              </span>
            )}
          </div>
        )}
        {sub && <p className="mt-1.5 text-xs leading-tight text-text-secondary">{sub}</p>}
      </div>
    </Wrapper>
  );
}

export interface KpiStripProps {
  items: KpiTileProps[];
  /** Strip-level loading → every tile shows a skeleton. */
  loading?: boolean;
  className?: string;
  /** Cap the xl single-row column count; extra tiles wrap to new rows. Defaults to items.length (current behavior). */
  maxColumns?: number;
}

export function KpiStrip({ items, loading, className, maxColumns }: KpiStripProps) {
  const columns = Math.min(items.length, maxColumns ?? items.length);
  return (
    <div
      className={cn(
        'grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-4 xl:[grid-template-columns:repeat(var(--kpi-n),minmax(0,1fr))]',
        className
      )}
      style={{ '--kpi-n': columns } as CSSProperties}
    >
      {items.map((item) => (
        <KpiTile key={item.label} {...item} loading={loading ?? item.loading} />
      ))}
    </div>
  );
}
