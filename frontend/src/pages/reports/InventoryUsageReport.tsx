// ───────────────────────────────────────────────────────────────────────────
// Inventory Usage (P5 §3, plan D17) — Σ consume movements per item over a date
// range: units, movement count, cost (from movement unit_cost snapshots), and
// drill-through to the movements' own job/invoice refs (QA-703).
//
// Cost columns/charts render ONLY when the payload carries `cost` — the server
// strips cost data for viewers without `read Pricing` (canSeePricing, SRVW-140), and the
// UI then shows a units-only report rather than fabricated $0 columns.
// ───────────────────────────────────────────────────────────────────────────
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Briefcase, CircleDollarSign, Package } from 'lucide-react';
import { KpiStrip } from '@/components/data/KpiStrip';
import { ChartCard, HorizontalBars } from '@/components/charts';
import { EmptyState } from '@/components/ui/empty-state';
import { formatCurrency } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { DateRangeControl } from './DateRangeControl';
import { useInventoryUsage, type UsageReportRow } from '@/lib/reports/inventory-usage-data';

type Preset = '12m' | 'month' | 'lastMonth' | '30d' | '90d' | 'year' | 'custom';
const PRESET_LABEL: Record<Preset, string> = {
  '12m': 'Last 12 months',
  month: 'This month',
  lastMonth: 'Last month',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  year: 'This year',
  custom: 'Custom',
};

const toISODate = (d: Date) => d.toISOString().slice(0, 10);

function presetRange(p: Preset, customFrom?: string, customTo?: string): { from?: string; to?: string } {
  const now = new Date();
  const end = toISODate(now);
  switch (p) {
    case '12m': {
      const f = new Date(now);
      f.setFullYear(f.getFullYear() - 1);
      return { from: toISODate(f), to: end };
    }
    case 'month':
      return { from: toISODate(new Date(now.getFullYear(), now.getMonth(), 1)), to: end };
    case 'lastMonth':
      return {
        from: toISODate(new Date(now.getFullYear(), now.getMonth() - 1, 1)),
        to: toISODate(new Date(now.getFullYear(), now.getMonth(), 0)),
      };
    case '30d': {
      const f = new Date(now);
      f.setDate(f.getDate() - 29);
      return { from: toISODate(f), to: end };
    }
    case '90d': {
      const f = new Date(now);
      f.setDate(f.getDate() - 89);
      return { from: toISODate(f), to: end };
    }
    case 'year':
      return { from: toISODate(new Date(now.getFullYear(), 0, 1)), to: end };
    case 'custom':
      return { from: customFrom || undefined, to: customTo || undefined };
  }
}

