/**
 * cron.ts — the Workflow Builder's time-trigger poller.
 *
 * Registered in index.ts on a 1-minute node-cron schedule. Four phases per
 * tick:
 *
 *  1. scanTimeTriggers(now): for every published + enabled timed workflow,
 *     find entities whose anchor enters the fire window and create
 *     WorkflowEnrollments (via enrollment.ts's createEnrollment — never
 *     re-implemented here). Window queries are BOUNDED (48h/7d grace behind
 *     the offset) so enabling a workflow never blasts historical records,
 *     while short poller downtime never drops a fire. The
 *     (workflow_id, dedupe_key) unique makes rescans no-ops. New enrollments
 *     get resume_at = now, so phase 3 of THIS SAME tick picks them up —
 *     the scan never advances inline and never computes send-window
 *     shifting itself (that happens inside advanceEnrollment at the send
 *     step).
 *  2. scanDateAnchorTriggers(now): the same idea as phase 1, generalized to
 *     the four unified date-anchored triggers (JOB/LEAD/INVOICE/
 *     ESTIMATE_DATE_ANCHORED — Task A2). Each workflow's trigger_config
 *     carries {anchor, direction, offset_minutes} instead of a bare offset;
 *     dateAnchorSweep.ts's anchorWindow()/candidatesForAnchor() (Task A5) own
 *     the window math and the per-anchor candidate queries — this phase only
 *     loops workflows and hands candidates to the same createEnrollment used
 *     by phase 1. Runs immediately after phase 1 and before phase 3 for the
 *     same reason: new enrollments get resume_at = now, so they advance on
 *     THIS SAME tick.
 *  3. advanceDueEnrollments(now): walk ACTIVE enrollments with resume_at ≤
 *     now, oldest first, bounded batch (50/tick — steady state clears any
 *     backlog in a few minutes without pinning the single Render instance).
 *     Delegates to enrollment.ts's advanceEnrollment (never throws by
 *     contract; wrapped anyway).
 *  4. closeWedgedEnrollments(now): crash-recovery sweeper. A worker crash
 *     between the per-step CLAIM insert and the cursor CAS leaves a
 *     provisional FAILED/'Interrupted mid-step' step-run with the
 *     enrollment still ACTIVE at that cursor — every later advance loses
 *     the claim race and the enrollment is wedged forever. We never retry
 *     (at-most-once is the only safe policy for customer messaging —
 *     the send may or may not have gone out); we close it honestly once
 *     it's old enough that no live worker still owns it. The guarded
 *     update (id + status ACTIVE + step_cursor = the stale index) means an
 *     enrollment that genuinely continued past that step is left alone.
 *
 * Pure function of `now` for testability (invoiceDueCron precedent). Never
 * throws; per-workflow and per-item failures are logged and skipped.
 */

import { Workflow } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { LIVE_VISIT_STATUSES } from '../../lib/visit-status';
import { runUnscoped } from '../../lib/tenant-context';
import { createEnrollment, advanceEnrollment } from './enrollment';
import { anchorWindow, candidatesForAnchor } from './dateAnchorSweep';
import type { AnchorKey, WaitDirection } from './anchors';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
/** Missed-tick grace for "after X" triggers: how far behind the offset we look. */
const COMPLETED_GRACE_MS = 48 * HOUR;
const OVERDUE_GRACE_MS = 7 * 24 * HOUR;
const DUE_BATCH_SIZE = 50;
/** How long a provisional claim must sit before we treat it as a true wedge. */
const WEDGE_GRACE_MS = 30 * MINUTE;

const TIME_TRIGGERS = [
  'BEFORE_JOB_START',
  'AFTER_JOB_COMPLETED',
  'INVOICE_OVERDUE',
  'ESTIMATE_FOLLOW_UP',
] as const;

function offsetMinutesOf(workflow: Workflow): number | null {
  const cfg = workflow.trigger_config as { offset_minutes?: unknown } | null;
  const v = cfg?.offset_minutes;
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null;
}

