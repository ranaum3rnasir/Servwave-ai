import { useMemo, useState } from 'react';
import { Clock, DollarSign, Mic, Phone, PhoneCall, PhoneMissed, Search } from 'lucide-react';

import { formatCurrency } from '@/lib/utils';
import { useToast } from '@/components/ui/use-toast';
import { CallDetailDrawer } from '@/components/communication/phone/CallsView';
import { CallsTable } from '@/components/communication/phone/CallsTable';
import { findReport } from '@/lib/reports/report-catalog';
import { buildCalls } from '@/lib/reports/call-tracking-data';
import {
  computeStats, filterCalls, formatDuration, formatTalkTime, type DecoratedCall,
} from '@/lib/reports/call-tracking-logic';

import { Button } from '@/ui-kit/components/ui/button';
import { Checkbox } from '@/ui-kit/components/ui/checkbox';
import { Input } from '@/ui-kit/components/ui/input';
import { Label } from '@/ui-kit/components/ui/label';

import { ReportShell } from '../components/reportShell';
import { ReportKpis } from '../components/kpi';
import { DateRangeControl } from '../components/dateRangeControl';

/**
 * Call Tracking - a read-only call history and recordings log.
 *
 * The per-call detail deliberately REUSES the Phone module's own
 * `CallDetailDrawer` and `CallsTable`, so this report and the Phone > Calls tab
 * stay visually identical and cannot drift. Both are imported unchanged; the
 * kit has no equivalent for either (ledger rows), and rebuilding them here
 * would be exactly the divergence they exist to prevent. `useToast` is the
 * app's own toast, because the drawer's `onToast` callback expects it.
 *
 * `filterCalls` and `computeStats` are imported: the answered rate, the booking
 * rate and the attributed revenue are all defined there.
 *
 * Shape differences: the direction segmented control is a `role="radiogroup"`
 * of three kit Buttons, and "Recorded only" is a kit `Checkbox` with a `Label`
 * instead of a raw checkbox inside a raw label.
 */

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
    { icon: Phone, label: 'Total calls', value: stats.total.toLocaleString(), tone: 'primary' as const },
    { icon: PhoneCall, label: 'Answered rate', value: `${Math.round(stats.answeredRate)}%`, tone: 'success' as const },
    { icon: PhoneMissed, label: 'Missed calls', value: stats.missed.toLocaleString(), tone: 'danger' as const },
    { icon: Clock, label: 'Avg talk time', value: formatDuration(stats.avgTalkSec), tone: 'neutral' as const },
    { icon: DollarSign, label: 'Attributed revenue', value: formatCurrency(stats.attributedRevenue), tone: 'success' as const, emphasize: true },
    { icon: Mic, label: 'Recorded calls', value: stats.recorded.toLocaleString(), tone: 'neutral' as const },
  ];

  const dirBtn = (key: 'all' | 'inbound' | 'outbound', label: string) => (
    <Button
      key={key}
      type="button"
      role="radio"
      aria-checked={direction === key}
      variant={direction === key ? 'default' : 'ghost'}
      size="sm"
      onClick={() => setDirection(key)}
    >
      {label}
    </Button>
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
      <ReportKpis items={kpis} />

      <div className="flex flex-wrap items-center gap-3">
        <Input
          value={clientQuery}
          onChange={(e) => setClientQuery(e.target.value)}
          aria-label="Search calls"
          placeholder="Search by client or phone number..."
          startIcon={<Search className="size-4" />}
          className="min-w-[240px] flex-1"
        />

        <div role="radiogroup" aria-label="Direction" className="flex items-center gap-1">
          {dirBtn('all', 'All')}
          {dirBtn('inbound', 'Inbound')}
          {dirBtn('outbound', 'Outbound')}
        </div>

        <div className="flex h-10 items-center gap-2 rounded-md border px-3">
          <Checkbox
            id="call-tracking-recorded-only"
            checked={recordedOnly}
            onCheckedChange={(v) => setRecordedOnly(v === true)}
          />
          <Label htmlFor="call-tracking-recorded-only" className="text-muted-foreground cursor-pointer text-sm">
            Recorded only
          </Label>
        </div>

        <span className="text-muted-foreground ml-auto text-sm">
          {filtered.length.toLocaleString()} {filtered.length === 1 ? 'call' : 'calls'}
        </span>
      </div>

      {/* Call history table - the SAME table the Phone > Calls tab renders. */}
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
