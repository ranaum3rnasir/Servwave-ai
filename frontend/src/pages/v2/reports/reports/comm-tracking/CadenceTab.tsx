import type { Band, CadenceResult, JobCadenceRow } from '@/lib/reports/communication-tracking-logic';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { StatCard, StatCardGroup } from '@/ui-kit/components/data/statCard';
import { Badge, type BadgeProps } from '@/ui-kit/components/ui/badge';
import { cn } from '@/ui-kit/lib/utils';

import { ReportHeading } from '../../components/heading';
import { ReportTable } from '../../components/reportTable';

/**
 * Cadence tab - per-job contact cadence against its target touch band.
 *
 * THE BAND IS A DATA SIGNAL: under-touched is red, healthy is green,
 * over-contacted is amber, and the same three colours drive both the status
 * pill and the touch bar so a row reads the same way twice. That mapping is
 * unchanged; only the pill (kit Badge) and the bar (kit Progress) moved.
 *
 * All the banding itself lives in `communication-tracking-logic` and is
 * imported through the `CadenceResult` the parent hands down.
 */

const BAND_VARIANT: Record<Band, NonNullable<BadgeProps['variant']>> = {
  under: 'softRed',
  healthy: 'softGreen',
  over: 'softAmber',
};

const BAND_LABEL: Record<Band, string> = {
  under: 'Under-touched',
  healthy: 'Healthy',
  over: 'Over-contacted',
};

// The kit's Progress always fills brand and takes no tone, so the band colour
// would be lost through it - and the band IS the reading. Filed as a kit API
// gap; the bar stays hand-built out of kit status tokens until Progress can
// express a tone.
const BAND_FILL: Record<Band, string> = {
  under: 'bg-status-red',
  healthy: 'bg-status-green',
  over: 'bg-status-amber',
};

function TouchBar({ row }: { row: JobCadenceRow }) {
  const pct = row.max > 0 ? Math.min(100, Math.round((row.touchCount / row.max) * 100)) : 0;
  return (
    <div className="flex items-center gap-2">
      <div
        role="progressbar"
        aria-valuenow={row.touchCount}
        aria-valuemin={0}
        aria-valuemax={row.max}
        className="bg-muted h-2 w-24 overflow-hidden rounded-full"
      >
        <div className={cn('h-full rounded-full', BAND_FILL[row.band])} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-muted-foreground tabular-nums">
        {row.touchCount}/{row.min}-{row.max}
      </span>
    </div>
  );
}

export function CadenceTab({ cadence }: { cadence: CadenceResult }) {
  const { rows, stats } = cadence;
  const overRows = rows.filter((r) => r.band === 'over');
  const worklist = rows.filter((r) => r.band !== 'over');

  return (
    <div className="space-y-6">
      <StatCardGroup className="xl:grid-cols-5">
        <StatCard label="% Healthy" value={`${stats.healthyPct}%`} />
        <StatCard label="Under-touched" value={stats.under} />
        <StatCard label="Over-contacted" value={stats.over} />
        <StatCard label="Stale" value={stats.stale} />
        <StatCard label="Avg touches" value={stats.avgTouches} />
      </StatCardGroup>

      <div className="space-y-2">
        <div>
          <ReportHeading level={3}>Open jobs - needs attention first</ReportHeading>
          <p className="text-muted-foreground text-xs">Under-touched and stale jobs are sorted to the top.</p>
        </div>
        <ReportTable
          rows={worklist}
          getRowKey={(r) => r.jobId}
          empty={<EmptyState title="No open jobs need attention." />}
          columns={[
            { id: 'job', header: 'Job', width: 110, min: 90, sortValue: (r) => r.jobNumber, cell: (r) => <span className="font-medium">{r.jobNumber}</span> },
            { id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (r) => r.customerName, cell: (r) => <span className="text-muted-foreground">{r.customerName}</span> },
            { id: 'owner', header: 'Owner', width: 160, min: 140, sortValue: (r) => r.ownerName, cell: (r) => <span className="text-muted-foreground">{r.ownerName}</span> },
            { id: 'touches', header: 'Touches', width: 180, min: 160, sortValue: (r) => r.touchCount, cell: (r) => <TouchBar row={r} /> },
            { id: 'calls', header: 'Calls', width: 100, min: 90, align: 'right', sortValue: (r) => r.callCount, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.callCount}</span> },
            { id: 'texts', header: 'Texts', width: 100, min: 90, align: 'right', sortValue: (r) => r.textCount, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.textCount}</span> },
            { id: 'lastTouch', header: 'Last touch', width: 130, min: 120, sortValue: (r) => r.daysSinceLastTouch, cell: (r) => <span className="text-muted-foreground">{r.daysSinceLastTouch === null ? '-' : `${r.daysSinceLastTouch}d ago`}</span> },
            {
              id: 'status', header: 'Status', width: 150, min: 130, sortValue: (r) => r.band,
              cell: (r) => (
                <Badge variant={BAND_VARIANT[r.band]} size="pill">
                  {BAND_LABEL[r.band]}{r.stale ? ' · stale' : ''}
                </Badge>
              ),
            },
          ]}
        />
      </div>

      {overRows.length > 0 && (
        <div className="space-y-2">
          <div>
            <ReportHeading level={3}>At-risk - over-contacted jobs</ReportHeading>
            <p className="text-muted-foreground text-xs">More than the target touches - possible problem job.</p>
          </div>
          <ReportTable
            rows={overRows}
            getRowKey={(r) => r.jobId}
            columns={[
              { id: 'job', header: 'Job', width: 110, min: 90, sortValue: (r) => r.jobNumber, cell: (r) => <span className="font-medium">{r.jobNumber}</span> },
              { id: 'customer', header: 'Customer', width: 200, min: 160, sortValue: (r) => r.customerName, cell: (r) => <span className="text-muted-foreground">{r.customerName}</span> },
              { id: 'owner', header: 'Owner', width: 180, min: 150, sortValue: (r) => r.ownerName, cell: (r) => <span className="text-muted-foreground">{r.ownerName}</span> },
              { id: 'touches', header: 'Touches', width: 140, min: 120, align: 'right', sortValue: (r) => r.touchCount, cell: (r) => <span className="text-muted-foreground tabular-nums">{r.touchCount} touches</span> },
            ]}
          />
        </div>
      )}
    </div>
  );
}
