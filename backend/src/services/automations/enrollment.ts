/**
 * enrollment.ts — the multi-step Workflow engine's enrollment walker.
 *
 * The successor to the retired engine.ts's createRunsForEvent/executeRun (legacy
 * rules now run as folded one-step workflows). An enrollment carries a step cursor plus
 * `resume_at`; this module enrolls entities into published workflows and walks
 * each one through its steps — parking at Waits/send-windows, stopping on stale
 * or stop-if conditions, and sending along the way.
 *
 * Two mechanisms preserve every correctness guarantee under concurrency:
 *  - the step-run UNIQUE (enrollment_id, step_index) insert is the per-step
 *    CLAIM — exactly one worker owns a given step, so no double-send;
 *  - the cursor COMPARE-AND-SET (updateMany WHERE step_cursor = expected) is the
 *    anti-double-advance — a racing worker whose CAS matches 0 rows stops.
 *
 * Contract: nothing here throws to the caller. Per-workflow / per-advance
 * failures are logged and recorded on the step-run row (mirrors engine.ts).
 */

import { WorkflowStepType, AutomationActionType, WorkflowEnrollmentStatus, AutomationTriggerType, Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { DEFAULT_TIMEZONE } from '../../lib/timezone';
import { hasFeature } from '../../lib/entitlements/resolve';
import { buildDedupeKey } from './dedupe';
import { shiftIntoWindow } from './sendWindow';
import { loadExecutionBundle, type EventPayload } from './context';
import { executeAction, type ExecutionResult } from './executors';
import { stopIfHolds, stopIfReason } from './stopIf';
import { terminalStaleReason } from './terminalStale';
import { isAnchoredWait, anchorDateFor, ANCHOR_LABELS, describeAnchoredWait, type AnchoredWaitConfig } from './anchors';
import { isSupportedStepType } from './workflowValidation';
import type { WorkflowDefinition, DateAnchorTriggerConfig } from './workflowValidation';
import type { AutomationEvent } from './dispatch';

function isUniqueViolation(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as { code?: string }).code === 'P2002');
}

/**
 * SRVW-113 — unlike every other event trigger, matching on trigger_type +
 * org + enabled isn't enough for JOB_SUB_STATUS_ENTERED: two workflows can
 * watch two DIFFERENT sub-statuses, so a workflow only enrolls when its
 * configured sub_status_id matches the event's actual occurrence. Kept
 * narrow and trigger-specific here rather than a general condition engine —
 * that's a separate card.
 */
function matchesSubStatusPredicate(workflow: { trigger_type: AutomationTriggerType; trigger_config: unknown }, occurrenceKey?: string): boolean {
  if (workflow.trigger_type !== 'JOB_SUB_STATUS_ENTERED') return true;
  const cfg = workflow.trigger_config as { sub_status_id?: string } | null;
  return Boolean(cfg?.sub_status_id) && cfg!.sub_status_id === occurrenceKey;
}

/**
 * WorkflowStepType → the executor's AutomationActionType (SEND_TEXT→SEND_SMS).
 * Null for every step this build does not dispatch: WAIT and STOP_IF, which
 * never did, and the retired in-app step, which no longer does (docs/adr/0005).
 *
 * The retired label used to map to its historic action here. That case was
 * unreachable once `advanceEnrollment` grew its `isSupportedStepType` guard, but
 * it was also the last executable line in this file that a grep for the label
 * could read as a live send path - and its unreachability depended on the
 * ordering of two branches rather than on anything the function itself said.
 * Returning null makes this agree with `isSupportedStepType`, which is what
 * makes the non-null assertion at the `executeAction` call true by construction.
 * The other direction is untouched: `migrateRules.ts` still maps a legacy
 * AutomationRule's action onto the step label storage recorded for it.
 */
export function mapStepToActionType(step: WorkflowStepType): AutomationActionType | null {
  switch (step) {
    case 'SEND_TEXT':
      return 'SEND_SMS';
    case 'SEND_EMAIL':
      return 'SEND_EMAIL';
    default:
      return null; // WAIT, STOP_IF, and the retired in-app step
  }
}

/** The step types that actually deliver something, and so wait for the send window.
 *  NOTIFY_TEAM is deliberately absent: it is retired (ADR 0005), and a retired step
 *  should be skipped the moment its enrollment reaches it rather than parked until
 *  08:00 to be skipped then. */
const MESSAGING_STEPS: ReadonlySet<WorkflowStepType> = new Set<WorkflowStepType>([
  'SEND_TEXT',
  'SEND_EMAIL',
]);

/**
 * The Activity-tab copy for a published-but-retired in-app step. Published versions
 * are immutable - their step list is frozen JSON on the version row - so a version
 * published before the retirement carries NOTIFY_TEAM for ever. Such a step SKIPS
 * (user story 23: it stops sending rather than breaking the workflow) and the admin
 * reads product copy, not the executor's internal `Unknown action type` string.
 */
