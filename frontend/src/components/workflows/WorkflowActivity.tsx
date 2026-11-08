/**
 * WorkflowActivity — the Activity tab. The transparency edge: a newest-first,
 * plain-English feed of what actually ran, and why — the union of new
 * WorkflowStepRun rows and (for workflows folded from the legacy engine) their
 * pre-cutover AutomationRun history, exactly as `getWorkflowActivity` returns
 * it. Every status is icon + shape + label, never color alone; legacy rows
 * carry a small "history" glyph so the office can tell old runs from new ones
 * without it reading as a second, confusing status.
 */

import { History } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { StatusBadge } from '@/components/data/status-badge';
import { EmptyState } from '@/components/ui/empty-state';
import {
  useWorkflowActivity,
  type ActivityRow,
  type WorkflowStatus,
  type WorkflowStepType,
} from '@/lib/api/workflows';

// ── the step sentence fragment ("Step 2 · Text the customer") ───────────────

// Keyed by WorkflowStepType (storage), not AuthorableStepType (authoring): this
// map renders steps that have already RUN, and a version published before the
// in-app step was retired (docs/adr/0005) still carries it. Dropping the key
// would render a real past run as a bare enum name.
const STEP_ACTION_LABEL: Record<WorkflowStepType, string> = {
  WAIT: 'Wait',
  SEND_TEXT: 'Text the customer',
  SEND_EMAIL: 'Send an email',
  NOTIFY_TEAM: 'Notify the team',
  STOP_IF: 'Check a condition',
};

function stepFragment(row: ActivityRow): string {
  const action = STEP_ACTION_LABEL[row.step_type] ?? row.step_type;
  return `Step ${row.step_index + 1} · ${action}`;
}

// ── relative time — "2m ago" / "3h ago" / "Jul 14" ───────────────────────────

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const diffMin = Math.round((Date.now() - then) / 60000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.round(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── the tab ───────────────────────────────────────────────────────────────────

/**
 * The empty state is also the "what's left to do?" hint, so it names only the
 * step still outstanding. Telling someone to publish an automation they already
 * published reads as if the publish silently failed.
 */
function emptyStateHint(status: WorkflowStatus | undefined, isEnabled: boolean | undefined): string {
  if (status !== 'PUBLISHED') return 'Nothing has run yet — publish and turn it on to start.';
  if (!isEnabled) return 'Nothing has run yet — turn it on to start.';
  return "Nothing has run yet — the first time it runs, you'll see it here.";
}

export default function WorkflowActivity({
  id,
  status,
  isEnabled,
}: {
  id: string | undefined;
  status?: WorkflowStatus;
  isEnabled?: boolean;
}) {
  const { data, isLoading } = useWorkflowActivity(id);
  const rows = data?.rows ?? [];

  if (isLoading) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <EmptyState
        variant="card"
        icon={History}
        title={emptyStateHint(status, isEnabled)}
        className="max-w-sm"
      />
    );
  }

  return (
    <div className="space-y-2.5">
      {rows.map((row) => (
        <ActivityRowCard key={row.id} row={row} />
      ))}
    </div>
  );
}

function ActivityRowCard({ row }: { row: ActivityRow }) {
  return (
    <div className="flex items-start gap-3 rounded-card border border-border bg-surface-light p-4 shadow-card">
      <StatusBadge domain="workflowStep" status={row.status} />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-text-primary">{row.detail ?? '—'}</p>
        <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs text-text-secondary">
          <span>{stepFragment(row)}</span>
          {row.entity_label && <span>· {row.entity_label}</span>}
          {row.recipient_summary && <span>· To {row.recipient_summary}</span>}
          {row.source === 'legacy' && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="inline-flex text-text-secondary/70">
                    <History className="h-3 w-3" aria-hidden />
                    <span className="sr-only">From the previous automations engine</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>From the previous automations engine</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
      </div>
      <span className="shrink-0 whitespace-nowrap text-xs text-text-secondary">{relativeTime(row.when)}</span>
    </div>
  );
}
