import { Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { computeLifecycle, type Stage, type StageKey } from '@/lib/jobs/lifecycle';
import type { JobFinancials } from '@/lib/api/jobs';
import { Button } from '@/components/ui/button';
import { availableActions, type JobVisitRow, type VisitMilestoneAction, type VisitVerb } from '@/lib/visits';
import { DEFAULT_SCHEDULE_TIMEZONE, formatInstant } from '@/lib/schedule-tz';
import { STATUS_REGISTRY, STATUS_INTENT_TEXT } from '@/design-system/status-registry';

/** Every JOB stage a click can act on. `created` is not actionable - you cannot un-create a job. */
export type ActionableNodeKey = Exclude<StageKey, 'created' | `visit:${string}`>;
const ACTIONABLE_NODES: readonly StageKey[] = [
  'scheduled', 'completed', 'invoice_sent', 'payment_received',
];
/** The two invoice nodes act on money, not status — see the `interactive` note below. */
const INVOICE_NODES: readonly StageKey[] = ['invoice_sent', 'payment_received'];

interface JobLifecycleBarProps {
  job: {
    created_at?: string | null;
    completed_at?: string | null;
    status: string;
    cancelled_at?: string | null;
  };
  financials: JobFinancials | undefined;
  /**
   * S5 (D11): the job's visits. Each one draws its own node, in place of the fixed Scheduled and
   * On Site nodes that were only ever visit one's properties.
   */
  visits?: JobVisitRow[];
  /**
   * S5: is the visit list still UNKNOWN - GET /api/jobs/:id/visits in flight, or failed?
   *
   * `visits` alone cannot say. The page's job query and its visits query run in parallel and
   * nothing gates the render on the second, so an unanswered fetch reaches here as `[]` - which
   * this component would otherwise read as "this job holds no trips" and draw the visit-less
   * shape over a job that holds three: a Scheduled node marked unreached, plus the JOB-level
   * Start, whose POST /api/jobs/:id/start lets the SERVER pick which trip to stamp (#1550's
   * class). On a failed fetch that state is permanent, not a flicker.
   */
  visitsUnknown?: boolean;
  /**
   * S5 (D7a): which lifecycle verbs may this principal drive on a visit? One flag PER VERB - the
   * four per-visit routes are gated on three different abilities. Absent means no.
   */
  visitAbilities?: Partial<Record<VisitVerb, boolean>>;
  /**
   * S5 (D11): a visit control names the ROW it belongs to. Not an index, not `visit_seq` - the id
   * the per-visit route takes. The job-level verbs resolve a visit server-side, so a control
   * wired to those stamps whichever trip the server picks (#1550's class).
   */
  onVisitAction?: (visitId: string, action: VisitMilestoneAction) => void;
  /** Per-node capability. A node the user cannot act on renders inert — no disabled affordance. */
  can?: {
    scheduled?: boolean; started?: boolean; completed?: boolean;
    invoice_sent?: boolean; payment_received?: boolean;
  };
  onNodeClick?: (key: ActionableNodeKey) => void;
  onStartClick?: () => void;
  /** Disables every control while a mutation is in flight. */
  busy?: boolean;
  /** The org's scheduling zone, which milestone dates are read on. Passed in rather than
   *  pulled from `useScheduleTimezone` here: this component is presentational, and the
   *  hook's `useQuery` would make every bare `render()` of it need a QueryClientProvider. */
  tz?: string;
}

/** Milestone dates read on the ORG's clock, so a node never shows a different day than
 *  the board or the schedule tile for a viewer outside that zone.
 *
 *  The catch is load-bearing, and predates this change: `toLocaleDateString` throws
 *  RangeError on an unrecognised zone, so a malformed `organization.timezone` would take
 *  the whole page down rather than drop one date label. */
function formatAt(at: string | null, tz: string): string | null {
  try {
    return formatInstant(at, tz, { month: 'short', day: 'numeric' }) || null;
  } catch {
    return null;
  }
}

export function JobLifecycleBar({
  job, financials, visits = [], visitsUnknown = false, visitAbilities = {}, onVisitAction,
  can, onNodeClick, onStartClick, busy = false,
  tz = DEFAULT_SCHEDULE_TIMEZONE,
}: JobLifecycleBarProps) {
  const stages = computeLifecycle(job, financials, visits);
  const isCancelled = !!job.cancelled_at;

  // A job with no visits is the most common state on this page, and D11 deleted the fixed
  // Scheduled node it used to book from. One unreached placeholder keeps that entry point - and
  // gives the job-level Start a home, which was anchored to the retired On Site node. Once any
  // trip exists, both belong to the trip: POST /api/jobs/:id/start is the urgent workflow's
  // entry point for a job that has no visit at all, and Job.started_at is the signal
  // deriveJobStatusFromVisits opens with.
  //
  // Only once the list is actually KNOWN, though: while it is not, the rail says nothing about
  // trips rather than asserting there are none.
  const nodes: Stage[] = visits.length === 0 && !visitsUnknown
    ? [
        stages[0]!,
        // Labelled 'Scheduled', which is what this node has always been called. Not 'Schedule':
        // the command-center header band already carries that exact word, and two identical
        // labels on one screen is a real ambiguity, not just a test-query one.
        { key: 'scheduled', label: 'Scheduled', at: null, reached: false, current: false },
        ...stages.slice(1),
      ]
    : stages;

  // Start is reachable only while the job is neither started nor past. Because a backward move
  // clears `started_at` and `completed_at`, moving back re-enables it automatically - no separate
  // rule needed.
  const canStart = !!can?.started && !job.completed_at && job.status !== 'IN_PROGRESS';

  return (
    <div className="space-y-2 pt-3 border-t border-border">
      {/* Cancelled badge */}
      {isCancelled && (
        <div className="flex items-center gap-2">
          <span className="inline-flex items-center rounded-full border border-danger/30 bg-danger/10 px-2.5 py-0.5 text-xs font-semibold text-danger">
            Cancelled
          </span>
        </div>
      )}

      {/* Stage nodes + connectors — evenly distributed across the full width.
          overflow-x-auto: the rail no longer has a fixed length (D11 gives every visit its own
          node), so without a scroller a job with several trips clips its last nodes away with no
          way to reach them. */}
      <div className="flex items-start pt-1 overflow-x-auto">
        {nodes.map((stage, idx) => {
          const isLast = idx === nodes.length - 1;
          const dateStr = formatAt(stage.at, tz);
          const visit = stage.visit;

          const isActionable = ACTIONABLE_NODES.includes(stage.key);
          const isInvoiceNode = INVOICE_NODES.includes(stage.key);
          const interactive =
            isActionable &&
            !!onNodeClick &&
            !!can?.[stage.key as keyof NonNullable<typeof can>] &&
            // Clicking a milestone the job has ALREADY reached is a no-op for a JOB node - it
            // would re-stamp the timestamp and re-arm the follow-up automation for nothing. For
            // an INVOICE node it is the most useful click there is: it opens the invoice.
            //
            // Read off `reached` - the node's OWN stamp - and not off `current`: since D11
            // `current` names the live VISIT whenever there is one, so a completed job that then
            // had a follow-up trip booked (job status is UNORDERED, Spec B1) left `current` on
            // the visit node and handed the Completed tick back its button. The only other
            // actionable job node is the visit-less Scheduled placeholder, which is never
            // reached, so it stays clickable exactly as before.
            (isInvoiceNode || !stage.reached);

          // A visit node's circle is display-only: the trip's own control sits under it, so the
          // click carries the row id rather than a stage key the server would have to resolve.
          const visitAction = visit && onVisitAction
            ? availableActions(visit.status, visitAbilities)[0]
            : undefined;

          const circle = (
            <div
              className={cn(
                'relative z-10 flex h-8 w-8 items-center justify-center rounded-full transition-colors',
                stage.current
                  ? 'border-2 border-primary bg-primary text-on-fill ring-4 ring-primary/15'
                  : stage.reached
                  ? 'bg-success text-on-fill'
                  : 'border-2 border-border bg-surface-light',
                interactive && 'group-hover:ring-4 group-hover:ring-primary/20',
              )}
            >
              {stage.reached ? (
                <Check className="h-4 w-4" strokeWidth={2.5} />
              ) : stage.current ? (
                <div className="h-2.5 w-2.5 rounded-full bg-on-fill" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-border" />
              )}
            </div>
          );

          // A visit node's OWN state, read through the shared registry - the same block both
          // Visits cards render a visit's status through, so a node and its row can never
          // disagree about the word. A cancelled trip greys through the registry's `neutral`
          // intent rather than a hand-picked class (D19: kept, numbered, greyed).
          const visitStatus = visit ? STATUS_REGISTRY.job[visit.status] : undefined;

          const label = (
            <span
              className={cn(
                'mt-2 text-center text-xs font-semibold leading-tight max-w-[88px]',
                stage.reached || stage.current ? 'text-text-primary' : 'text-text-secondary font-medium',
              )}
            >
              {stage.label}
              {visitStatus && (
                <span className={cn('block text-[11px] font-normal mt-0.5', STATUS_INTENT_TEXT[visitStatus.intent])}>
                  {visitStatus.label}
                </span>
              )}
              {dateStr && (
                <span className="block text-[11px] font-normal text-text-secondary mt-0.5">{dateStr}</span>
              )}
            </span>
          );

          return (
            // role="group" + the node's own label: with a node per visit the rail carries several
            // dates that differ only by which trip they belong to, so a reader needs the node
            // boundary announced to tell Visit 2's date from Visit 1's.
            <div
              key={stage.key}
              role="group"
              aria-label={stage.label}
              className="relative flex flex-1 flex-col items-center"
            >
              {/* Connector to the next node — sits behind the circles and spans
                  exactly one cell (this node's centre → the next node's centre),
                  so spacing is identical between every pair of steps. */}
              {!isLast && (
                <div
                  aria-hidden="true"
                  className={cn(
                    'absolute top-4 left-1/2 h-0.5 w-full -translate-y-1/2',
                    stage.reached ? 'bg-success' : 'bg-border',
                  )}
                />
              )}

              {interactive ? (
                // Left raw: wraps a composite lifecycle node (circle + label), a
                // heterogeneous click target, not Button-shaped.
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onNodeClick(stage.key as ActionableNodeKey)}
                  className="group flex flex-col items-center rounded-control focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:opacity-60"
                >
                  {circle}
                  {label}
                </button>
              ) : (
                <>
                  {circle}
                  {label}
                </>
              )}

              {/* Exactly ONE control per visit node - the next step in that trip's lifecycle.
                  The Button primitive rather than a second raw <button>: component-api-guard's
                  RAW_TAG_CEILINGS is a ratchet that may only decrease. */}
              {visit && visitAction && onVisitAction && (
                <Button
                  size="sm"
                  variant="solid" tone="business"
                  className="mt-2"
                  disabled={busy}
                  onClick={() => onVisitAction(visit.id, visitAction.action)}
                >
                  {visitAction.label}
                </Button>
              )}

              {/* Start belongs to the JOB, not to a trip, so it sits under the visit-less
                  placeholder. Once any visit exists the trip's own control above is the only
                  Start on screen. IN_PROGRESS is load-bearing - double-booking detection, the
                  board query and styling, and the dashboard KPIs all read it. */}
              {stage.key === 'scheduled' && canStart && onStartClick && (
                <Button
                  size="sm"
                  variant="solid" tone="business"
                  className="mt-2"
                  disabled={busy}
                  onClick={onStartClick}
                >
                  Start
                </Button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