/** Fractional Decimal units — up to 2 decimals, comma-grouped. */
const fmtUnits = (n: number) =>
  n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export default function InventoryUsageReport() {
  const report = findReport('inventory-usage')!;
  const [preset, setPreset] = useState<Preset>('12m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const range = useMemo(
    () => presetRange(preset, customFrom, customTo),
    [preset, customFrom, customTo],
  );
  const { data, isLoading } = useInventoryUsage(range);
  const items: UsageReportRow[] = useMemo(() => data?.items ?? [], [data]);

  // Server-stripped ⇒ no row carries `cost`; the whole cost side disappears.
  const hasCost = items.some((r) => r.cost !== undefined);

  const totalUnits = items.reduce((s, r) => s + r.units, 0);
  const totalCost = hasCost ? items.reduce((s, r) => s + (r.cost ?? 0), 0) : 0;
  const distinctJobs = useMemo(() => {
    const ids = new Set<string>();
    for (const r of items) for (const j of r.jobs) ids.add(j.id);
    return ids.size;
  }, [items]);
  const hasUnpriced = hasCost && items.some((r) => (r.unpricedUnits ?? 0) > 0);

  const topByUnits = useMemo(
    () =>
      [...items]
        .sort((a, b) => b.units - a.units)
        .slice(0, 10)
        .map((r) => ({ label: r.name, value: r.units })),
    [items],
  );
  const topByCost = useMemo(
    () =>
      hasCost
        ? [...items]
            .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
            .slice(0, 10)
            .map((r) => ({ label: r.name, value: r.cost ?? 0 }))
        : [],
    [items, hasCost],
  );

  return (
    <ReportShell
      report={report}
      subtitle="Units consumed per item — from the stock ledger's consume movements"
      actions={
        <DateRangeControl
          presets={(Object.keys(PRESET_LABEL) as Preset[]).map((k) => ({ key: k, label: PRESET_LABEL[k] }))}
          preset={preset}
          onPreset={(k) => setPreset(k as Preset)}
          from={range.from ? new Date(`${range.from}T00:00:00`) : null}
          to={range.to ? new Date(`${range.to}T00:00:00`) : null}
          fields={[{ key: 'occurred', label: 'Movement date' }]}
          field="occurred"
          onField={() => {}}
          customFrom={customFrom}
          customTo={customTo}
          onCustomFrom={setCustomFrom}
          onCustomTo={setCustomTo}
        />
      }
    >
      <KpiStrip
        items={[
          { icon: Boxes, label: 'Units consumed', value: fmtUnits(totalUnits), tone: 'primary' },
          ...(hasCost
            ? [{
                icon: CircleDollarSign,
                label: 'Material cost',
                value: formatCurrency(totalCost),
                sub: 'Σ qty × movement cost snapshot',
                tone: 'neutral' as const,
                emphasize: true,
              }]
            : []),
          { icon: Package, label: 'Distinct items', value: String(items.length), tone: 'neutral' },
          { icon: Briefcase, label: 'Jobs touched', value: String(distinctJobs), tone: 'neutral' },
        ]}
      />

      {items.length > 0 && (
        <div className={`grid grid-cols-1 gap-4 ${hasCost ? 'lg:grid-cols-2' : ''}`}>
          <ChartCard title="Top items by units" subtitle="Most-consumed items in the window">
            <HorizontalBars
              data={topByUnits}
              labelKey="label"
              valueKey="value"
              labelWidth={150}
              valueFormatter={fmtUnits}
            />
          </ChartCard>
          {hasCost && (
            <ChartCard title="Top items by cost" subtitle="Σ qty × unit-cost snapshot per item">
              <HorizontalBars
                data={topByCost}
                labelKey="label"
                valueKey="value"
                labelWidth={150}
                valueFormatter={(v) => formatCurrency(v)}
              />
            </ChartCard>
          )}
        </div>
      )}

      <div className="overflow-x-auto rounded-card border border-border bg-surface-light shadow-card">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="bg-background-light text-left text-[11px] font-semibold uppercase tracking-wide text-text-secondary">
              <th className="border-b-2 border-border px-4 py-2">Item</th>
              <th className="border-b-2 border-border px-4 py-2 text-right">Units</th>
              <th className="border-b-2 border-border px-4 py-2 text-right">Movements</th>
              {hasCost && <th className="border-b-2 border-border px-4 py-2 text-right">Cost</th>}
              {hasUnpriced && (
                <th className="border-b-2 border-border px-4 py-2 text-right">Unpriced units</th>
              )}
              <th className="border-b-2 border-border px-4 py-2">Jobs</th>
              <th className="border-b-2 border-border px-4 py-2">Invoices</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {items.map((r) => (
              <tr key={r.itemId ?? `sku:${r.sku}`} className="hover:bg-background-light">
                <td className="px-4 py-2.5">
                  <code className="font-mono text-[11px] text-text-secondary">{r.sku}</code>
                  <p className="truncate font-medium text-text-primary">{r.name}</p>
                </td>
                <td className="px-4 py-2.5 text-right font-mono font-semibold text-text-primary">
                  {fmtUnits(r.units)}
                </td>
                <td className="px-4 py-2.5 text-right font-mono text-text-secondary">
                  {r.movementCount}
                </td>
                {hasCost && (
                  <td className="px-4 py-2.5 text-right font-mono text-text-primary">
                    {formatCurrency(r.cost ?? 0)}
                  </td>
                )}
                {hasUnpriced && (
                  <td className="px-4 py-2.5 text-right font-mono text-warning">
                    {(r.unpricedUnits ?? 0) > 0 ? fmtUnits(r.unpricedUnits!) : '—'}
                  </td>
                )}
                <td className="px-4 py-2.5">
                  {r.jobs.length === 0 ? (
                    <span className="text-text-secondary">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {r.jobs.map((j) => (
                        <Link
                          key={j.id}
                          to={`/jobs/${j.id}`}
                          className="rounded-full bg-primary-subtle px-2 py-0.5 text-xs font-medium text-primary hover:underline"
                        >
                          {j.jobNumber}
                        </Link>
                      ))}
                    </div>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  {r.invoices.length === 0 ? (
                    <span className="text-text-secondary">—</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {r.invoices.map((inv) => (
                        <Link
                          key={inv.id}
                          to={`/invoices/${inv.id}`}
                          className="rounded-full bg-background-light px-2 py-0.5 text-xs font-medium text-text-primary hover:underline"
                        >
                          {inv.invoiceNumber}
                        </Link>
                      ))}
                    </div>
                  )}
                </td>
              </tr>
            ))}
            {items.length === 0 && (
              <tr>
                <td
                  colSpan={5 + (hasCost ? 1 : 0) + (hasUnpriced ? 1 : 0)}
                  className="px-6 py-16 text-center text-sm text-text-secondary"
                >
                  <EmptyState
                    title={isLoading ? 'Loading usage…' : 'No consume movements in this window.'}
                  />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-text-secondary">
        Consume movements only — returns and adjustments stay visible in the Inventory Activity log
        and are not netted here. Job and invoice chips are the movements&apos; own references.
        {hasUnpriced &&
          ' "Unpriced units" counts consumption recorded without a cost snapshot — cost totals never fabricate a price for them.'}
      </p>
    </ReportShell>
  );
}
