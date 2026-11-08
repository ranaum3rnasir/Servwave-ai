/**
 * anchors.ts — the registry of entity DATE fields an anchored WAIT can target.
 *
 * An anchored WAIT parks until `anchorDate ± offset` instead of `now + duration`.
 * The anchor date is read from the EntityState the engine already loads per step.
 * Single source of truth for which entity exposes which anchor, so validation
 * (legal anchors per trigger entity) and the engine (how to read the date) never drift.
 */
import type { AutomationEntity } from './automationEntity';
import type { EntityState } from './context';

export type AnchorKey =
  | 'job.scheduled_start'
  | 'lead.walkthrough_scheduled_at'
  // ── Lead STAGE CLOCKS (spec #1751 D8) ────────────────────────────────────
  // These three are the OPENING edge of the three intervals a business owner polices, so an
  // owner's policy ("every lead is contacted within 4 hours") becomes an automation with
  // direction 'after' and an offset equal to the policy, rather than new code.
  //
  // They are ADDED, never substituted for 'lead.walkthrough_scheduled_at' above. That one
  // resolves against the lead's CURRENT visit and therefore moves both ways; it is correct for
  // the reminder it powers today ("one day before the walkthrough") and must not be quietly
  // repointed at a stage clock without deciding what existing reminders should do.
  | 'lead.created_at'
  | 'lead.contacted_at'
  // The estimate clock counts from the LATEST completed visit, not the first. Ratified by the
  // product owner after D4's "has the walkthrough phase closed?" prompt was rejected: at the
  // moment a trip ends the salesperson usually does not yet know whether another is needed, so
  // the prompt collects a guess and the SLA is then anchored on the guess. Every completion
  // re-anchors instead, which means nothing has to predict the future - a visit that is booked,
  // moved or cancelled moves no clock at all, only a completed one does.
  | 'lead.last_visit_completed_at'
  | 'invoice.due_date'
  | 'estimate.valid_until'
  // Spec B: the task due date - the eighth anchor, and the one that gives an entity both a
  // reminder and an overdue chase from a single trigger (TASK_DATE_ANCHORED, direction
  // 'before' and 'after'). Registered in slice 1 so the vocabulary was derived rather than
  // hand-copied; OFFERED from slice 5 - see ANCHORS_FOR_ENTITY.task below.
  | 'task.due_at';

export type WaitDirection = 'before' | 'after';

export interface AnchoredWaitConfig {
  mode: 'anchored';
  anchor: AnchorKey;
  direction: WaitDirection;
  offset_minutes: number;
}

/** Short noun for the recipe sentence ("wait until 1 day before the walkthrough"). */
export const ANCHOR_LABELS: Record<AnchorKey, string> = {
  'job.scheduled_start': 'the appointment',
  'lead.walkthrough_scheduled_at': 'the walkthrough',
  'lead.created_at': 'the lead arriving',
  'lead.contacted_at': 'first contact',
  'lead.last_visit_completed_at': 'the completed walkthrough',
  'invoice.due_date': 'the invoice due date',
  'estimate.valid_until': 'the estimate expiration',
  'task.due_at': 'the task due date',
};

/** Longer noun for the activity log ("1 day before the walkthrough time"). */
const ANCHOR_TIME_LABELS: Record<AnchorKey, string> = {
  'job.scheduled_start': 'the appointment time',
  'lead.walkthrough_scheduled_at': 'the walkthrough time',
  'lead.created_at': 'the lead arriving',
  'lead.contacted_at': 'the first contact',
  'lead.last_visit_completed_at': 'the walkthrough being completed',
  'invoice.due_date': 'the invoice due date',
  'estimate.valid_until': 'the estimate expiration date',
  'task.due_at': 'the task due date',
};