export const RETIRED_IN_APP_STEP_DETAIL =
  'In-app notifications now come from the bell - this step no longer sends.';

/** The same, for any other stored step type this build cannot run. There is none today. */
export const UNRUNNABLE_STEP_DETAIL = 'This step is no longer supported and did not send.';

/** The unified triggers whose trigger_config carries a `direction` (Task A2/A5b) - every other
 *  trigger type has no direction concept, so terminalStaleReason gets `undefined` for it instead.
 *
 *  HAND-WRITTEN, and a missing member is silent: nothing throws, the enrollment still runs, and
 *  terminalStaleReason simply receives `undefined` for both direction and anchor - which its own
 *  docblock records as failing OPEN for the already-passed checks and closed for others. So an
 *  omission here does not break a reminder loudly; it makes it behave as though no direction had
 *  ever been configured. */
const DATE_ANCHORED_TRIGGER_TYPES: ReadonlySet<AutomationTriggerType> = new Set<AutomationTriggerType>([
  'JOB_DATE_ANCHORED',
  'LEAD_DATE_ANCHORED',
  'INVOICE_DATE_ANCHORED',
  'ESTIMATE_DATE_ANCHORED',
  // Spec B slice 5: one trigger carrying both a before-reminder and an overdue chase, so the
  // direction is the whole difference between the two and MUST reach the staleness check.
  'TASK_DATE_ANCHORED',
]);

/**
 * The provisional detail written at claim time. A row still carrying it after a
 * crash means the step's outcome is UNKNOWABLE (the send may or may not have
 * gone out) — the recovery sweeper closes such enrollments instead of retrying
 * (at-most-once is the only safe policy for customer messaging).
 */
export const PROVISIONAL_CLAIM_DETAIL = 'Interrupted mid-step';

