import { ResizableTable } from '@/components/data/ResizableTable';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import type { CadenceResult, JobCadenceRow, Band } from '@/lib/reports/communication-tracking-logic';

const BAND_STYLE: Record<Band, string> = {
  under: 'bg-danger/10 text-danger',
  healthy: 'bg-success/10 text-success',
  over: 'bg-warning/10 text-warning',
};
const BAND_LABEL: Record<Band, string> = {
  under: 'Under-touched',
  healthy: 'Healthy',
  over: 'Over-contacted',
};

function StatCell({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="px-5 py-3">
      <div className="text-xs font-medium uppercase tracking-wide text-text-secondary">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-text-primary tabular-nums">{value}</div>
    </div>
  );
}

function TouchBar({ row }: { row: JobCadenceRow }) {
  const pct = row.max > 0 ? Math.min(100, Math.round((row.touchCount / row.max) * 100)) : 0;
  const color = row.band === 'under' ? 'bg-danger' : row.band === 'over' ? 'bg-warning' : 'bg-success';
  return (
    <div className="flex items-center gap-2">
      <div className="h-2 w-24 overflow-hidden rounded-full bg-background-light">
        <div className={`h-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="tabular-nums text-text-secondary">
        {row.touchCount}/{row.min}–{row.max}
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
      <div className="grid grid-cols-2 divide-x divide-border rounded-xl border border-border bg-surface-light shadow-card md:grid-cols-5">
        <StatCell label="% Healthy" value={`${stats.healthyPct}%`} />
        <StatCell label="Under-touched" value={stats.under} />
        <StatCell label="Over-contacted" value={stats.over} />
        <StatCell label="Stale" value={stats.stale} />
        <StatCell label="Avg touches" value={stats.avgTouches} />
      </div>

      <div className="space-y-2">
        <div>
          <Heading level={3}>Open jobs — needs attention first</Heading>
          <p className="text-xs text-text-secondary">Under-touched and stale jobs are sorted to the top.</p>
        </div>
        <ResizableTable
          rows={worklist}
          getRowKey={(r) => r.jobId}
          empty={<EmptyState title="No open jobs need attention." />}
          columns={[
            { id: 'job', header: 'Job', width: 110, min: 90, sortValue: (r) => r.jobNumber, cell: (r) => <span className="font-medium text-text-primary">{r.jobNumber}</span> },
            { id: 'customer', header: 'Customer', width: 180, min: 150, sortValue: (r) => r.customerName, cell: (r) => <span className="text-text-secondary">{r.customerName}</span> },
            { id: 'owner', header: 'Owner', width: 160, min: 140, sortValue: (r) => r.ownerName, cell: (r) => <span className="text-text-secondary">{r.ownerName}</span> },
            { id: 'touches', header: 'Touches', width: 180, min: 160, sortValue: (r) => r.touchCount, cell: (r) => <TouchBar row={r} /> },
            { id: 'calls', header: 'Calls', width: 100, min: 90, align: 'right', sortValue: (r) => r.callCount, cell: (r) => <span className="tabular-nums text-text-secondary">{r.callCount}</span> },
            { id: 'texts', header: 'Texts', width: 100, min: 90, align: 'right', sortValue: (r) => r.textCount, cell: (r) => <span className="tabular-nums text-text-secondary">{r.textCount}</span> },
            { id: 'lastTouch', header: 'Last touch', width: 130, min: 120, sortValue: (r) => r.daysSinceLastTouch, cell: (r) => <span className="text-text-secondary">{r.daysSinceLastTouch === null ? '—' : `${r.daysSinceLastTouch}d ago`}</span> },
            { id: 'status', header: 'Status', width: 150, min: 130, sortValue: (r) => r.band, cell: (r) => <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${BAND_STYLE[r.band]}`}>{BAND_LABEL[r.band]}{r.stale ? ' · stale' : ''}</span> },
          ]}
        />
      </div>

      {overRows.length > 0 && (
        <div className="space-y-2">
          <div>
            <Heading level={3}>At-risk — over-contacted jobs</Heading>
            <p className="text-xs text-text-secondary">More than the target touches — possible problem job.</p>
          </div>
          <ResizableTable
            rows={overRows}
            getRowKey={(r) => r.jobId}
            columns={[
              { id: 'job', header: 'Job', width: 110, min: 90, sortValue: (r) => r.jobNumber, cell: (r) => <span className="font-medium text-text-primary">{r.jobNumber}</span> },
              { id: 'customer', header: 'Customer', width: 200, min: 160, sortValue: (r) => r.customerName, cell: (r) => <span className="text-text-secondary">{r.customerName}</span> },
              { id: 'owner', header: 'Owner', width: 180, min: 150, sortValue: (r) => r.ownerName, cell: (r) => <span className="text-text-secondary">{r.ownerName}</span> },
              { id: 'touches', header: 'Touches', width: 140, min: 120, align: 'right', sortValue: (r) => r.touchCount, cell: (r) => <span className="tabular-nums text-text-secondary">{r.touchCount} touches</span> },
            ]}
          />
        </div>
      )}
    </div>
  );
}
