import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';

import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { cn } from '@/ui-kit/lib/utils';

/**
 * The report KPI row, on the kit's StatCard.
 *
 * Same item shape as `components/data/KpiStrip`, minus everything the kit card
 * has no home for. A KPI tile is now a title and a number - the owner's call -
 * so three of the legacy item's inputs are gone rather than forwarded:
 *
 *   sub              The legacy caption ("of 4,231 leads", "^ 12% vs last mo").
 *   delta /          The explicit trend pair. Both used to become StatCard's
 *   deltaDirection   chip; there is no chip.
 *
 * These three are REMOVED from the item type, not accepted and ignored. Every
 * report call site had to be visited to drop the caption, and a type error is
 * what took them there; leaving the keys declared would have left a caption
 * computed on every render and thrown away.
 *
 * `icon`, `tone`, `emphasize` and `activeLabel` ARE still accepted and ignored.
 * That is pre-existing and deliberate - they let the legacy KpiStrip item shape
 * port by changing one import - and is left as found.
 */
export interface ReportKpiItem {
  /** Accepted and ignored - see the note above. */
  icon?: LucideIcon;
  label: string;
  value: ReactNode;
  /** Accepted and ignored - see the note above. */
  tone?: 'neutral' | 'strong' | 'primary' | 'success' | 'warning' | 'danger' | 'info';
  /** Accepted and ignored - see the note above. */
  emphasize?: boolean;
  active?: boolean;
  activeLabel?: string;
  onClick?: () => void;
  loading?: boolean;
}

export interface ReportKpisProps {
  items: ReportKpiItem[];
  loading?: boolean;
  className?: string;
  /** Cap the wide-viewport column count. Defaults to the item count. */
  maxColumns?: number;
}

const COLUMNS: Record<number, string> = {
  1: 'xl:grid-cols-1',
  2: 'xl:grid-cols-2',
  3: 'xl:grid-cols-3',
  4: 'xl:grid-cols-4',
  5: 'xl:grid-cols-5',
  6: 'xl:grid-cols-6',
  7: 'xl:grid-cols-7',
  8: 'xl:grid-cols-8',
};

export function ReportKpis({ items, loading, className, maxColumns }: ReportKpisProps) {
  const columns = Math.min(items.length, maxColumns ?? items.length);
  return (
    <StatCardGroup className={cn(COLUMNS[columns] ?? COLUMNS[8], className)}>
      {items.map((item) => (
        <StatCard
          key={item.label}
          label={item.label}
          value={item.value}
          active={item.active}
          loading={loading ?? item.loading}
          onClick={item.onClick}
        />
      ))}
    </StatCardGroup>
  );
}
