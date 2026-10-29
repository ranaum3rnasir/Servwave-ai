/**
 * dateAnchorSweep.ts — candidate selection for the unified date-anchored trigger
 * family.
 *
 * A date-anchored workflow fires at `anchorDate ∓ offset`. Rather than parking an
 * enrollment ahead of time, the poller sweeps each anchor's date field every
 * minute for rows whose fire moment has just arrived and enrolls them then. Two
 * consequences worth knowing:
 *
 *  - No re-arm. Nothing is parked before the fire moment, so a rescheduled job or
 *    an edited due date is simply picked up at its new time on a later tick. The
 *    occurrence key is the anchor date itself, so a moved date is a genuinely new
 *    occurrence (new dedupe key → a fresh reminder) while the old date's key can
 *    never fire twice.
 *  - The product rule falls out of the window. For `before`, the window is
 *    [now, now+offset]: an anchor still upcoming but inside the lead time is in
 *    range and fires immediately (late but useful); an anchor already past is
 *    below `now` and can never enter the window (no stale reminder).
 *
 * PURE query layer — selects rows, never enrolls. cron.ts owns enrollment.
 */
import { prisma } from '../../lib/prisma';
import { openTaskStatusFilter } from '../../lib/tasks/status';
import { LIVE_VISIT_STATUSES } from '../../lib/visit-status';
import type { AnchorKey, WaitDirection } from './anchors';
import type { AutomationEntity } from './automationEntity';

/** Missed-tick grace for "after" sweeps — mirrors the INVOICE_OVERDUE precedent. */
export const AFTER_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export interface DateAnchorCandidate {
  /** Typed by the ONE named entity union (automationEntity.ts), never a hand-written copy. */
  entityType: AutomationEntity;
  entityId: string;
  entityLabel: string | null;
  /** The anchor date, ISO — the occurrence key (per-date dedupe). */
  occurrence: string;
  /**
   * WHICH VISIT this candidate is about, for the two anchors that sweep visit rows (spec
   * 2026-09-14-per-visit-automation-enrollment, D7/D8). Persisted on the enrollment so the context
   * resolves THAT trip instead of re-deriving one from the parent — which is how a reminder
   * enrolled by Thursday's visit came to render Tuesday's date, address, crew and crew phones.
   *
   * OPTIONAL because most arms genuinely have no answer: a lead stage clock, an invoice due date,
   * an estimate's expiry and a task's due date are per-ENTITY questions and name no trip. It is
   * NOT a dedupe input — see D6 and `createEnrollment`'s `visitScopedDedupe`.
   */
  visitId?: string;
}

export function anchorWindow(
  direction: WaitDirection,
  offsetMs: number,
  now: Date,
): { gte: Date; lte: Date } {
  if (direction === 'before') {
    return { gte: now, lte: new Date(now.getTime() + offsetMs) };
  }
  return {
    gte: new Date(now.getTime() - offsetMs - AFTER_GRACE_MS),
    lte: new Date(now.getTime() - offsetMs),
  };
}

