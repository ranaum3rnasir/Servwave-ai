import type { ReactNode } from 'react';
import { Heading } from '@/components/ui/heading';
import { formatCurrencyWhole } from '@/lib/utils';

/** Whole-dollar currency (no trailing cents) for headline figures. Org-aware (#126). */
export const money0 = (n: number): string => formatCurrencyWhole(n);

/**
 * Money formatter for the dashboard. ServWave never abbreviates currency with
 * k/M — always full comma-grouped whole dollars. Kept as a named export so the
 * existing call sites stay unchanged while the output becomes full numbers.
 */
export const compactCurrency = (n: number): string => formatCurrencyWhole(n);

/** Standard widget card shell: white card, optional header with title + right slot. */
export function WidgetCard({
  title,
  icon,
  right,
  children,
  className = '',
}: {
  title?: string;
  icon?: ReactNode;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`bg-surface-light rounded-xl border border-border overflow-hidden h-full ${className}`}>
      {title && (
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-border">
          <div className="flex items-center gap-2">
            {icon}
            <Heading level={2}>{title}</Heading>
          </div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}