/**
 * Every anchor, derived from ANCHOR_LABELS rather than re-listed.
 *
 * ANCHOR_LABELS is a `Record<AnchorKey, string>`, so the compiler already forces it to name every
 * anchor; taking its keys makes this list exhaustive BY CONSTRUCTION. Spec #1751 D8 added three
 * anchors and found the trigger-config validator carrying its own hand-written copy of the set,
 * which is exactly the drift this removes — a hand-written copy silently rejects a new anchor the
 * builder is already offering.
 */
export const ALL_ANCHOR_KEYS = Object.keys(ANCHOR_LABELS) as [AnchorKey, ...AnchorKey[]];

/**
 * Which anchors a trigger's entity may use (drives builder options + validation).
 *
 * Keyed by the ONE named entity type (automationEntity.ts) rather than by a hand-written
 * copy of the union, so the sixth entity reddens here instead of silently offering nothing.
 */
export const ANCHORS_FOR_ENTITY: Record<AutomationEntity, AnchorKey[]> = {
  job: ['job.scheduled_start'],
  lead: [
    'lead.walkthrough_scheduled_at',
    'lead.created_at',
    'lead.contacted_at',
    'lead.last_visit_completed_at',
  ],
  estimate: ['estimate.valid_until'],
  invoice: ['invoice.due_date'],
  // Spec B slice 5. Added in the SAME change as the TASK_DATE_ANCHORED enum value, which is
  // what the earlier emptiness here was holding the door for: this list is what the builder
  // is served (catalog.ts's ANCHOR_OPTIONS) and what the validator accepts, so advertising
  // the anchor before its trigger_type could be stored would have let an admin compose a
  // workflow the API had to reject.
  //
  // One entry, and it gives the task BOTH directions from one trigger - a reminder before
  // the due date and an overdue chase after it - which is why Spec B has no separate
  // overdue trigger. Not a lead stage clock, so anchorDirections() leaves both legal.
  task: ['task.due_at'],
};

export function anchorDateFor(anchor: AnchorKey, state: EntityState): Date | null {
  switch (anchor) {
    case 'job.scheduled_start':
      return state.jobScheduledStart ?? null;
    case 'lead.walkthrough_scheduled_at':
      return state.leadWalkthroughScheduledAt ?? null;
    case 'lead.created_at':
      return state.leadCreatedAt ?? null;
    case 'lead.contacted_at':
      return state.leadContactedAt ?? null;
    case 'lead.last_visit_completed_at':
      return state.leadLastVisitCompletedAt ?? null;
    case 'invoice.due_date':
      return state.invoiceDueDate ?? null;
    case 'estimate.valid_until':
      return state.estimateValidUntil ?? null;
    case 'task.due_at':
      return state.taskDueAt ?? null;
    default:
      return null;
  }
}

export function isAnchoredWait(config: unknown): config is AnchoredWaitConfig {
  return Boolean(config && typeof config === 'object' && (config as { mode?: unknown }).mode === 'anchored');
}

