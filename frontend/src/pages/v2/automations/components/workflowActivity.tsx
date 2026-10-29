import { History } from 'lucide-react';

import { EmptyState } from '@/ui-kit/components/data/emptyState';
import { Skeleton } from '@/ui-kit/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/ui-kit/components/ui/tooltip';
import {
  useWorkflowActivity,
  type ActivityRow,
  type AudienceOutcome,
  type WorkflowStatus,
  type WorkflowStepType,
} from '@/lib/api/workflows';

import { EM_DASH, MIDDOT } from './glyphs';
import { WorkflowStepStatusChip } from './workflowVisuals';

/**
 * The Activity tab: a newest-first, plain-English feed of what actually ran and
 * why. The rows are the union of new WorkflowStepRun records and, for
 * workflows folded from the legacy engine, their pre-cutover history, exactly
 * as the endpoint returns it.
 *
 * Legacy rows carry a small history glyph so the office can tell old runs from
 * new ones without it reading as a second, confusing status.
 *
 * KNOWN, PRESERVED: `isError` is not consumed, so a failed fetch renders the
 * empty state and is indistinguishable from "nothing has run yet". That is
 * what the code does today; recorded in the branch ledger rather than fixed.
 */

// Keyed by WorkflowStepType (storage), not AuthorableStepType (authoring): this
// map renders steps that have already RUN, and a version published before the
// in-app step was retired (docs/adr/0005) still carries it. Dropping the key
// would render a real past run as a bare enum name.
const STEP_ACTION_LABEL: Record<WorkflowStepType, string> = {
  WAIT: 'Wait',
  // Spec C slice 8: this printed "Text the customer" for every text run whoever it went to,
  // which made a staff text read as a customer one in the only place an admin can check. The
  // row already renders "· To {recipient_summary}" beside it, so the action names the channel.
  SEND_TEXT: 'Send a text',
  SEND_EMAIL: 'Send an email',
  NOTIFY_TEAM: 'Notify the team',
  STOP_IF: 'Check a condition',
};

function stepFragment(row: ActivityRow): string {
  const action = STEP_ACTION_LABEL[row.step_type] ?? row.step_type;
  return `Step ${row.step_index + 1} ${MIDDOT} ${action}`;
}

const OUTCOME_WORD: Record<AudienceOutcome['outcome'], string> = {
  sent: 'Sent',
  skipped: 'Skipped',
  failed: 'Failed',
};

const OUTCOME_CLASS: Record<AudienceOutcome['outcome'], string> = {
  sent: 'text-success',
  skipped: 'text-muted-foreground',
  failed: 'text-danger',
};

/** "the customer" as stored, "The customer" at the head of a line. */
function capitalize(label: string): string {
  return label.charAt(0).toUpperCase() + label.slice(1);
}

/**
 * The per-audience breakdown beneath a send step. The step chip still answers "did
 * anything go?"; these lines answer "did the CUSTOMER get it?", which one chip cannot.
 * Absent (not an empty list) when the run recorded nothing per audience: a legacy
 * row, a wait or check step, or a run from before the ledger carried it.
 */
function AudienceBreakdown({ outcomes }: { outcomes: AudienceOutcome[] | undefined }) {
  if (!outcomes || outcomes.length === 0) return null;
  return (
    <ul aria-label="Outcome per audience" className="mt-1.5 space-y-0.5 text-xs">
      {outcomes.map((o, i) => (
        <li key={`${o.audience}-${i}`} className="flex flex-wrap items-baseline gap-x-1.5">
          <span className={`font-medium ${OUTCOME_CLASS[o.outcome]}`}>{OUTCOME_WORD[o.outcome]}</span>
          <span className="text-foreground">{capitalize(o.label)}</span>
          <span className="text-muted-foreground">{`${MIDDOT} ${o.summary}`}</span>
        </li>
      ))}
    </ul>
  );
}

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

/**
 * The empty state doubles as the "what is left to do?" hint, so it names only
 * the step still outstanding. Telling someone to publish an automation they
 * already published reads as if the publish silently failed. Keep all three
 * branches.
 */
function emptyStateHint(status: WorkflowStatus | undefined, isEnabled: boolean | undefined): string {
  if (status !== 'PUBLISHED') return `Nothing has run yet ${EM_DASH} publish and turn it on to start.`;
  if (!isEnabled) return `Nothing has run yet ${EM_DASH} turn it on to start.`;
  return `Nothing has run yet ${EM_DASH} the first time it runs, you'll see it here.`;
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
      <div className="border-border bg-kit-card mx-auto max-w-sm rounded-lg border">
        <EmptyState icon={<History aria-hidden />} title={emptyStateHint(status, isEnabled)} />
      </div>
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

/**
 * One run, as a row of three fixed jobs: what happened, what it says, when.
 *
 * The status chip gets a column of its OWN WIDTH rather than being the first
 * thing in a flex row. Chips are as wide as their label - "Sent" is half of
 * "Continued" - so a plain flex row started every line of copy at a different
 * x, and a feed whose left edge zig-zags row to row reads as unsorted even
 * though it is strictly newest-first. One width for the column and the
 * sentences line up under each other; the chips stay left-aligned inside it, so
 * the status is still the first thing the eye lands on.
 *
 * The two small top offsets are optical, not structural: a 19px chip and a 16px
 * timestamp both sit inside a 20px first line of copy, so each is nudged to the
 * centre of that line instead of to the top of the row.
 */
function ActivityRowCard({ row }: { row: ActivityRow }) {
  return (
    <div className="border-border bg-kit-card shadow-xs flex items-start gap-3 rounded-lg border p-4">
      <div className="mt-px flex w-[6.5rem] shrink-0 justify-start">
        <WorkflowStepStatusChip status={row.status} />
      </div>
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium">{row.detail ?? EM_DASH}</p>
        <div className="text-muted-foreground mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
          <span>{stepFragment(row)}</span>
          {row.entity_label && <span>{`${MIDDOT} ${row.entity_label}`}</span>}
          {row.recipient_summary && <span>{`${MIDDOT} To ${row.recipient_summary}`}</span>}
          {row.source === 'legacy' && (
            <TooltipProvider delayDuration={0}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span tabIndex={0} className="text-subtle-foreground inline-flex">
                    <History className="size-3" aria-hidden />
                    <span className="sr-only">From the previous automations engine</span>
                  </span>
                </TooltipTrigger>
                <TooltipContent>From the previous automations engine</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          )}
        </div>
        <AudienceBreakdown outcomes={row.audience_outcomes} />
      </div>
      <span className="text-muted-foreground mt-0.5 shrink-0 whitespace-nowrap text-xs">
        {relativeTime(row.when)}
      </span>
    </div>
  );
}