interface Candidate {
  entityType: 'job' | 'invoice' | 'estimate';
  entityId: string;
  entityLabel: string | null;
  occurrence?: string;
  /**
   * WHICH VISIT this candidate is about, for the one arm that sweeps visit rows (spec
   * 2026-09-14-per-visit-automation-enrollment, D7/D8). Persisted on the enrollment so the context
   * resolves THAT trip rather than re-deriving one from the parent job.
   *
   * OPTIONAL because the other three timed triggers are per-ENTITY questions by nature -
   * AFTER_JOB_COMPLETED is about the job, INVOICE_OVERDUE about the invoice, ESTIMATE_FOLLOW_UP
   * about the estimate - and name no trip. It is NOT a dedupe input; see D6.
   */
  visitId?: string;
}

async function candidatesFor(workflow: Workflow, offsetMs: number, now: Date): Promise<Candidate[]> {
  switch (workflow.trigger_type) {
    case 'BEFORE_JOB_START': {
      // S8 §2 (A4, RATIFIED): PER-VISIT, not per-job. Spec user story 43 ("a rule that texts
      // the customer the morning of the appointment fires on all three mornings") means a
      // 3-visit job must emit three candidates, one per visit, not one for the job — the same
      // shape the LEAD arm of candidatesForAnchor already has (dateAnchorSweep.ts). Selects
      // every LIVE, TIMED visit whose start falls within the next `offset` — i.e. the fire
      // moment (start − offset) has arrived. Late window entry (a visit booked for tomorrow
      // while the 24h workflow is live) fires immediately.
      // Spec B1 (B-6): a technician marking themselves en-route/on-site early must not kill
      // the customer's appointment reminder — LIVE_VISIT_STATUSES widens past SCHEDULED alone,
      // reading the VISIT's own status directly now instead of inferring it from the retired
      // job-level EN_ROUTE/ON_SITE-via-SCHEDULED/IN_PROGRESS proxy. terminalStaleReason's
      // ON_SITE/IN_PROGRESS check is what stops the reminder once work has actually started;
      // this scan just has to keep the candidate alive long enough to reach that check.
      // `job_id: { not: null }` is the same belt-and-braces guard the LEAD arm applies with
      // `lead_id: { not: null }` — the `visits` table holds both jobs' and leads' trips.
      // Occurrence stays a bare ISO date (the winning visit's own scheduled_at) — no visit id
      // is embedded in it (dedupe.ts's stopIf/terminalStale occurrence_key comparison would
      // silently go stale on anything wider); entityId is the parent JOB so the anchored WAIT's
      // dedupe scope is unaffected by this change.
      //
      // `id: true` is the whole data change of the per-visit-enrollment spec (D8): no new query
      // and no new round trip. Until it was selected, this sweep emitted one candidate PER VISIT
      // and then threw the row away, so the enrollment recorded only the parent job and the send
      // re-derived "which trip" from it - resolveNextJobVisit's earliest upcoming one, never the
      // trip that actually enrolled. On a Tuesday-and-Thursday job the Thursday reminder carried
      // Tuesday's date, time, location, crew names and crew phone numbers.
      const visits = await prisma.visit.findMany({
        where: {
          organization_id: workflow.organization_id,
          job_id: { not: null },
          status: { in: [...LIVE_VISIT_STATUSES] },
          scheduled_at: { gte: now, lte: new Date(now.getTime() + offsetMs) },
        },
        select: { id: true, scheduled_at: true, job: { select: { id: true, job_number: true } } },
      });
      return visits.flatMap((v) =>
        v.scheduled_at && v.job
          ? [{
              entityType: 'job' as const,
              entityId: v.job.id,
              entityLabel: v.job.job_number,
              occurrence: v.scheduled_at.toISOString(),
              visitId: v.id,
            }]
          : [],
      );
    }
    case 'AFTER_JOB_COMPLETED': {
      const jobs = await prisma.job.findMany({
        where: {
          organization_id: workflow.organization_id,
          status: 'COMPLETED',
          completed_at: {
            lte: new Date(now.getTime() - offsetMs),
            gte: new Date(now.getTime() - offsetMs - COMPLETED_GRACE_MS),
          },
        },
        select: { id: true, job_number: true, completed_at: true },
      });
      return jobs.flatMap((j: { id: string; job_number: string; completed_at: Date | null }) =>
        j.completed_at
          ? [{
              entityType: 'job' as const,
              entityId: j.id,
              entityLabel: j.job_number,
              occurrence: j.completed_at.toISOString(),
            }]
          : [],
      );
    }
    case 'INVOICE_OVERDUE': {
      const invoices = await prisma.invoice.findMany({
        where: {
          organization_id: workflow.organization_id,
          status: { in: ['SENT', 'PARTIAL'] },
          amount_due: { gt: 0 }, // a credit can zero the balance without changing status
          due_date: {
            lte: new Date(now.getTime() - offsetMs),
            gte: new Date(now.getTime() - offsetMs - OVERDUE_GRACE_MS),
          },
        },
        select: { id: true, invoice_number: true },
      });
      return invoices.map((i: { id: string; invoice_number: string }) => ({
        entityType: 'invoice' as const,
        entityId: i.id,
        entityLabel: i.invoice_number,
      }));
    }
    case 'ESTIMATE_FOLLOW_UP': {
      const estimates = await prisma.estimate.findMany({
        where: {
          organization_id: workflow.organization_id,
          // SENT only — an estimate follow-up chases an ANSWER. A PENDING estimate has already
          // been approved and signed (D6); chasing it for a decision would tell a customer who
          // already said yes that we never heard from them. Chasing the outstanding deposit is
          // a separate concern from this trigger.
          status: 'SENT',
          sent_at: {
            lte: new Date(now.getTime() - offsetMs),
            gte: new Date(now.getTime() - offsetMs - OVERDUE_GRACE_MS),
          },
        },
        select: { id: true, estimate_number: true },
      });
      return estimates.map((e: { id: string; estimate_number: string }) => ({
        entityType: 'estimate' as const,
        entityId: e.id,
        entityLabel: e.estimate_number,
      }));
    }
    default:
      return [];
  }
}

