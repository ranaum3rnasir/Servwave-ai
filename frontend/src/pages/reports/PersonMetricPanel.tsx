/**
 * PersonMetricPanel — the record list that opens when an Individual-scorecard
 * KPI card is pressed (e.g. "$ Touched" → the converted jobs, "Response time" →
 * the per-day responses). Reads a DetailSpec built by `personDetail`.
 */
import { X } from 'lucide-react';
import { EmptyState } from '@/components/ui/empty-state';
import { Heading } from '@/components/ui/heading';
import type { UserActivity, PersonMetricKey } from '@/lib/reports/activity-logic';
import { personDetail, bandFill } from '@/lib/reports/activity-logic';

interface Props {
  user: UserActivity;
  metric: PersonMetricKey;
  onClose: () => void;
}

export function PersonMetricPanel({ user, metric, onClose }: Props) {
  const { title, hint, summary, rows } = personDetail(user, metric);

  return (
    <div className="rounded-xl border border-primary/30 bg-surface-light p-5 shadow-card ring-1 ring-primary/10">
      <div className="mb-1 flex items-start justify-between">
        <div>
          <Heading level={2}>
            {title} — {user.name.split(' ')[0]}
          </Heading>
          <p className="text-xs text-text-secondary">{hint}</p>
        </div>
        {/* Small close-X affordance, not Button-shaped - left raw. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="Close detail"
          className="rounded-lg p-1 text-text-secondary hover:bg-background-light hover:text-text-primary"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <p className="mb-3 text-xs font-medium text-text-secondary">{summary}</p>

      {rows.length === 0 ? (
        <EmptyState density="compact" title="No records for this card." />
      ) : (
        <div className="max-h-80 divide-y divide-border overflow-y-auto rounded-lg border border-border">
          {rows.map((r) => (
            <div key={r.id} className="flex items-center gap-3 px-3 py-2 hover:bg-background-light">
              {r.band && (
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: bandFill(r.band) }} />
              )}
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-text-primary">{r.label}</div>
                {r.sub && <div className="truncate text-[11px] text-text-secondary">{r.sub}</div>}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-sm font-semibold tabular-nums text-text-primary">{r.value}</div>
                {r.value2 && <div className="text-[11px] tabular-nums text-text-secondary">{r.value2}</div>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
