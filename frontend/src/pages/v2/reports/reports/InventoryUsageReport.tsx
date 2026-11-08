import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Boxes, Briefcase, CircleDollarSign, Package } from 'lucide-react';

import { ChartCard, HorizontalBars } from '@/components/charts';
import { formatCurrency } from '@/lib/utils';
import { findReport } from '@/lib/reports/report-catalog';
import { useInventoryUsage, type UsageReportRow } from '@/lib/reports/inventory-usage-data';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Badge } from '@/ui-kit/components/ui/badge';
import { Card } from '@/ui-kit/components/ui/card';
import {
  Table, TableBody, TableHead, TableHeader, TableRow,
} from '@/ui-kit/components/ui/table';
import { Td } from '../components/td';

import { ReportShell } from '../components/reportShell';
import { ReportKpis } from '../components/kpi';
import { DateRangeControl } from '../components/dateRangeControl';
import { preferV2Path } from '../../uiV2';

/**
 * Inventory Usage - sum of consume movements per item over a date range.
 *
 * THE PRICING GATE IS THE POINT AND IT IS UNCHANGED. The server strips cost
 * data for a viewer without `read Pricing` (canSeePricing, SRVW-140), so
 * `hasCost` is derived from the payload - "did any row arrive with a cost" -
 * and never from a role check on the client. When it is false the cost KPI,
 * the cost chart and the cost column all disappear rather than rendering
 * fabricated $0s. `hasUnpriced` works the same way for consumption recorded
 * without a cost snapshot. Both are carried over exactly.
 *
 * The date presets and their arithmetic are copied from the legacy page
 * because they are private to it, and `useInventoryUsage` is imported.
 *
 * The hand-built `<table>` is the kit's `Table`; the job/invoice drill-through
 * chips are kit `Badge asChild` around a `Link`, and both go through
 * `preferV2Path` so they land in v2 wherever those modules have been rebuilt.
 */

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

/** Fractional Decimal units - up to 2 decimals, comma-grouped. */
const fmtUnits = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 2 });

export default function InventoryUsageReport() {
  const report = findReport('inventory-usage')!;
  const [preset, setPreset] = useState<Preset>('12m');
  const [customFrom, setCustomFrom] = useState('');
  const [customTo, setCustomTo] = useState('');

  const range = useMemo(() => presetRange(preset, customFrom, customTo), [preset, customFrom, customTo]);
  const { data, isLoading } = useInventoryUsage(range);
  const items: UsageReportRow[] = useMemo(() => data?.items ?? [], [data]);

  // Server-stripped => no row carries `cost`; the whole cost side disappears.
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
    () => [...items].sort((a, b) => b.units - a.units).slice(0, 10).map((r) => ({ label: r.name, value: r.units })),
    [items],
  );
  const topByCost = useMemo(
    () =>
      hasCost
        ? [...items].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 10).map((r) => ({ label: r.name, value: r.cost ?? 0 }))
        : [],
    [items, hasCost],
  );

  return (
    <ReportShell
      report={report}
      subtitle="Units consumed per item - from the stock ledger's consume movements"
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
      <ReportKpis
        items={[
          { icon: Boxes, label: 'Units consumed', value: fmtUnits(totalUnits), tone: 'primary' },
          ...(hasCost
            ? [{
                icon: CircleDollarSign,
                label: 'Material cost',
                value: formatCurrency(totalCost),
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
            <HorizontalBars data={topByUnits} labelKey="label" valueKey="value" labelWidth={150} valueFormatter={fmtUnits} />
          </ChartCard>
          {hasCost && (
            <ChartCard title="Top items by cost" subtitle="Sum of qty × unit-cost snapshot per item">
              <HorizontalBars data={topByCost} labelKey="label" valueKey="value" labelWidth={150} valueFormatter={(v) => formatCurrency(v)} />
            </ChartCard>
          )}
        </div>
      )}

      <Card className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Item</TableHead>
              <TableHead className="text-right">Units</TableHead>
              <TableHead className="text-right">Movements</TableHead>
              {hasCost && <TableHead className="text-right">Cost</TableHead>}
              {hasUnpriced && <TableHead className="text-right">Unpriced units</TableHead>}
              <TableHead>Jobs</TableHead>
              <TableHead>Invoices</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((r) => (
              <TableRow key={r.itemId ?? `sku:${r.sku}`}>
                <Td>
                  <code className="text-muted-foreground font-mono text-[11px]">{r.sku}</code>
                  <p className="truncate font-medium">{r.name}</p>
                </Td>
                <Td className="text-right font-mono font-semibold">{fmtUnits(r.units)}</Td>
                <Td className="text-muted-foreground text-right font-mono">{r.movementCount}</Td>
                {hasCost && <Td className="text-right font-mono">{formatCurrency(r.cost ?? 0)}</Td>}
                {hasUnpriced && (
                  <Td className="text-status-amber-emphasis text-right font-mono">
                    {(r.unpricedUnits ?? 0) > 0 ? fmtUnits(r.unpricedUnits!) : '-'}
                  </Td>
                )}
                <Td>
                  {r.jobs.length === 0 ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {r.jobs.map((j) => (
                        <Badge key={j.id} asChild variant="softBlue" size="pill">
                          <Link to={preferV2Path(`/jobs/${j.id}`)}>{j.jobNumber}</Link>
                        </Badge>
                      ))}
                    </div>
                  )}
                </Td>
                <Td>
                  {r.invoices.length === 0 ? (
                    <span className="text-muted-foreground">-</span>
                  ) : (
                    <div className="flex flex-wrap gap-1">
                      {r.invoices.map((inv) => (
                        <Badge key={inv.id} asChild variant="softNeutral" size="pill">
                          <Link to={preferV2Path(`/invoices/${inv.id}`)}>{inv.invoiceNumber}</Link>
                        </Badge>
                      ))}
                    </div>
                  )}
                </Td>
              </TableRow>
            ))}
            {items.length === 0 && (
              <TableRow>
                <Td colSpan={5 + (hasCost ? 1 : 0) + (hasUnpriced ? 1 : 0)} padding="none">
                  <EmptyState title={isLoading ? 'Loading usage...' : 'No consume movements in this window.'} />
                </Td>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </Card>

      <p className="text-muted-foreground text-xs">
        Consume movements only - returns and adjustments stay visible in the Inventory Activity log and are
        not netted here. Job and invoice chips are the movements&apos; own references.
        {hasUnpriced &&
          ' "Unpriced units" counts consumption recorded without a cost snapshot - cost totals never fabricate a price for them.'}
      </p>
    </ReportShell>
  );
}
