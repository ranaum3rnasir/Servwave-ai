// Call Tracking report → a focused, read-only call history + recordings log.
// Replaces the generic channel-attribution template for slug
// `call-tracking-summary` (registered in reports-registry.ts). Phone calls only
// — no texting/numbers/flows. Search by date + client, phone stats up top.
//
// For the per-call detail it REUSES the Phone module's CallDetailDrawer (the
// rich "Incoming/Outgoing Call" panel) so the report and the Phone → Calls tab
// stay visually identical.
//
// Mock-first: data from call-tracking-data.ts, stats/filtering from
// call-tracking-logic.ts. No backend.

import { useMemo, useState } from 'react';
import { Phone, PhoneCall, PhoneMissed, Clock, DollarSign, Mic, Search } from 'lucide-react';
import { formatCurrency, cn } from '@/lib/utils';
import { KpiStrip } from '@/components/data/KpiStrip';
import { useToast } from '@/components/ui/use-toast';
import { CallDetailDrawer } from '@/components/communication/phone/CallsView';
import { CallsTable } from '@/components/communication/phone/CallsTable';
import { findReport } from '@/lib/reports/report-catalog';
import { ReportShell } from './ReportShell';
import { DateRangeControl } from './DateRangeControl';
import { buildCalls } from '@/lib/reports/call-tracking-data';
import {
  filterCalls,
  computeStats,
  formatDuration,
  formatTalkTime,
  type DecoratedCall,
} from '@/lib/reports/call-tracking-logic';

type Preset = 'month' | 'lastMonth' | '30d' | '90d' | 'year' | 'all' | 'custom';
const PRESET_LABEL: Record<Preset, string> = {
  month: 'This month',
  lastMonth: 'Last month',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  year: 'This year',
  all: 'All time',
  custom: 'Custom',
};

function presetRange(p: Preset, now: Date): { from: Date | null; to: Date | null } {
  const end = new Date(now);
  end.setHours(23, 59, 59, 999);
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  switch (p) {
    case 'month':
      start.setDate(1);
      return { from: start, to: end };
    case 'lastMonth':
      return {
        from: new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0),
        to: new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999),
      };
    case '30d':
      start.setDate(now.getDate() - 29);
      return { from: start, to: end };
    case '90d':
      start.setDate(now.getDate() - 89);
      return { from: start, to: end };
    case 'year':
      return { from: new Date(now.getFullYear(), 0, 1), to: end };
    case 'all':
    case 'custom':
    default:
      return { from: null, to: null };
  }
}

export default function CallsReport() {
  const report = findReport('call-tracking-summary')!;
  const { toast } = useToast();
  const now = useMemo(() => new Date(), []);
  const all = useMemo(() => buildCalls(now), [now]);

  const [preset, setPreset] = useState<Preset>('90d');
  const [clientQuery, setClientQuery] = useState('');
  const [recordedOnly, setRecordedOnly] = useState(false);
  const [direction, setDirection] = useState<'all' | 'inbound' | 'outbound'>('all');
  const [selected, setSelected] = useState<DecoratedCall | null>(null);

  const range = useMemo(() => presetRange(preset, now), [preset, now]);

  const filtered = useMemo(
    () => filterCalls(all, { from: range.from, to: range.to, clientQuery, recordedOnly, direction }),
    [all, range, clientQuery, recordedOnly, direction],
  );
  const stats = useMemo(() => computeStats(filtered), [filtered]);

  const kpis = [
    {
      icon: Phone,
      label: 'Total calls',
      value: stats.total.toLocaleString(),
      sub: `${stats.inbound} in · ${stats.outbound} out`,
      tone: 'primary' as const,
    },
    {
      icon: PhoneCall,
      label: 'Answered rate',
      value: `${Math.round(stats.answeredRate)}%`,
      sub: `${stats.answered} answered · ${stats.voicemail} VM`,
      tone: 'success' as const,
    },
    {
      icon: PhoneMissed,
      label: 'Missed calls',
      value: stats.missed.toLocaleString(),
      tone: 'danger' as const,
    },
    {
      icon: Clock,
      label: 'Avg talk time',
      value: formatDuration(stats.avgTalkSec),
      sub: `${formatTalkTime(stats.totalTalkSec)} total`,
      tone: 'neutral' as const,
    },
    {
      icon: DollarSign,
      label: 'Attributed revenue',
      value: formatCurrency(stats.attributedRevenue),
      sub: `${Math.round(stats.bookingRate)}% booked`,
      tone: 'success' as const,
      emphasize: true,
    },
    {
      icon: Mic,
      label: 'Recorded calls',
      value: stats.recorded.toLocaleString(),
      tone: 'neutral' as const,
    },
  ];

  const dirBtn = (key: 'all' | 'inbound' | 'outbound', label: string) => (
    <button
      key={key}
      type="button"
      onClick={() => setDirection(key)}
      className={cn(
        'px-3 py-1.5 text-sm font-medium transition',
        direction === key ? 'bg-primary text-on-fill' : 'bg-surface-light text-text-secondary hover:bg-background-light',
      )}
    >
      {label}
    </button>
  );

  return (
    <ReportShell
      report={report}
      subtitle="Call history, recordings & phone performance"
      actions={
        <DateRangeControl
          presets={(Object.keys(PRESET_LABEL) as Preset[]).map((k) => ({ key: k, label: PRESET_LABEL[k] }))}
          preset={preset}
          onPreset={(k) => setPreset(k as Preset)}
          from={range.from}
          to={range.to}
          fields={[{ key: 'startedAt', label: 'Call date' }]}
          field="startedAt"
          onField={() => {}}
        />
      }
    >
      <KpiStrip items={kpis} />

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-[240px] flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary" />
          <input
            value={clientQuery}
            onChange={(e) => setClientQuery(e.target.value)}
            placeholder="Search by client or phone number…"
            className="h-10 w-full rounded-lg border border-border bg-surface-light pl-9 pr-3 text-sm outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/15"
          />
        </div>

        <div className="flex overflow-hidden rounded-lg border border-border">
          {dirBtn('all', 'All')}
          {dirBtn('inbound', 'Inbound')}
          {dirBtn('outbound', 'Outbound')}
        </div>

        <label className="flex h-10 cursor-pointer select-none items-center gap-2 rounded-lg border border-border bg-surface-light px-3 text-sm text-text-secondary">
          <input
            type="checkbox"
            checked={recordedOnly}
            onChange={(e) => setRecordedOnly(e.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Recorded only
        </label>

        <span className="ml-auto text-sm text-text-secondary">
          {filtered.length.toLocaleString()} {filtered.length === 1 ? 'call' : 'calls'}
        </span>
      </div>

      {/* Call history table — the SAME table the Phone → Calls tab renders. */}
      <CallsTable calls={filtered} onRowClick={(c) => setSelected(c as DecoratedCall)} />

      {selected && (
        <CallDetailDrawer
          call={selected}
          onClose={() => setSelected(null)}
          onToast={(m) => toast({ description: m })}
        />
      )}
    </ReportShell>
  );
}
