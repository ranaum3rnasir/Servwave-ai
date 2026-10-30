import { ComposedChart, Bar, Cell, ReferenceLine, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import { BarChart2 } from 'lucide-react';

import { formatCurrency, formatCurrencyWhole } from '@/lib/utils';
import { token, chartPalette } from '@/design-system';
import type { RevenuePoint } from '@/lib/api/dashboard';
import { Button } from '@/ui-kit/components/ui/button';
import { EmptyState } from '@/ui-kit/components/data/emptyState';

import { WidgetCard } from '../components/widgetCard';

// Calm-Intelligence series colors (token-driven, no rainbow / no raw hex):
//   Collected = success green (the positive money signal),
//   Invoiced  = neutral border track, Target = ocean reference line.
//
// THE CHART SUBTREE IS A NO-TOUCH BOUNDARY. The kit ships no chart component,
// and colour INSIDE a chart carries meaning - collected-green against a
// neutral invoiced track, with the current month the only saturated bar - so
// substituting a kit token in a chart prop would be a behaviour change, not a
// restyle. Everything from <ResponsiveContainer> down, and the legend swatches
// that have to match it, is carried over from
// pages/dashboard/widgets/RevenueChart.tsx unchanged. Only the card around it
// moved to the kit.
const COLLECTED = chartPalette[0]!; // sage-700 (success/data-positive)
const COLLECTED_MUTED = token('--sage-500');
const INVOICED = token('--border-color');
const TARGET = token('--primary');

function TooltipContent({ active, payload, label }: { active?: boolean; payload?: Array<{ name: string; value: number }>; label?: string }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg bg-surface-light border border-border px-3 py-2 text-xs shadow-lg">
      <p className="font-semibold text-text-primary mb-1">{label}</p>
      {payload.map((p, i) => (
        <p key={i} className="text-text-secondary tabular-nums">
          <span className="font-medium">{p.name}: </span>{formatCurrency(p.value)}
        </p>
      ))}
    </div>
  );
}

/**
 * Monthly revenue, on recharts.
 *
 * The series is always six contiguous zero-filled buckets from the server, so
 * "no data" is a series where every bucket is zero (or an empty array): that
 * draws one plain line instead of a chart of empty axes.
 */
export default function RevenueChart({ data, target, scopeLabel, onViewAll, isLoading }: {
  data: RevenuePoint[];
  target?: number;
  scopeLabel?: string | null;
  /** Set only when the server sent an address for the tile (the Invoices list); without it the card has no "View all". */
  onViewAll?: () => void;
  isLoading?: boolean;
}) {
  const viewAll = onViewAll && <Button type="button" variant="link" size={null} className="text-xs" onClick={onViewAll}>View all</Button>;
  const nothingYet = data.every((m) => m.invoiced === 0 && m.collected === 0);
  if (nothingYet) {
    return (
      <WidgetCard title="Monthly Revenue" icon={<BarChart2 className="h-4 w-4 text-muted-foreground" />} scopeLabel={scopeLabel} right={viewAll} loading={isLoading}>
        <EmptyState title="No invoices or payments in this period" />
      </WidgetCard>
    );
  }
  return (
    <WidgetCard title="Monthly Revenue" icon={<BarChart2 className="h-4 w-4 text-muted-foreground" />} scopeLabel={scopeLabel} right={viewAll}>
      <div className="px-5 pt-4 pb-3">
        <div className="flex items-center gap-4 text-[11px] text-text-secondary mb-3">
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-1.5 rounded-full bg-border" />Invoiced</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-3 h-1.5 rounded-full bg-sage-700" />Collected</span>
          {target !== undefined && <span className="flex items-center gap-1.5"><span className="inline-block w-4 border-t border-dashed border-primary" />Target</span>}
        </div>
        <div className="h-[220px]">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={data} barCategoryGap="30%" barGap={3}>
              <CartesianGrid strokeDasharray="3 3" stroke={token('--border-color')} vertical={false} />
              <XAxis dataKey="month" axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: token('--text-secondary') }} />
              <YAxis axisLine={false} tickLine={false} tick={{ fontSize: 11, fill: token('--text-secondary') }} tickFormatter={(v: number) => formatCurrencyWhole(v)} width={88} domain={[0, (dataMax: number) => Math.max(dataMax * 1.15, (target ?? 0) * 1.15, 1000)]} />
              <Tooltip content={<TooltipContent />} cursor={{ fill: token('--border-soft'), opacity: 0.5 }} />
              {/* The goal is the company's plan: it is drawn only when the server sent one (company mode). */}
              {target !== undefined && (
                <ReferenceLine y={target} stroke={TARGET} strokeDasharray="6 4" strokeOpacity={0.7} label={{ value: formatCurrencyWhole(target), position: 'right', fill: TARGET, fontSize: 10, fontWeight: 600 }} />
              )}
              <Bar dataKey="invoiced" name="Invoiced" fill={INVOICED} radius={[3, 3, 0, 0]} />
              <Bar dataKey="collected" name="Collected" radius={[3, 3, 0, 0]}>
                {data.map((entry, i) => (
                  <Cell key={i} fill={entry.is_current ? COLLECTED : COLLECTED_MUTED} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </WidgetCard>
  );
}