async function scanTimeTriggers(now: Date): Promise<void> {
  const workflows = await prisma.workflow.findMany({
    where: {
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
      trigger_type: { in: [...TIME_TRIGGERS] },
    },
  });
  if (workflows.length === 0) return;

  for (const workflow of workflows) {
    try {
      const offsetMinutes = offsetMinutesOf(workflow);
      if (!offsetMinutes) {
        logger.warn('[automations] timed workflow has no valid offset_minutes — skipping', { workflowId: workflow.id });
        continue;
      }

      const candidates = await candidatesFor(workflow, offsetMinutes * MINUTE, now);
      for (const candidate of candidates) {
        await createEnrollment({
          workflow: {
            id: workflow.id,
            published_version_id: workflow.published_version_id,
            trigger_type: workflow.trigger_type,
            organization_id: workflow.organization_id,
            legacy_rule_id: workflow.legacy_rule_id,
          },
          entity: { type: candidate.entityType, id: candidate.entityId, label: candidate.entityLabel },
          occurrenceKey: candidate.occurrence,
          // Persisted on the row so the send resolves THIS trip (spec 2026-09-14). Deliberately
          // WITHOUT `visitScopedDedupe` - D6, and the decision most likely to be got wrong here.
          // A cron occurrence is a visit's FUTURE scheduled_at, which historical dedupe keys
          // already hold, so widening the key would stop those rows colliding and re-remind every
          // customer inside the trigger's lead-time window, once, on deploy day. The id buys the
          // key nothing either way: two trips at different times already mint two keys and already
          // both enrol. The dispatch doors escape this only because their occurrences are minted
          // fresh at dispatch time, which is the rule - not "the dispatch path does it, so should
          // this one".
          visitId: candidate.visitId,
          now,
        });
      }
    } catch (err) {
      logger.warn('[automations] time-trigger scan failed for workflow — continuing', {
        workflowId: workflow.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The triggers scanDateAnchorTriggers even LOOKS at.
 *
 * A bare array feeding one where-clause, derived from nothing, and the failure mode of
 * forgetting a member is total silence: the workflow publishes, enables, validates, reads
 * back correctly in the builder, and is simply never selected here, so its sweep never runs
 * and no log line is ever written. cron.test.ts pins the list itself for that reason - a
 * mocked prisma returns whatever the test hands it regardless of the where-clause, so only
 * an assertion ON the clause can see the omission.
 */
const DATE_ANCHORED_TRIGGERS = [
  'JOB_DATE_ANCHORED',
  'LEAD_DATE_ANCHORED',
  'INVOICE_DATE_ANCHORED',
  'ESTIMATE_DATE_ANCHORED',
  // Spec B slice 5: one trigger, both directions - the before-reminder and the overdue chase.
  'TASK_DATE_ANCHORED',
] as const;

/**
 * The gate a date-anchored workflow has to pass to be swept at all - returns null, and the
 * caller then logs and skips, for anything it cannot read as {anchor, direction, offset}.
 *
 * EXPORTED for one reason: seedDefaultAutomations.test.ts asserts that the seeded reminder's
 * persisted trigger_config is readable HERE. That row used to be written as Prisma.DbNull
 * unconditionally, which this function turns into a permanent, silent skip - the workflow
 * publishes, enables and reads back correctly in the builder and simply never fires. Testing
 * the seeder against a re-implementation of this check would have proved nothing about the
 * function that actually does the skipping.
 */
export function dateAnchorConfigOf(
  workflow: Workflow,
): { anchor: AnchorKey; direction: WaitDirection; offsetMinutes: number } | null {
  const cfg = workflow.trigger_config as
    | { anchor?: unknown; direction?: unknown; offset_minutes?: unknown }
    | null;
  const anchor = cfg?.anchor;
  const direction = cfg?.direction;
  const offset = cfg?.offset_minutes;
  if (typeof anchor !== 'string') return null;
  if (direction !== 'before' && direction !== 'after') return null;
  if (typeof offset !== 'number' || !Number.isFinite(offset) || offset < 0) return null;
  return { anchor: anchor as AnchorKey, direction, offsetMinutes: offset };
}

/**
 * Enroll entities whose anchor date's fire moment has arrived. Mirrors
 * scanTimeTriggers: bounded windows, resume_at = now so phase 3 of THIS tick
 * advances them, and (workflow_id, dedupe_key) makes rescans no-ops.
 */
async function scanDateAnchorTriggers(now: Date): Promise<void> {
  const workflows = await prisma.workflow.findMany({
    where: {
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
      trigger_type: { in: [...DATE_ANCHORED_TRIGGERS] },
    },
  });
  if (workflows.length === 0) return;

  for (const workflow of workflows) {
    try {
      const cfg = dateAnchorConfigOf(workflow);
      if (!cfg) {
        logger.warn('[automations] date-anchored workflow has an invalid trigger_config — skipping', {
          workflowId: workflow.id,
        });
        continue;
      }
      const window = anchorWindow(cfg.direction, cfg.offsetMinutes * MINUTE, now);
      const candidates = await candidatesForAnchor(cfg.anchor, workflow.organization_id, window);
      for (const candidate of candidates) {
        await createEnrollment({
          workflow: {
            id: workflow.id,
            published_version_id: workflow.published_version_id,
            trigger_type: workflow.trigger_type,
            organization_id: workflow.organization_id,
            legacy_rule_id: workflow.legacy_rule_id,
          },
          entity: { type: candidate.entityType, id: candidate.entityId, label: candidate.entityLabel },
          occurrenceKey: candidate.occurrence,
          // Persisted on the row so the send resolves THIS trip (spec 2026-09-14). Deliberately
          // WITHOUT `visitScopedDedupe` - D6, and the decision most likely to be got wrong here.
          // A cron occurrence is a visit's FUTURE scheduled_at, which historical dedupe keys
          // already hold, so widening the key would stop those rows colliding and re-remind every
          // customer inside the trigger's lead-time window, once, on deploy day. The id buys the
          // key nothing either way: two trips at different times already mint two keys and already
          // both enrol. The dispatch doors escape this only because their occurrences are minted
          // fresh at dispatch time, which is the rule - not "the dispatch path does it, so should
          // this one".
          visitId: candidate.visitId,
          now,
        });
      }
    } catch (err) {
      logger.warn('[automations] date-anchor scan failed for workflow — continuing', {
        workflowId: workflow.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

async function advanceDueEnrollments(now: Date): Promise<void> {
  const due = await prisma.workflowEnrollment.findMany({
    where: { status: 'ACTIVE', resume_at: { lte: now } },
    orderBy: { resume_at: 'asc' },
    take: DUE_BATCH_SIZE,
    select: { id: true },
  });

  for (const enrollment of due) {
    try {
      await advanceEnrollment(enrollment.id, now);
    } catch (err) {
      // advanceEnrollment never throws by contract, but the poller survives anyway.
      logger.warn('[automations] advanceDueEnrollments item failed — continuing', {
        enrollmentId: enrollment.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Crash recovery. A worker dying between the step-run claim and the cursor CAS
 * leaves the enrollment ACTIVE at a step whose claim row already exists — every
 * later advance loses the claim insert (P2002) and returns, so the enrollment
 * would sit due-and-stuck forever, monopolizing the take-50 batch.
 *
 * Selection is ENROLLMENT-first: anything still ACTIVE and due for longer than
 * the grace has been offered to every tick since and isn't moving. Its claim row
 * (unique lookup at the cursor) tells us exactly what happened:
 *  - no claim row      → pure backlog, not a wedge — leave it to the advance phase;
 *  - resolved success  → the step COMPLETED but the CAS was lost: finish the CAS
 *    and resume the flow (for a WAIT, resume at claim-time + duration so the
 *    author's delay is honored, not skipped);
 *  - STOPPED           → the stop outcome was written but the finish was lost:
 *    finish the enrollment STOPPED;
 *  - FAILED (any detail) → the outcome is UNKNOWABLE (the send may or may not
 *    have left) — close FAILED, never retry: at-most-once for customer messaging.
 *
 * Every branch removes the enrollment from next tick's stuck set (cursor/resume
 * moved, or status left ACTIVE), so the sweep is self-cleaning and can't starve.
 */
async function recoverWedgedEnrollments(now: Date): Promise<void> {
  const stuck = await prisma.workflowEnrollment.findMany({
    where: { status: 'ACTIVE', resume_at: { lte: new Date(now.getTime() - WEDGE_GRACE_MS) } },
    select: { id: true, step_cursor: true },
    take: DUE_BATCH_SIZE,
  });

  for (const e of stuck) {
    try {
      const claim = await prisma.workflowStepRun.findUnique({
        where: { enrollment_id_step_index: { enrollment_id: e.id, step_index: e.step_cursor } },
        select: { status: true, step_type: true, executed_at: true },
      });
      if (!claim) continue; // backlog under load, not a wedge — still claimable

      if (claim.status === 'FAILED') {
        await prisma.workflowEnrollment.updateMany({
          where: { id: e.id, status: 'ACTIVE', step_cursor: e.step_cursor },
          data: {
            status: 'FAILED',
            finished_at: now,
            finished_reason: 'A system interruption stopped this automation mid-step',
          },
        });
        continue;
      }

      if (claim.status === 'STOPPED') {
        await prisma.workflowEnrollment.updateMany({
          where: { id: e.id, status: 'ACTIVE', step_cursor: e.step_cursor },
          data: {
            status: 'STOPPED',
            finished_at: now,
            finished_reason: 'Stopped mid-flow during a system interruption',
          },
        });
        continue;
      }

      // SENT / SKIPPED / CONTINUED — the step resolved; finish the lost CAS.
      // A recovered WAIT resumes at claim-time + its configured duration so the
      // author's delay is preserved (possibly already elapsed → due immediately).
      let resumeAt = now;
      if (claim.step_type === 'WAIT' && claim.executed_at) {
        const enr = await prisma.workflowEnrollment.findUnique({
          where: { id: e.id },
          include: { version: { select: { definition: true } } },
        });
        const def = enr?.version?.definition as { steps?: Array<{ position: number; config?: { duration_minutes?: unknown } }> } | undefined;
        const step = def?.steps?.find((s) => s.position === e.step_cursor);
        const mins = step?.config?.duration_minutes;
        if (typeof mins === 'number' && Number.isFinite(mins)) {
          resumeAt = new Date(claim.executed_at.getTime() + mins * 60_000);
        }
      }
      await prisma.workflowEnrollment.updateMany({
        where: { id: e.id, status: 'ACTIVE', step_cursor: e.step_cursor },
        data: { step_cursor: e.step_cursor + 1, resume_at: resumeAt },
      });
    } catch (err) {
      logger.warn('[automations] recoverWedgedEnrollments item failed — continuing', {
        enrollmentId: e.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// Overlap guard: node-cron does NOT serialize non-awaited async callbacks, so a
// tick that runs long (e.g. the 08:00 window-open burst hitting Resend serially)
// would otherwise overlap the next minute's tick. The per-step claim already makes
// double-send impossible; this just avoids piling up redundant concurrent work.
//
// It records WHEN the holder started rather than a bare boolean, because a boolean
// has no way back (#1916). Each phase has its own try/catch, so a phase that THROWS
// cannot strand the guard - the `finally` still runs. Nothing handled a phase that
// HANGS: an await that never settles (a starved connection pool, say) never reaches
// the `finally`, the flag stays set, and every later minute takes the early return.
// The whole poller - every relative WAIT, every anchored WAIT, every date-anchored
// trigger - then stays dead for the process lifetime, with nothing red anywhere and
// only a repeating skip line to show for it. Past STALE_TICK_MS we take the guard
// back and say so at error level. The holder is NOT cancelled (there is no way to
// cancel an in-flight query, and abandoning a slow-but-working tick mid-send would
// mint wedged enrollments); it is simply no longer allowed to hold the poller shut.
//
// The generation token is what makes taking it back safe: an abandoned tick that
// settles late must not clear the guard its successor now holds.
const STALE_TICK_MS = 10 * MINUTE;
let inFlightTick: { generation: number; startedAt: Date } | null = null;
let tickGeneration = 0;

/**
 * One poller tick. Never throws; skips if the previous tick is still running.
 *
 * SELF-SCOPING under the DB tenant guard, and that is not a detail of the caller.
 *
 * Production connects as a role with no BYPASSRLS, and every tenant table carries a FORCED
 * `tenant_isolation` policy over two session vars that `wrapWithTenantGuard` fills in from the
 * AsyncLocalStorage tenant context (lib/tenant-context.ts). A request has such a context because
 * `authenticate` opens one. The poller is nobody's request. With NO context the policy fails
 * CLOSED, so every query here - all four phases - matches zero rows: `workflow.findMany` returns
 * [], both scans take their `workflows.length === 0` early return, and no anchor sweep, no
 * advance and no crash recovery ever runs. Nothing throws and nothing is logged; the tick just
 * does nothing, every minute, for ever. Measured on production 2026-09-03: this scan's own
 * `workflow.findMany` sat at 219 calls with `rows = 0` on every one of them, while the very
 * same predicate run by hand as a BYPASSRLS role at the same moment returned a live, enabled,
 * PUBLISHED workflow. Event triggers were unaffected and hid it - `enrollOnEvent` runs inside
 * the request that fired it, and that request has a tenant context.
 *
 * The bypass is opened HERE rather than at the `cron.schedule` call in index.ts (where the
 * invoice and Stripe sweeps open theirs) because this poller is a cross-org sweep BY
 * CONSTRUCTION - there is no correct way to call it scoped to one org - and because index.ts
 * boots a server and so is reachable by no test. Wiring that only one pair of eyes can check is
 * how the poller shipped silent in the first place.
 */
export async function runAutomationTick(now: Date = new Date()): Promise<void> {
  if (inFlightTick) {
    const stuckForMs = now.getTime() - inFlightTick.startedAt.getTime();
    if (stuckForMs < STALE_TICK_MS) {
      logger.warn('[automations] previous tick still running — skipping this minute');
      return;
    }
    logger.error('[automations] previous tick never finished — abandoning it and running anyway', {
      startedAt: inFlightTick.startedAt.toISOString(),
      stuckForMs,
    });
  }
  const generation = ++tickGeneration;
  inFlightTick = { generation, startedAt: now };
  try {
    // One bypass for the whole tick: AsyncLocalStorage carries it across every await, so each
    // phase's queries - and everything enrollment.ts runs underneath them - see it too.
    await runUnscoped(async () => {
      try {
        await scanTimeTriggers(now);
      } catch (err) {
        logger.error('[automations] scanTimeTriggers failed', err);
      }
      try {
        await scanDateAnchorTriggers(now);
      } catch (err) {
        logger.error('[automations] scanDateAnchorTriggers failed', err);
      }
      try {
        await advanceDueEnrollments(now);
      } catch (err) {
        logger.error('[automations] advanceDueEnrollments failed', err);
      }
      try {
        await recoverWedgedEnrollments(now);
      } catch (err) {
        logger.error('[automations] recoverWedgedEnrollments failed', err);
      }
    });
  } finally {
    // Only the tick that still OWNS the guard may release it - an abandoned tick
    // that settles late would otherwise unlock the poller under its successor.
    if (inFlightTick?.generation === generation) inFlightTick = null;
  }
}
