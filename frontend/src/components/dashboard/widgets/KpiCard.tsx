import type { ReactNode } from 'react';
import { TrendDelta } from '@/components/data/TrendDelta';

export interface KpiCardProps {
  icon: ReactNode;
  iconBg: string; // tailwind bg class for the icon chip
  label: string;
  value: string; // pre-formatted
  meta?: ReactNode;
  delta?: { value: number; good: boolean; suffix?: string } | null;
  valueClass?: string;
  onClick: () => void;
}

/**
 * Generic KPI card — used for every KPI cell via the registry. Aligned to the
 * ServWave "KPI — the one standard": value-first, with the canonical
 * <TrendDelta> glyph chip beside the value (rising/falling line, success/danger
 * tinted). Direction follows the sign; color follows `good`.
 */
export default function KpiCard({ icon, iconBg, label, value, meta, delta, valueClass = 'text-text-primary', onClick }: KpiCardProps) {
  const showDelta = delta && delta.value !== 0;
  return (
    // Composed clickable card (icon+label, value, delta chip, meta as a laid-out grid), not a
    // text/icon Button control - the grid-tile equivalent of the excluded list-row click
    // target shape, left raw per the program's non-Button-shape carve-out.
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left bg-surface-light rounded-card border border-border p-4 transition-all hover:shadow-hover hover:-translate-y-0.5 h-full"
    >
      <div className="flex items-center gap-2 mb-2.5">
        <span className="shrink-0">{icon}</span>
        <p className="text-xs font-medium text-text-secondary">{label}</p>
      </div>
      <div className="flex items-baseline gap-2 mb-1">
        <span className={`text-[26px] font-bold tabular-nums tracking-[-1px] leading-none ${valueClass}`}>{value}</span>
        {showDelta && (
          <span className="self-center">
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
      {meta && <p className="text-xs text-text-secondary">{meta}</p>}
    </button>
  );
}