/** Plain-English wait duration for the activity log: '1 hour', '2 days', '45 minutes'. */
function humanizeDuration(minutes: number): string {
  if (minutes % (60 * 24) === 0) {
    const days = minutes / (60 * 24);
    return `${days} ${days === 1 ? 'day' : 'days'}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} ${hours === 1 ? 'hour' : 'hours'}`;
  }
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Rule 0's carrier. The acting user cannot be threaded in memory - advanceEnrollment
 * takes only an enrollment id, and the cron sweeper resumes a parked enrollment long
 * after the request is gone - so it is folded into the same event_payload JSON that
 * already carries the removed recipient and the request-time merge fields, and is
 * re-read on every step (block 6). An event carrying NOTHING - no merge fields, no
 * override recipient, no actor - still yields undefined here, so createEnrollment
 * writes event_payload null rather than starting every row off with { actorId: null }.
 */
function eventPayloadWithActor(ev: AutomationEvent): EventPayload | undefined {
  if (!ev.actorId) return ev.eventPayload;
  return { ...(ev.eventPayload ?? {}), actorId: ev.actorId };
}

/**
 * Enroll every published + enabled matching workflow for this event, then walk
 * each one inline. Per-workflow try/catch keeps one bad workflow from blocking
 * the others (the retired engine.ts's createRunsForEvent idiom). Never throws.
 */
export async function enrollOnEvent(ev: AutomationEvent, now: Date = new Date()): Promise<void> {
  const workflows = await prisma.workflow.findMany({
    where: {
      organization_id: ev.organizationId,
      trigger_type: ev.type,
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
    },
  });
  if (workflows.length === 0) return;

  const eventPayload = eventPayloadWithActor(ev);

  for (const workflow of workflows) {
    if (!matchesSubStatusPredicate(workflow, ev.occurrenceKey)) continue;
    try {
      const created = await createEnrollment({
        workflow: {
          id: workflow.id,
          published_version_id: workflow.published_version_id,
          trigger_type: workflow.trigger_type,
          organization_id: workflow.organization_id,
          legacy_rule_id: workflow.legacy_rule_id,
        },
        entity: ev.entity,
        occurrenceKey: ev.occurrenceKey,
        visitId: ev.visitId,
        // D6: TRUE here and nowhere else. A dispatch occurrence is minted fresh at dispatch time,
        // so a visit-scoped key cannot collide with a historical one - which is what makes D18's
        // "visit 2 is not a duplicate of visit 1" free on this door and expensive on the cron one.
        visitScopedDedupe: true,
        eventPayload,
        now,
      });
      if (created) {
        await advanceEnrollment(created.id, now);
      }
    } catch (err) {
      logger.warn('[workflows] enrollOnEvent failed for workflow — continuing', {
        workflowId: workflow.id,
        trigger: ev.type,
        entityId: ev.entity.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Create one enrollment for a workflow + entity + occurrence. Used by
 * enrollOnEvent AND the poller's timed scan (Task 7). Returns { id } or null on
 * a dedupe collision (already enrolled - the idempotency guarantee), a denied
 * entitlement check, or any error. Never throws.
 */
export async function createEnrollment(args: {
  workflow: {
    id: string;
    published_version_id: string | null;
    trigger_type: string;
    organization_id: string;
    legacy_rule_id?: string | null;
  };
  entity: { type: string; id: string; label?: string | null };
  occurrenceKey?: string;
  /**
   * WHICH VISIT this enrollment is about. PERSISTED to `workflow_enrollments.visit_id`, and that
   * is all it does on its own (spec 2026-09-14-per-visit-automation-enrollment, D1): the context
   * reads it back and resolves THAT trip, so the merge fields, the EntityState, the anchored
   * WAIT's fire moment, `stopIf`, `terminalStale` and `rearmAnchoredWaits` are all fixed by the
   * one edit, with no override layer added on top.
   *
   * Whether it ALSO joins the dedupe key is a separate question with a separate parameter - see
   * `visitScopedDedupe` below, and D6.
   */
  visitId?: string;
  /**
   * D6 — does `visitId` also join the DEDUPE key (`entityId:visitId`, dedupe.ts)?
   *
   * TRUE only on the dispatch doors (`enrollOnEvent`), where multi-visit D18 needs it so visit 2's
   * notification is not swallowed as a duplicate of visit 1's, and where it is FREE: those
   * occurrences are freshly minted millisecond stamps (`JOB_EN_ROUTE` = `en_route_at`,
   * `JOB_RESCHEDULED` = the new start) or are guarded once-per-job by a persisted column, so a
   * new-format key can never collide with a historical one and no enrollment in flight moves.
   *
   * FALSE - by omission, which is the safe default - on the three cron sweeps. Their occurrence is
   * a visit's FUTURE `scheduled_at`, a value historical rows already hold, so widening the key
   * there would stop a historical row colliding and re-enrol every visit still inside the
   * trigger's lead-time window: one duplicate reminder per customer, across every organisation, on
   * deploy day. The id would buy those keys nothing anyway - two trips at different times already
   * mint two keys and already both enrol.
   *
   * The rule, stated once: scope the dedupe key by visit ONLY where the occurrence is minted fresh
   * at dispatch time. Getting it backwards is silent in tests and loud in customers' inboxes,
   * which is why it is a named parameter rather than "pass visitId and see".
   */
  visitScopedDedupe?: boolean;
  /** Whatever the triggering event captured that the live entity won't have later — see context.ts. */
  eventPayload?: EventPayload;
  now: Date;
}): Promise<{ id: string } | null> {
  const { workflow, entity, occurrenceKey, visitId, visitScopedDedupe, eventPayload, now } = args;
  try {
    // Gate at the point of effect (docs/adr/0001): this is the ONE choke point
    // every enrollment path funnels through - enrollOnEvent's per-workflow loop
    // AND cron.ts's date-anchored sweep both call createEnrollment directly, so
    // gating here (rather than only in enrollOnEvent) is what survives a plan
    // downgrade, a hand-built workflow, or any future dispatch site. Nav/route/API
    // gates never run for this path - nothing here is a request. Fail closed: a
    // missing org row or an unrecognized plan denies rather than enrolling. (#1069)
    const org = await prisma.organization.findUnique({
      where: { id: workflow.organization_id },
      select: { plan: true, trial_ends_at: true, feature_overrides: true },
    });
    // feature_overrides is JSONB (Prisma.JsonValue); hasFeature only ever reads
    // it as a plain object map, matching every other entitlement call site.
    const entitlementSource = org && { ...org, feature_overrides: org.feature_overrides as Record<string, unknown> | null };
    if (!entitlementSource || !hasFeature(entitlementSource, 'automations')) {
      logger.info('[workflows] createEnrollment denied - organization not entitled to automations', {
        organizationId: workflow.organization_id,
        workflowId: workflow.id,
      });
      return null;
    }

    // The trigger prefix is redundant under workflow scoping but harmless, and
    // it preserves the occurrence-required validation the helper enforces.
    const dedupeKey = buildDedupeKey(
      workflow.trigger_type as AutomationTriggerType,
      entity.id,
      occurrenceKey,
      visitScopedDedupe ? visitId : undefined,
    );

    // Cross-engine cutover guard: during a deploy overlap (or while another
    // service on the shared DB still runs the legacy engine), the OLD engine may
    // create/execute an automation_run for this same occurrence. Its ledger is
    // disjoint from ours, so honor it for folded workflows: a legacy run with the
    // same dedupe_key owns the occurrence — never message it a second time. The
    // next deploy's continuity migration folds that run into a terminal
    // enrollment, after which this lookup simply never matches again.
    if (workflow.legacy_rule_id) {
      const legacyRun = await prisma.automationRun.findUnique({
        where: { rule_id_dedupe_key: { rule_id: workflow.legacy_rule_id, dedupe_key: dedupeKey } },
        select: { id: true },
      });
      if (legacyRun) return null;
    }
    const enrollment = await prisma.workflowEnrollment.create({
      data: {
        workflow_id: workflow.id,
        workflow_version_id: workflow.published_version_id!,
        status: 'ACTIVE',
        entity_type: entity.type,
        entity_id: entity.id,
        entity_label: entity.label ?? null,
        occurrence_key: occurrenceKey ?? null,
        dedupe_key: dedupeKey,
        // The trip this enrollment is about, or NULL for the per-entity triggers and for anything
        // whose caller did not name one. NULL is not a degraded state - it is today's behaviour,
        // which is what every row written before this column existed keeps (D10: no back-fill,
        // because inferring a trip from occurrence_key would guess at exactly the ambiguity - two
        // trips at one minute - that causes the bug).
        visit_id: visitId ?? null,
        step_cursor: 0,
        resume_at: now,
        organization_id: workflow.organization_id,
        event_payload: (eventPayload ?? null) as unknown as Prisma.InputJsonValue,
      },
    });
    // The automations list counts RUNS - "Ran N times", "last X ago", "Runs
    // all-time" - and one enrollment IS one run, so the count belongs here, at the
    // one choke point every enrollment path funnels through. It used to be bumped
    // per SENT step inside advanceEnrollment instead, which was wrong in both
    // directions (#1882): a run whose every send SKIPPED never moved it at all -
    // an audience emptied by Rule 0, a customer with no mobile on file - so the
    // list claimed the automation had not fired since before the run; and a
    // workflow with two send steps scored 2 for a single firing. A dedupe collision
    // throws out of the create above and never reaches this, so rescanning one
    // occurrence still counts once.
    //
    // Its own try/catch: a failed counter is a cosmetic loss, and must never make a
    // created enrollment report itself as not-created (the caller would skip the
    // inline advance).
    try {
      await prisma.workflow.update({
        where: { id: workflow.id },
        data: { trigger_count: { increment: 1 }, last_triggered_at: now },
      });
    } catch (err) {
      logger.warn('[workflows] run counter update failed - the enrollment stands', {
        workflowId: workflow.id,
        enrollmentId: enrollment.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return { id: enrollment.id };
  } catch (err) {
    if (isUniqueViolation(err)) return null; // already enrolled for this occurrence
    logger.warn('[workflows] createEnrollment failed', {
      workflowId: workflow.id,
      entityId: entity.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Why an enrollment whose loader returned null is stopping — D4 of the per-visit-enrollment spec.
 *
 * When the enrollment names a VISIT, the visit is what it says, not the parent: the parent is
 * usually perfectly alive, and "The job no longer exists" sent an admin looking at a job sitting
 * right there in the list. Both readings are true of a deleted parent (its trips go with it), so
 * naming the visit is the honest answer in every case where one was carried.
 *
 * The STOP itself is the point, and it is what makes the missing foreign key safe (D2). A fallback
 * to the parent's own resolution would hand the customer a DIFFERENT trip's date, address and
 * crew, which is the defect this spec removes - the precedent is `deletedTaskBundle`, on the
 * principle that a message about work that has been destroyed is worse than silence.
 *
 * USER-VISIBLE COPY: it lands in the activity log's "Stopped — …" line, so it names the thing in
 * the product's own words.
 */
function missingEntityReason(enrollment: { entity_type: string; visit_id: string | null }): string {
  return enrollment.visit_id ? 'The visit no longer exists' : `The ${enrollment.entity_type} no longer exists`;
}

async function finishEnrollment(
  id: string,
  status: WorkflowEnrollmentStatus,
  reason: string,
  now: Date,
): Promise<void> {
  await prisma.workflowEnrollment.update({
    where: { id },
    data: { status, finished_at: now, finished_reason: reason },
  });
}

/**
 * Cursor compare-and-set: advance step_cursor from `cursor` to `cursor + 1` only
 * if the row is still ACTIVE at exactly that cursor. Returns true when this
 * caller won the advance (count === 1); false means someone else moved it (or it
 * finished) and this caller must stop.
 */
async function casCursor(id: string, cursor: number, resumeAt: Date): Promise<boolean> {
  const res = await prisma.workflowEnrollment.updateMany({
    where: { id, step_cursor: cursor, status: 'ACTIVE' },
    data: { step_cursor: cursor + 1, resume_at: resumeAt },
  });
  return res.count === 1;
}

/**
 * Walk an ACTIVE, due enrollment through its steps until it parks (Wait /
 * send-window), stops (stale / stop-if / entity gone / disabled), or completes.
 * Never throws — a mid-step failure is logged and recorded FAILED on the claimed
 * step-run (the retired engine.ts's executeRun idiom).
 */
export async function advanceEnrollment(enrollmentId: string, now: Date = new Date()): Promise<void> {
  // The step-run row claimed by the CURRENT iteration; the catch-all records a
  // FAILED outcome on it if the iteration blows up mid-step. Reset every loop so
  // a later throw can never clobber an already-resolved earlier step.
  let claimedStepRunId: string | null = null;
  try {
    const enrollment = await prisma.workflowEnrollment.findUnique({
      where: { id: enrollmentId },
      include: { version: true, workflow: true },
    });
    // Selection is the poller's job; waking is idempotent.
    if (!enrollment || enrollment.status !== 'ACTIVE' || enrollment.resume_at.getTime() > now.getTime()) {
      return;
    }

    const org = await prisma.organization.findUnique({
      where: { id: enrollment.organization_id },
      select: { timezone: true },
    });
    const tz = org?.timezone || DEFAULT_TIMEZONE;

    const def = enrollment.version.definition as unknown as WorkflowDefinition;
    const steps = [...def.steps].sort((a, b) => a.position - b.position);

    // The PINNED trigger governs execution semantics (staleness + occurrence
    // narrowing). The live workflow row's trigger_type can be edited mid-flight
    // (drafts are editable even while published); judging an old enrollment's
    // entity state by the NEW trigger would corrupt the staleness logic.
    const pinnedTrigger = (def.trigger_type ?? enrollment.workflow.trigger_type) as AutomationTriggerType;

    // direction is only meaningful for the four date-anchored triggers (their
    // trigger_config is {anchor, direction, offset_minutes} — Task A4); every
    // other trigger type passes `undefined` through to terminalStaleReason,
    // which is exactly how those calls behaved before this parameter existed.
    // Computed ONCE here (pinnedTrigger/def are already fixed for this whole
    // advance) and reused at both terminalStaleReason call sites below, so
    // there is no risk of the two sites computing it differently.
    const direction = DATE_ANCHORED_TRIGGER_TYPES.has(pinnedTrigger)
      ? (def.trigger_config as DateAnchorTriggerConfig | null)?.direction
      : undefined;
    // Spec #1751 D8: LEAD_DATE_ANCHORED now covers four anchors with different staleness rules,
    // so the anchor has to reach terminalStaleReason too. Read off the PINNED definition for the
    // same reason `direction` is — judging an old enrollment by an edited workflow's anchor
    // would corrupt the staleness logic — and computed once, so the two call sites below cannot
    // disagree.
    const anchor = DATE_ANCHORED_TRIGGER_TYPES.has(pinnedTrigger)
      ? (def.trigger_config as DateAnchorTriggerConfig | null)?.anchor
      : undefined;

    let cursor = enrollment.step_cursor;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      claimedStepRunId = null;
      const step = steps[cursor];

      // 2 — ran off the end
      if (!step) {
        await finishEnrollment(enrollmentId, 'COMPLETED', 'Completed all steps', now);
        return;
      }

      // 3 — workflow disabled mid-flight
      if (!enrollment.workflow.is_enabled) {
        await finishEnrollment(enrollmentId, 'STOPPED', 'Automation was turned off', now);
        return;
      }

      // 4 — send-window pre-check (send steps only, BEFORE claiming). Park with
      //     NO step-run row: cursor unchanged, racers write the same value.
      if (MESSAGING_STEPS.has(step.step_type)) {
        const fireAt = shiftIntoWindow(now, def.send_window, tz);
        if (fireAt.getTime() > now.getTime()) {
          await prisma.workflowEnrollment.updateMany({
            where: { id: enrollmentId, step_cursor: cursor, status: 'ACTIVE' },
            data: { resume_at: fireAt },
          });
          return;
        }
      }

      // 4b — ANCHORED WAIT (pre-claim). Timing hangs off a live entity date, not
      //      "now + duration". Not-yet-due → park AT this step with NO claim row
      //      (mirrors the send-window park at block 4) so a reschedule can re-arm
      //      resume_at (Task 5) and the next wake re-reads the anchor. Due → claim +
      //      record CONTINUED + advance. Legacy relative waits fall through to block 8.
      if (step.step_type === 'WAIT' && isAnchoredWait(step.config)) {
        const cfg = step.config as AnchoredWaitConfig;
        // event_payload and the pinned trigger are passed for the SAME reason block 6 passes
        // them, and their absence here was a real hole: a TASK_DELETED workflow whose first
        // step is an anchored WAIT would die on THIS guard with "The task no longer exists"
        // while the identical workflow without a wait worked - the shape of bug that reaches
        // production because the happy-path test has no wait in it. The bundle this yields
        // carries no EntityState, so the anchor below cannot resolve and the enrollment stops
        // for the anchor's own honest reason instead: there is no due date left to count from.
        const loadedForWait = await loadExecutionBundle({
          entityType: enrollment.entity_type,
          entityId: enrollment.entity_id,
          entityLabel: enrollment.entity_label,
          organizationId: enrollment.organization_id,
          dedupeKey: enrollment.dedupe_key,
          eventPayload: enrollment.event_payload as EventPayload | null,
          trigger: pinnedTrigger,
          // The trip this enrollment is about (spec 2026-09-14). Threaded HERE as well as at block
          // 6 because this is where the anchor is read: without it the wait counts down to the
          // parent's own next trip, so a reminder for Thursday fires on Monday.
          visitId: enrollment.visit_id,
        });
        if (!loadedForWait) {
          await finishEnrollment(enrollmentId, 'STOPPED', missingEntityReason(enrollment), now);
          return;
        }
        const waitStale = terminalStaleReason(pinnedTrigger, enrollment.occurrence_key ?? undefined, loadedForWait.state, now, direction, anchor);
        if (waitStale) {
          await finishEnrollment(enrollmentId, 'STOPPED', waitStale, now);
          return;
        }
        const anchorDate = anchorDateFor(cfg.anchor, loadedForWait.state);
        if (!anchorDate) {
          await finishEnrollment(enrollmentId, 'STOPPED', `${ANCHOR_LABELS[cfg.anchor]} is no longer scheduled`, now);
          return;
        }
        const target = new Date(anchorDate.getTime() + (cfg.direction === 'before' ? -1 : 1) * cfg.offset_minutes * 60_000);
        if (target.getTime() > now.getTime()) {
          // Deliberately writes ONLY resume_at — occurrence_key is left as-is (the
          // enrollment's originally-pinned date, or whatever rearmAnchoredWaits last
          // synced while parked here). rearmAnchoredWaits is the sole place that
          // re-syncs occurrence_key, and only for enrollments it finds CURRENTLY
          // parked at THIS anchored WAIT step — syncing it from anywhere else would
          // let a superseded enrollment slip past the terminal-staleness check (7)
          // and reopen the reschedule double-send hole RESCHEDULE_TRIGGER guards
          // against below. So a fires-once reminder parked at an earlier
          // (non-anchored) step during a reschedule keeps its now-stale
          // occurrence_key on purpose: safe-direction — it may get dropped by
          // staleness once it reaches this step, but it can never double-send.
          await prisma.workflowEnrollment.updateMany({
            where: { id: enrollmentId, step_cursor: cursor, status: 'ACTIVE' },
            data: { resume_at: target },
          });
          return;
        }
        // due — claim (idempotent), record CONTINUED, advance
        try {
          await prisma.workflowStepRun.create({
            data: {
              enrollment_id: enrollmentId,
              step_index: cursor,
              step_type: 'WAIT',
              status: 'CONTINUED',
              detail: `Waited until ${describeAnchoredWait(cfg)}`,
              executed_at: now,
              organization_id: enrollment.organization_id,
            },
          });
        } catch (err) {
          if (isUniqueViolation(err)) return;
          throw err;
        }
        if (!(await casCursor(enrollmentId, cursor, now))) return;
        cursor += 1;
        continue;
      }

      // 5 — CLAIM: the unique insert IS the claim. A pessimistic FAILED
      //     provisional means a crash between claim and outcome leaves an honest
      //     ledger row. P2002 → another worker owns this step; stop.
      let stepRunId: string;
      try {
        const stepRun = await prisma.workflowStepRun.create({
          data: {
            enrollment_id: enrollmentId,
            step_index: cursor,
            step_type: step.step_type,
            status: 'FAILED',
            detail: PROVISIONAL_CLAIM_DETAIL,
            executed_at: now,
            organization_id: enrollment.organization_id,
          },
        });
        stepRunId = stepRun.id;
      } catch (err) {
        if (isUniqueViolation(err)) return;
        throw err;
      }
      claimedStepRunId = stepRunId;

      // 6 — load entity fresh every step. event_payload rides along on every
      // load (not just the first) so a removed-recipient/free-text value
      // captured at enrollment survives however many WAIT steps precede the send.
      //
      // The PINNED trigger goes with it, and does exactly one thing: it lets the task arm
      // synthesise a bundle for a row that is GONE, for TASK_DELETED and nothing else (Spec B
      // slice 4 - context.ts's deletedTaskBundle). A task is hard-deleted, so a workflow about
      // the deletion has no entity left to read; every other entity, and every other task
      // trigger, still gets null here and still stops on the guard below.
      const loaded = await loadExecutionBundle({
        entityType: enrollment.entity_type,
        entityId: enrollment.entity_id,
        entityLabel: enrollment.entity_label,
        organizationId: enrollment.organization_id,
        dedupeKey: enrollment.dedupe_key,
        eventPayload: enrollment.event_payload as EventPayload | null,
        trigger: pinnedTrigger,
        // Which trip this enrollment is about (spec 2026-09-14). Re-read on EVERY step, like the
        // event payload beside it, so it survives however many WAIT steps sit before the send.
        visitId: enrollment.visit_id,
      });
      if (!loaded) {
        const reason = missingEntityReason(enrollment);
        await prisma.workflowStepRun.update({ where: { id: stepRunId }, data: { status: 'STOPPED', detail: reason } });
        await finishEnrollment(enrollmentId, 'STOPPED', reason, now);
        return;
      }

      // 7 — terminal staleness floor
      const staleReason = terminalStaleReason(
        pinnedTrigger,
        enrollment.occurrence_key ?? undefined,
        loaded.state,
        now,
        direction,
        anchor,
      );
      if (staleReason) {
        await prisma.workflowStepRun.update({ where: { id: stepRunId }, data: { status: 'STOPPED', detail: staleReason } });
        await finishEnrollment(enrollmentId, 'STOPPED', staleReason, now);
        return;
      }

      // 8 — dispatch on step type
      if (step.step_type === 'WAIT') {
        const durationMinutes = (step.config as { duration_minutes: number }).duration_minutes;
        await prisma.workflowStepRun.update({
          where: { id: stepRunId },
          data: { status: 'CONTINUED', detail: `Waited ${humanizeDuration(durationMinutes)}` },
        });
        const resume = new Date(now.getTime() + durationMinutes * 60_000);
        await casCursor(enrollmentId, cursor, resume); // parks in the future by construction
        return;
      }

      if (step.step_type === 'STOP_IF') {
        const condition = (step.config as { condition: string }).condition;
        if (stopIfHolds(condition, loaded.state, enrollment.occurrence_key)) {
          const reason = stopIfReason(condition);
          await prisma.workflowStepRun.update({ where: { id: stepRunId }, data: { status: 'STOPPED', detail: reason } });
          await finishEnrollment(enrollmentId, 'STOPPED', reason, now);
          return;
        }
        await prisma.workflowStepRun.update({
          where: { id: stepRunId },
          data: { status: 'CONTINUED', detail: 'Checked — kept going' },
        });
        if (!(await casCursor(enrollmentId, cursor, now))) return;
        cursor += 1;
        continue;
      }

      // 8b - a step type this build no longer runs (today: only the retired in-app
      //      step). Storage is permanently wider than the authoring surface, so a
      //      frozen definition can still name one. Skip it and carry on.
      //
      //      POSITION IS LOAD-BEARING: this sits BEFORE the TECH_ASSIGNED narrowing
      //      below. That block skips with 'Technician is no longer assigned to this
      //      job', which is simply false for a retired step - and tech-assignment-alert
      //      was one of the gallery templates that minted these steps, so a retired
      //      step on a TECH_ASSIGNED trigger is the likeliest legacy case, not a corner
      //      one. Moving this branch after it silently starts lying to admins.
      if (!isSupportedStepType(step.step_type)) {
        await prisma.workflowStepRun.update({
          where: { id: stepRunId },
          data: {
            status: 'SKIPPED',
            detail: step.step_type === 'NOTIFY_TEAM' ? RETIRED_IN_APP_STEP_DETAIL : UNRUNNABLE_STEP_DETAIL,
          },
        });
        if (!(await casCursor(enrollmentId, cursor, now))) return;
        cursor += 1;
        continue;
      }

      // messaging steps: SEND_TEXT / SEND_EMAIL

      // TECH_ASSIGNED narrowing: this enrollment targets ONE tech (the
      // occurrence). If they were taken off the crew, skip — not a stop.
      if (pinnedTrigger === 'TECH_ASSIGNED' && enrollment.occurrence_key) {
        loaded.bundle.assignees = loaded.bundle.assignees.filter((u) => u.id === enrollment.occurrence_key);
        if (loaded.bundle.assignees.length === 0) {
          await prisma.workflowStepRun.update({
            where: { id: stepRunId },
            data: { status: 'SKIPPED', detail: 'Technician is no longer assigned to this job' },
          });
          if (!(await casCursor(enrollmentId, cursor, now))) return;
          cursor += 1;
          continue;
        }
      }

      // A thrown executor is mapped to a FAILED outcome (one failed send must
      // not strand the sequence) — the same contract engine.ts gives a run.
      let result: ExecutionResult;
      try {
        result = await executeAction(
          {
            id: `${enrollment.workflow_id}:${cursor}`,
            name: enrollment.workflow.name,
            action_type: mapStepToActionType(step.step_type)!,
            action_config: step.config,
            organization_id: enrollment.organization_id,
          },
          loaded.bundle,
        );
      } catch (err) {
        result = { status: 'FAILED', detail: err instanceof Error ? err.message : String(err) };
      }

      await prisma.workflowStepRun.update({
        where: { id: stepRunId },
        data: {
          status: result.status,
          recipient_summary: result.recipientSummary ?? null,
          detail: result.detail ?? null,
          // Never null: the column is NOT NULL DEFAULT '[]', and a thrown executor or an
          // action without audiences has nothing per audience to say.
          audience_outcomes: result.audienceOutcomes ?? [],
        },
      });

      if (!(await casCursor(enrollmentId, cursor, now))) return;
      cursor += 1;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn('[workflows] advanceEnrollment failed', { enrollmentId, error: message });
    if (claimedStepRunId) {
      try {
        // GUARDED: only annotate a row still holding the provisional sentinel. If
        // the step already resolved (e.g. SENT written, then the cursor CAS threw)
        // the ledger must keep the true outcome — the recovery sweeper finishes
        // the CAS for resolved rows and closes FAILED ones.
        await prisma.workflowStepRun.updateMany({
          where: { id: claimedStepRunId, status: 'FAILED', detail: PROVISIONAL_CLAIM_DETAIL },
          data: { detail: message },
        });
      } catch {
        // recording the failure failed too — nothing left to do but the log above
      }
    }
  }
}

/** Triggers that RE-FIRE on a reschedule — their enrollments are re-created + old ones
 *  dropped by staleness, so re-arming them would resurrect superseded copies (double-send).
 *  Typed as `string` (not AutomationTriggerType): the lead reschedule trigger
 *  ('WALKTHROUGH_RESCHEDULED') is not a member of the enum on this branch, and only the
 *  string identity is needed for the skip check. */
const RESCHEDULE_TRIGGER: Record<'job' | 'lead', string> = {
  job: 'JOB_RESCHEDULED',
  lead: 'WALKTHROUGH_RESCHEDULED',
};

/**
 * Re-arm pending anchored-wait reminders for an entity whose anchor date just moved
 * (job/walkthrough reschedule). For each ACTIVE enrollment PARKED at an anchored WAIT
 * whose trigger is NOT the entity's reschedule trigger, recompute target = liveDate ± offset
 * and update BOTH resume_at AND occurrence_key to the live date (so Task 4b's occurrence
 * staleness keeps it). Bounded to one entity; never throws (fire-and-forget from controllers).
 * Scope is deliberate: an enrollment parked at any OTHER step is left untouched, occurrence_key
 * included — see the park comment in block 4b for why that's the safe (never-double-send) choice.
 */
export async function rearmAnchoredWaits(entityType: 'job' | 'lead', entityId: string, now: Date = new Date()): Promise<void> {
  try {
    const enrollments = await prisma.workflowEnrollment.findMany({
      where: { entity_type: entityType, entity_id: entityId, status: 'ACTIVE' },
      include: { version: { select: { definition: true } }, workflow: { select: { trigger_type: true } } },
    });
    for (const e of enrollments) {
      try {
        const def = e.version.definition as unknown as WorkflowDefinition;
        const pinned = (def.trigger_type ?? e.workflow.trigger_type) as AutomationTriggerType;
        if (pinned === RESCHEDULE_TRIGGER[entityType]) continue; // re-created + staleness-dropped, not re-armed
        const step = def.steps.find((s) => s.position === e.step_cursor);
        if (!step || step.step_type !== 'WAIT' || !isAnchoredWait(step.config)) continue;
        const cfg = step.config as AnchoredWaitConfig;
        const loaded = await loadExecutionBundle({
          entityType: e.entity_type,
          entityId: e.entity_id,
          entityLabel: e.entity_label,
          organizationId: e.organization_id,
          dedupeKey: e.dedupe_key,
          // D9. This is the one loader call that passes neither an event payload nor a trigger,
          // and the visit id is not optional here for a reason the other two do not share: this
          // function WRITES its answer back as `occurrence_key`, and the occurrence key is half
          // the dedupe key. Resolved per entity on a visit-scoped enrollment, a re-arm silently
          // moves the row's identity onto a trip it is not about - and unlike a wrong countdown,
          // that outlives the send.
          //
          // Whether it should ALSO pass eventPayload and trigger is a real question and a separate
          // one; this change does only what the defect requires.
          visitId: e.visit_id,
        });
        if (!loaded) continue;
        const anchorDate = anchorDateFor(cfg.anchor, loaded.state);
        if (!anchorDate) continue; // handled (STOPPED) at the enrollment's next wake
        const target = new Date(anchorDate.getTime() + (cfg.direction === 'before' ? -1 : 1) * cfg.offset_minutes * 60_000);
        await prisma.workflowEnrollment.updateMany({
          where: { id: e.id, step_cursor: e.step_cursor, status: 'ACTIVE' },
          data: { resume_at: target, occurrence_key: anchorDate.toISOString() },
        });
      } catch (err) {
        logger.warn('[workflows] rearmAnchoredWaits item failed — continuing', { enrollmentId: e.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
  } catch (err) {
    logger.warn('[workflows] rearmAnchoredWaits failed', { entityType, entityId, error: err instanceof Error ? err.message : String(err) });
  }
}
