// CallsTable — the shared, read-only call log table used by the Phone module's
// look and reused verbatim by the Call Tracking report so the two stay visually
// identical. It renders the SAME ResizableTable columns + cell components
// (DirIcon / InsightCell / AnsweredBy / SortHeader) as CallsView, owns its own
// column-sort state, and resolves customer/agent names from the mocks.
//
// It deliberately omits CallsView's operational chrome (stat cards, faceted
// filters, quick-action buttons, CSV export) — a report is read-only. Row click
// opens the caller's detail drawer in the host page.

import { useMemo, useState } from 'react';
import { ResizableTable } from '@/components/data/ResizableTable';
import {
  usePhoneCustomers,
  usePhoneAgents,
  fmtPhone,
  type CallSession,
} from '@/lib/api/communication';
import {
  customerById,
  dayLabel,
  DirIcon,
  AnsweredBy,
} from '@/components/communication/phone/shared';
import { formatCurrency } from '@/lib/utils';
import {
  SortHeader,
  InsightCell,
  agentName,
  durationLabel,
  callSortValue,
  NUMERIC_SORT_KEYS,
  type SortKey,
  type SortState,
} from '@/components/communication/phone/CallsView';
import { useScheduleTimezone } from '@/lib/schedule-tz';

export function CallsTable({
  calls,
  onRowClick,
  empty = 'No calls match your search.',
}: {
  calls: CallSession[];
  onRowClick?: (c: CallSession) => void;
  empty?: React.ReactNode;
}) {
  const { data: customers = [] } = usePhoneCustomers();
  const { data: agents = [] } = usePhoneAgents();
  const [sort, setSort] = useState<SortState | null>(null);
  const tz = useScheduleTimezone();

  function toggleSort(key: SortKey) {
    setSort((prev) =>
      prev?.key === key
        ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
        : { key, dir: NUMERIC_SORT_KEYS.includes(key) ? 'desc' : 'asc' },
    );
  }

  const rows = useMemo(() => {
    if (!sort) return calls;
    const { key, dir } = sort;
    return [...calls].sort((a, b) => {
      const av = callSortValue(customers, a, key);
      const bv = callSortValue(customers, b, key);
      const cmp =
        typeof av === 'number' && typeof bv === 'number'
          ? av - bv
          : String(av).localeCompare(String(bv));
      return dir === 'asc' ? cmp : -cmp;
    });
  }, [calls, sort, customers]);

  return (
    <ResizableTable
      rows={rows}
      getRowKey={(c) => c.id}
      onRowClick={onRowClick}
      empty={empty}
      columns={[
        {
          id: 'status',
          header: <SortHeader label="Status" sortKey="status" sort={sort} onSort={toggleSort} />,
          width: 90,
          min: 72,
          cell: (c) => <DirIcon call={c} />,
        },
        {
          id: 'from',
          header: <SortHeader label="From" sortKey="from" sort={sort} onSort={toggleSort} />,
          width: 160,
          min: 120,
          grow: 2,
          cell: (c) => {
            const cust = customerById(customers, c.customerId);
            return (
              <>
                <p className="font-semibold text-text-primary">{cust?.name ?? 'Unknown'}</p>
                <p className="font-mono text-[11px] text-primary">{fmtPhone(c.fromNumber)}</p>
              </>
            );
          },
        },
        {
          id: 'to',
          header: <SortHeader label="To" sortKey="to" sort={sort} onSort={toggleSort} />,
          width: 140,
          min: 110,
          cellClassName: 'font-mono text-[11px] text-text-secondary',
          cell: (c) => fmtPhone(c.toNumber),
        },
        {
          id: 'time',
          header: <SortHeader label="Time" sortKey="time" sort={sort} onSort={toggleSort} />,
          width: 140,
          min: 110,
          cell: (c) => (
            <>
              <p className="font-semibold text-text-primary">{dayLabel(c.startedAt, tz)}</p>
              <p className="text-[11px] text-text-secondary">{durationLabel(c.durationSec)}</p>
            </>
          ),
        },
        {
          id: 'callFlow',
          header: <SortHeader label="Call Flow" sortKey="callFlow" sort={sort} onSort={toggleSort} />,
          width: 160,
          min: 120,
          grow: 2,
          cellClassName: 'text-text-primary',
          cell: (c) => c.callFlow ?? '—',
        },
        {
          id: 'adSource',
          header: <SortHeader label="Ad Source" sortKey="adSource" sort={sort} onSort={toggleSort} />,
          width: 140,
          min: 110,
          cellClassName: 'text-text-secondary',
          // Ad source is inbound-only (which tracking number a caller dialed);
          // outbound calls have none.
          cell: (c) => (c.direction === 'inbound' ? (c.trackingSource ?? '—') : '—'),
        },
        {
          id: 'tags',
          header: <SortHeader label="Tags" sortKey="tags" sort={sort} onSort={toggleSort} />,
          width: 180,
          min: 120,
          grow: 2,
          cell: (c) =>
            c.tags && c.tags.length > 0 ? (
              <div className="flex flex-wrap gap-1">
                {c.tags.map((t) => (
                  <span
                    key={t}
                    className="rounded-full bg-background-light px-1.5 py-0.5 text-[10px] font-medium text-text-secondary"
                  >
                    {t}
                  </span>
                ))}
              </div>
            ) : (
              <span className="text-text-secondary">—</span>
            ),
        },
        {
          id: 'insights',
          header: <SortHeader label="Insights" sortKey="insights" sort={sort} onSort={toggleSort} />,
          width: 180,
          min: 120,
          grow: 2,
          cell: (c) => <InsightCell call={c} />,
        },
        {
          id: 'answeredBy',
          header: <SortHeader label="Answered By" sortKey="answeredBy" sort={sort} onSort={toggleSort} />,
          width: 150,
          min: 120,
          cell: (c) => (
            <>
              <AnsweredBy call={c} />
              {agentName(agents, c.answeredBy.id) && (
                <p className="text-[11px] text-text-secondary">{agentName(agents, c.answeredBy.id)}</p>
              )}
            </>
          ),
        },
        {
          id: 'jobs',
          header: <SortHeader label="Jobs & Leads" sortKey="jobs" sort={sort} onSort={toggleSort} />,
          width: 140,
          min: 110,
          grow: 2,
          cell: (c) =>
            c.jobLabel ? (
              <span
                className={[
                  'rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
                  c.jobLabel === 'Lead' ? 'bg-warning/10 text-warning' : 'bg-primary/10 text-primary',
                ].join(' ')}
              >
                {c.jobLabel}
              </span>
            ) : (
              <span className="text-text-secondary">—</span>
            ),
        },
        {
          id: 'revenue',
          header: <SortHeader label="Revenue" sortKey="revenue" sort={sort} onSort={toggleSort} align="right" />,
          align: 'right',
          width: 120,
          min: 90,
          cellClassName: 'tabular-nums font-mono font-semibold text-text-primary',
          cell: (c) => formatCurrency(c.revenue ?? 0),
        },
      ]}
    />
  );
}