export async function candidatesForAnchor(
  anchor: AnchorKey,
  organizationId: string,
  window: { gte: Date; lte: Date },
): Promise<DateAnchorCandidate[]> {
  switch (anchor) {
    case 'job.scheduled_start': {
      // S8 §2 (A4, RATIFIED): PER-VISIT, mirroring the LEAD arm immediately below rather than
      // the job. D3 says a visit is a visit; the two anchors should have — and now have — the
      // same shape: one candidate per matching visit, not one per job. A 3-visit job whose
      // three mornings each fall in some future window's fire moment enrolls three times, which
      // is the behaviour spec user story 43 asks for ("fires on all three mornings") and is a
      // deliberate change from the old per-job read (1 fire becomes 3 on a multi-visit job).
      //
      // LIVE_VISIT_STATUSES replaces the old job-level `status: 'SCHEDULED'` filter — reading
      // the VISIT's own status directly instead of a job-level proxy for it, now that the query
      // is against `visits` in the first place. `job_id: { not: null }` is the belt-and-braces
      // guard the LEAD arm below applies with `lead_id: { not: null }` (the `visits` table holds
      // both jobs' and leads' trips).
      //
      // Occurrence stays a bare ISO date — the winning visit's own `scheduled_at`, never a visit
      // id smuggled in (dedupe.ts:53-57: stopIf.ts/terminalStale.ts compare occurrence_key
      // against someDate.toISOString() and silently go stale on anything wider). entityId is
      // the parent JOB, so distinct visit occurrences on the same job naturally mint distinct
      // dedupe keys (dedupe.ts's JOB_DATE_ANCHORED scoping is already occurrence-keyed) without
      // any visitId parameter needed — and that is still true, which is exactly why D6 forbids
      // adding one here: the id would buy the key nothing and cost a deploy-day double send.
      //
      // `id: true` is the whole data change of the per-visit-enrollment spec (D8): no new query,
      // no new round trip. Until it was selected, this sweep emitted one candidate PER VISIT and
      // then discarded the row, so the enrollment recorded only the parent and the send re-derived
      // "which trip" from it — the earliest upcoming one, whichever trip had actually enrolled.
      const rows = await prisma.visit.findMany({
        where: {
          organization_id: organizationId,
          job_id: { not: null },
          status: { in: [...LIVE_VISIT_STATUSES] },
          scheduled_at: window,
        },
        select: { id: true, scheduled_at: true, job: { select: { id: true, job_number: true } } },
      });
      return rows.flatMap((r) =>
        r.scheduled_at && r.job
          ? [{ entityType: 'job' as const, entityId: r.job.id, entityLabel: r.job.job_number, occurrence: r.scheduled_at.toISOString(), visitId: r.id }]
          : [],
      );
    }
    case 'lead.walkthrough_scheduled_at': {
      // No status filter here: terminalStale's LEAD_DATE_ANCHORED case (Task
      // A5b) re-checks the CURRENT VISIT's status at EXECUTION time instead (Walkthrough-as-
      // entity redesign, PR-B2: leadVisitStatus, not leadStatus) — LOST/CANCELLED leads
      // are dropped regardless of direction; a `before` reminder is additionally dropped once
      // the visit leaves SCHEDULED (including COMPLETED — a before-reminder promises a still-
      // pending walkthrough). An `after` reminder deliberately survives COMPLETED/CANCELLED:
      // that is the expected, desired visit state by the time an after-the-walkthrough
      // reminder fires, not staleness. Filtering status here (rather than at execution time)
      // would have to pick ONE of those two allow-lists for both directions and get it wrong
      // for the other.
      //
      // Walkthrough-as-entity redesign, PR-B2: repointed onto the Walkthrough table directly
      // (any lead's visit, any status) instead of the legacy Lead.walkthrough_scheduled_at
      // column — a lead can now have more than one Walkthrough row, so the sweep must scan the
      // rows themselves rather than a single flat column per lead.
      //
      // LEAD visits only. Multi-visit S2 parks a JOB's trips in the same table (D5: exactly one
      // parent, so a job visit has no lead at all) and its migration backfills one per already-
      // scheduled job, so an unfiltered sweep meets a lead-less row whenever a job sits inside
      // the window. The `lead` guard below is the belt to that braces: this runs inside the
      // automations cron, whose per-workflow catch would turn a TypeError into a skipped
      // workflow - the org's reminders would stop enrolling with nothing to see but a warning.
      //
      // `id: true` for the per-visit-enrollment spec (D8), and the lead half matters MORE than the
      // job half rather than less: there is no lead-side `visitMergeFields` anywhere in this
      // codebase, so the five visit-derived lead fields were resolved per ENTITY on every path,
      // event-driven dispatch included. Recording the trip on the enrollment fixes both at once.
      const rows = await prisma.visit.findMany({
        where: { organization_id: organizationId, lead_id: { not: null }, scheduled_at: window },
        select: { id: true, scheduled_at: true, lead: { select: { id: true, lead_number: true } } },
      });
      return rows.flatMap((r) =>
        r.scheduled_at && r.lead
          ? [{ entityType: 'lead' as const, entityId: r.lead.id, entityLabel: r.lead.lead_number, occurrence: r.scheduled_at.toISOString(), visitId: r.id }]
          : [],
      );
    }
    // ── Lead stage clocks (spec #1751 D8) ──────────────────────────────────────────────────
    // Three near-identical arms, one per clock, all reading the LEAD row rather than the visit
    // rows the two anchors above read. That is the point: these are stored, per-lead moments
    // ("the lead arrived", "somebody first reached out", "the latest trip finished"), not
    // per-trip ones, so exactly one candidate can ever be produced per lead per anchor — even
    // for `lead.last_visit_completed_at`, whose value moves but is still a single column.
    //
    // NO "and it has not happened yet" filter here, deliberately, and the reasoning is the same
    // one already recorded on the lead walkthrough arm above: the sweep selects purely on the
    // anchor date, so a filter here would have to pick ONE allow-list for both directions and
    // get the other wrong. terminalStale's LEAD_DATE_ANCHORED case applies it at EXECUTION time,
    // per direction (see LEAD_ANCHOR_SATISFIED_BY in anchors.ts).
    //
    // No status filter either, for the same reason: terminalStale drops LOST and CANCELLED leads
    // at execution time regardless of direction.
    case 'lead.created_at':
    case 'lead.contacted_at':
    case 'lead.last_visit_completed_at': {
      const column = anchor === 'lead.created_at'
        ? 'created_at'
        : anchor === 'lead.contacted_at'
          ? 'contacted_at'
          : 'last_visit_completed_at';
      const rows = await prisma.lead.findMany({
        where: { organization_id: organizationId, [column]: window },
        select: { id: true, lead_number: true, created_at: true, contacted_at: true, last_visit_completed_at: true },
      });
      return rows.flatMap((r) => {
        const at = r[column];
        // Occurrence stays a bare ISO date — dedupe.ts's guards compare occurrence_key against
        // someDate.toISOString() and silently go stale on anything wider.
        return at ? [{ entityType: 'lead' as const, entityId: r.id, entityLabel: r.lead_number, occurrence: at.toISOString() }] : [];
      });
    }
    case 'invoice.due_date': {
      const rows = await prisma.invoice.findMany({
        where: {
          organization_id: organizationId,
          status: { in: ['SENT', 'PARTIAL'] },
          amount_due: { gt: 0 }, // a credit can zero the balance without changing status
          due_date: window,
        },
        select: { id: true, invoice_number: true, due_date: true },
      });
      return rows.flatMap((r) =>
        r.due_date
          ? [{ entityType: 'invoice' as const, entityId: r.id, entityLabel: r.invoice_number, occurrence: r.due_date.toISOString() }]
          : [],
      );
    }
    case 'estimate.valid_until': {
      // SENT only — a PENDING estimate is already accepted and signed (D6) and no longer
      // expires, so anchoring automations to its lapsed validity date is meaningless.
      const rows = await prisma.estimate.findMany({
        where: { organization_id: organizationId, status: 'SENT', valid_until: window },
        select: { id: true, estimate_number: true, valid_until: true },
      });
      return rows.flatMap((r) =>
        r.valid_until
          ? [{ entityType: 'estimate' as const, entityId: r.id, entityLabel: r.estimate_number, occurrence: r.valid_until.toISOString() }]
          : [],
      );
    }
    case 'task.due_at': {
      // Spec B slice 5. Two DELIBERATE divergences from the four arms above, both recorded
      // here because both are silent if reversed:
      //
      //  1. The status filter comes from lib/tasks/status.ts, never a hand-written
      //     ['DONE','CANCELLED'] pair. That module exists because roughly a dozen sites had
      //     each spelled the terminal set out in their own words and every one of them went
      //     wrong by exactly one value when CANCELLED landed. BLOCKED is deliberately NOT in
      //     it: blocked work is precisely the work an overdue chase is for.
      //
      //     Filtered HERE rather than at execution time, unlike the lead arms above, because
      //     a task's terminality means the same thing in BOTH directions - a finished task
      //     needs neither a reminder before nor a chase after - so there is no second
      //     allow-list for a selection-time filter to get wrong. (A task that finishes
      //     BETWEEN enrolment and send is a different question, answered at send time.)
      //
      //  2. entityLabel is the task's TITLE, where every other arm writes a record NUMBER.
      //     The task bell verbs already write the title, with a recorded rationale that a
      //     task's number means nothing to the person being told about it; the activity tab
      //     renders this same string to that same audience. Following the sweep convention
      //     here would make two adjacent surfaces disagree about how a task is named.
      //
      // Occurrence stays a bare ISO date, as everywhere else - dedupe.ts's header warns that
      // stopIf.ts and terminalStale.ts compare occurrence_key against someDate.toISOString()
      // and go silently stale on anything wider.
      const rows = await prisma.task.findMany({
        where: {
          organization_id: organizationId,
          status: openTaskStatusFilter(),
          due_at: window,
        },
        select: { id: true, title: true, due_at: true },
      });
      return rows.flatMap((r) =>
        r.due_at
          ? [{ entityType: 'task' as const, entityId: r.id, entityLabel: r.title, occurrence: r.due_at.toISOString() }]
          : [],
      );
    }
    default:
      return [];
  }
}