function humanizeOffset(minutes: number): string {
  if (minutes === 0) return '0 minutes';
  if (minutes % (60 * 24) === 0) { const d = minutes / (60 * 24); return `${d} ${d === 1 ? 'day' : 'days'}`; }
  if (minutes % 60 === 0) { const h = minutes / 60; return `${h} ${h === 1 ? 'hour' : 'hours'}`; }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/** "1 day before the walkthrough time" — activity-log copy for a completed anchored wait. */
export function describeAnchoredWait(cfg: AnchoredWaitConfig): string {
  return `${humanizeOffset(cfg.offset_minutes)} ${cfg.direction} ${ANCHOR_TIME_LABELS[cfg.anchor]}`;
}

/**
 * For the three stage-clock anchors: which LATER clock, once set, means the thing the owner was
 * waiting for has now happened.
 *
 * D8 is explicit that "…and it still has not happened" is NOT expressible in the candidate sweep,
 * which selects purely on the anchor date. It belongs in the execution-time staleness guard,
 * beside the rules that already drop lost and cancelled leads. Putting it in the sweep would
 * force ONE allow-list onto both directions and get one of them wrong — the same reasoning
 * already recorded on the existing lead anchor in dateAnchorSweep.ts.
 *
 * Only 'after' consults this. A 'before' reminder on these anchors is a countdown to a moment
 * that has already been recorded (the lead arrived; contact happened), so there is nothing
 * outstanding for it to go stale against.
 *
 * The two anchors that are not stage clocks are absent on purpose rather than mapped to
 * undefined: 'lead.walkthrough_scheduled_at' has its own, older and subtler, staleness rule, and
 * a mapping here would invite someone to route it through this one.
 */
export const LEAD_ANCHOR_SATISFIED_BY: Partial<
  Record<
    AnchorKey,
    {
      /** The NEXT clock along: once it carries a value, the thing being chased has happened. */
      field: 'leadContactedAt' | 'leadWalkthroughFirstBookedAt' | 'leadFirstEstimateSentAt';
      happened: string;
      /**
       * Set ONLY for clocks that can move after an enrollment has been keyed on them. Absent is a
       * claim about the clock rather than an omission: `lead.created_at` is written once, by the
       * database, and can never mint a second occurrence for `terminalStale` to compare against.
       */
      moves?: {
        field: 'leadContactedAt' | 'leadLastVisitCompletedAt';
        superseded: string;
      };
    }
  >
> = {
  'lead.created_at': { field: 'leadContactedAt', happened: 'Lead has since been contacted' },
  'lead.contacted_at': {
    field: 'leadWalkthroughFirstBookedAt',
    happened: 'Walkthrough has since been booked',
    // The correction door (POST /leads/:id/contact), which D5 names as the single deliberate
    // exception to first-touch-wins.
    moves: {
      field: 'leadContactedAt',
      superseded: 'First contact was corrected — this run was replaced by an updated one',
    },
  },
  'lead.last_visit_completed_at': {
    field: 'leadFirstEstimateSentAt',
    happened: 'Estimate has since been sent',
    // Moves on EVERY completion, which is the entire reason the estimate clock is anchored here
    // rather than on the first one: a second trip restarts the countdown instead of leaving the
    // salesperson accruing lateness against a trip that turned out not to be the last.
    moves: {
      field: 'leadLastVisitCompletedAt',
      superseded: 'A later visit was completed — this run was replaced by one counting from it',
    },
  },
  // ─── NOTE ──────────────────────────────────────────────────────────────────────────────────
  // The three keys of this map ARE the three stage-clock anchors, and LEAD_STAGE_CLOCK_ANCHORS
  // below derives that set from them. Adding a fourth stage clock here also makes it rejectable
  // for direction 'before' and correctly guarded at execution time, with nothing else to update.
};

/**
 * The three stage-clock anchors as a set, DERIVED from LEAD_ANCHOR_SATISFIED_BY rather than
 * re-listed here.
 *
 * `direction: 'before'` is constructible on these three and can never fire. A stage clock records
 * a moment AS IT HAPPENS, so the row only carries a date once that moment is already in the past,
 * and the forward window `candidatesForAnchor` selects will never contain it. A "two hours before
 * the lead arrives" rule would sit silent for ever with nothing anywhere going red.
 *
 * `workflowValidation.ts` rejects it on save, so the builder cannot store one. The comment on
 * LEAD_ANCHOR_SATISFIED_BY above and `terminalStale`'s LEAD_DATE_ANCHORED case both already say
 * 'before' is meaningless here; this is the same statement made enforceable.
 *
 * Derived, because a hand-written second copy of this set is exactly the drift that made D8 fold
 * the trigger validator's own anchor list back into ALL_ANCHOR_KEYS.
 */
export const LEAD_STAGE_CLOCK_ANCHORS: ReadonlySet<AnchorKey> = new Set(
  Object.keys(LEAD_ANCHOR_SATISFIED_BY) as AnchorKey[],
);
