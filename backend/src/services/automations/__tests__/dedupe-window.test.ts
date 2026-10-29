import { describe, it, expect } from 'vitest';
import { buildDedupeKey } from '../dedupe';
import { shiftIntoWindow } from '../sendWindow';

describe('buildDedupeKey', () => {
  const JOB = 'aaaaaaaa-0000-0000-0000-000000000001';

  it('is once-per-entity for plain event triggers', () => {
    expect(buildDedupeKey('ESTIMATE_APPROVED', JOB)).toBe(`ESTIMATE_APPROVED:${JOB}`);
    expect(buildDedupeKey('INVOICE_PAID', JOB)).toBe(`INVOICE_PAID:${JOB}`);
  });

  it('encodes the occurrence for occurrence-scoped triggers', () => {
    const iso = '2026-07-14T13:00:00.000Z';
    expect(buildDedupeKey('JOB_RESCHEDULED', JOB, iso)).toBe(`JOB_RESCHEDULED:${JOB}:${iso}`);
    expect(buildDedupeKey('BEFORE_JOB_START', JOB, iso)).toBe(`BEFORE_JOB_START:${JOB}:${iso}`);
    expect(buildDedupeKey('TECH_ASSIGNED', JOB, 'user-1')).toBe(`TECH_ASSIGNED:${JOB}:user-1`);
  });

  it('a reschedule produces a different key than the original occurrence (re-arms reminders)', () => {
    const a = buildDedupeKey('BEFORE_JOB_START', JOB, '2026-07-14T13:00:00.000Z');
    const b = buildDedupeKey('BEFORE_JOB_START', JOB, '2026-07-15T13:00:00.000Z');
    expect(a).not.toBe(b);
  });

  it('throws when an occurrence-scoped trigger is missing its occurrence', () => {
    expect(() => buildDedupeKey('BEFORE_JOB_START', JOB)).toThrow(/occurrence/);
  });

  it('scopes walkthrough scheduled/rescheduled by the walkthrough-date ISO', () => {
    expect(buildDedupeKey('WALKTHROUGH_SCHEDULED', 'lead1', '2026-08-01T15:00:00Z')).toBe('WALKTHROUGH_SCHEDULED:lead1:2026-08-01T15:00:00Z');
    expect(buildDedupeKey('WALKTHROUGH_RESCHEDULED', 'lead1', '2026-08-02T15:00:00Z')).toBe('WALKTHROUGH_RESCHEDULED:lead1:2026-08-02T15:00:00Z');
  });

  // Spec B slice 2. WITHOUT this, the second person added to a task collides with the first
  // on the [workflow_id, dedupe_key] unique constraint and is swallowed as a duplicate for the
  // life of that task - no error, no log line, no enrollment.
  it('scopes task-assigned by the added assignee user id', () => {
    const TASK = 'cccccccc-0000-0000-0000-000000000001';
    expect(buildDedupeKey('TASK_ASSIGNED', TASK, 'user9')).toBe(`TASK_ASSIGNED:${TASK}:user9`);
    expect(buildDedupeKey('TASK_ASSIGNED', TASK, 'user9')).not.toBe(
      buildDedupeKey('TASK_ASSIGNED', TASK, 'user7'),
    );
  });

  // The failure mode is worse than a throw: createEnrollment CATCHES this and returns null,
  // so a dispatch site that forgot its occurrence silently never enrolls. The dispatch-site
  // half of this guarantee is asserted in __tests__/task-automation-dispatch.test.ts.
  it('throws when TASK_ASSIGNED arrives with no occurrence', () => {
    expect(() => buildDedupeKey('TASK_ASSIGNED', 'task1')).toThrow(/occurrence/);
  });

  // A task CREATED with two people is one occurrence, not two - the mutual-exclusion decision
  // read from the dedupe side.
  it('leaves TASK_CREATED once-per-task', () => {
    expect(buildDedupeKey('TASK_CREATED', 'task1')).toBe('TASK_CREATED:task1');
  });

  // Spec B slice 3. Occurrence = the note id. WITHOUT it the key is task-scoped, so only the
  // FIRST comment on any task ever notifies and every later one collides on the
  // [workflow_id, dedupe_key] unique constraint - for the life of that task.
  it('scopes task-comment-added by the note id', () => {
    const TASK = 'cccccccc-0000-0000-0000-000000000002';
    expect(buildDedupeKey('TASK_COMMENT_ADDED', TASK, 'note1')).toBe(`TASK_COMMENT_ADDED:${TASK}:note1`);
    expect(buildDedupeKey('TASK_COMMENT_ADDED', TASK, 'note1')).not.toBe(
      buildDedupeKey('TASK_COMMENT_ADDED', TASK, 'note2'),
    );
  });

  // Worse than a throw: createEnrollment CATCHES this and returns null, so a dispatch site
  // that forgot its occurrence silently never enrolls. The dispatch-site half of the
  // guarantee is asserted in __tests__/task-automation-dispatch.test.ts.
  it('throws when TASK_COMMENT_ADDED arrives with no occurrence', () => {
    expect(() => buildDedupeKey('TASK_COMMENT_ADDED', 'task1')).toThrow(/occurrence/);
  });

  // Spec B slice 4. NOT occurrence-scoped, and the reason is structural rather than a
  // judgement: a task is deleted exactly once and never comes back, so the entity id IS the
  // occurrence. Adding it to OCCURRENCE_SCOPED would make buildDedupeKey throw at the delete
  // handler's occurrence-less dispatch, createEnrollment swallow the throw, and the trigger
  // silently never enrol for anyone.
  it('leaves TASK_DELETED once-per-task and does not demand an occurrence', () => {
    expect(buildDedupeKey('TASK_DELETED', 'task1')).toBe('TASK_DELETED:task1');
    expect(() => buildDedupeKey('TASK_DELETED', 'task1')).not.toThrow();
  });

  /**
   * Spec B slice 5. Occurrence = the task's due date, ISO. There is no re-arm mechanism for
   * date-anchored triggers BY DESIGN - nothing is parked ahead of the fire moment - so the
   * occurrence key IS the anchor date, and a moved due date is a genuinely new occurrence
   * picked up on a later tick. Without this membership the key is task-scoped, so a task
   * fires its reminder exactly ONCE ever, and moving the due date changes nothing.
   */
  it('scopes task-date-anchored by the due-date ISO, so a moved due date is a new occurrence', () => {
    const TASK = 'cccccccc-0000-0000-0000-000000000003';
    const first = '2026-09-04T02:30:00.000Z';
    const second = '2026-09-06T02:30:00.000Z';
    expect(buildDedupeKey('TASK_DATE_ANCHORED', TASK, first)).toBe(`TASK_DATE_ANCHORED:${TASK}:${first}`);
    expect(buildDedupeKey('TASK_DATE_ANCHORED', TASK, first)).not.toBe(
      buildDedupeKey('TASK_DATE_ANCHORED', TASK, second),
    );
  });

  // The sweep always supplies an occurrence (dateAnchorSweep.ts drops any task with a null
  // due_at before building a candidate), so this throw is unreachable from the poller - but
  // createEnrollment CATCHES it and returns null, so a future caller that forgot would enrol
  // nobody, silently. Pinned for the same reason the other three task triggers pin it.
  it('throws when TASK_DATE_ANCHORED arrives with no occurrence', () => {
    expect(() => buildDedupeKey('TASK_DATE_ANCHORED', 'task1')).toThrow(/occurrence/);
  });

  // Slice 14: "Task is done" fires on EVERY finish, and a task can be finished, reopened and
  // finished again. Keyed on the task alone, the second finish collides with the first on the
  // (workflow_id, dedupe_key) unique and is swallowed for the life of the task.
  it('scopes task-completed by the transition moment, so a second finish after a reopen is a new occurrence', () => {
    const TASK = 'task1';
    const first = '2026-09-28T14:00:00.000Z';
    const second = '2026-09-29T09:30:00.000Z';
    expect(buildDedupeKey('TASK_COMPLETED', TASK, first)).toBe(`TASK_COMPLETED:${TASK}:${first}`);
    expect(buildDedupeKey('TASK_COMPLETED', TASK, first)).not.toBe(buildDedupeKey('TASK_COMPLETED', TASK, second));
  });

  it('throws when TASK_COMPLETED arrives with no occurrence', () => {
    expect(() => buildDedupeKey('TASK_COMPLETED', 'task1')).toThrow(/occurrence/);
  });

  // Slice 15: the same trap for "Task is cancelled" - cancelled, reopened, cancelled again.
  it('scopes task-cancelled by the transition moment, so a second cancel after a reopen is a new occurrence', () => {
    const TASK = 'task1';
    const first = '2026-09-28T14:00:00.000Z';
    const second = '2026-09-29T09:30:00.000Z';
    expect(buildDedupeKey('TASK_CANCELLED', TASK, first)).toBe(`TASK_CANCELLED:${TASK}:${first}`);
    expect(buildDedupeKey('TASK_CANCELLED', TASK, first)).not.toBe(buildDedupeKey('TASK_CANCELLED', TASK, second));
  });

  it('throws when TASK_CANCELLED arrives with no occurrence', () => {
    expect(() => buildDedupeKey('TASK_CANCELLED', 'task1')).toThrow(/occurrence/);
  });

  it('scopes performer-assigned + lead-assigned by user id', () => {
    expect(buildDedupeKey('WALKTHROUGH_PERFORMER_ASSIGNED', 'lead1', 'user9')).toBe('WALKTHROUGH_PERFORMER_ASSIGNED:lead1:user9');
    expect(buildDedupeKey('LEAD_ASSIGNED', 'lead1', 'user9')).toBe('LEAD_ASSIGNED:lead1:user9');
  });

  // Removing two different people from the same job/lead must be TWO
  // occurrences — scoped by the removed person's id, mirroring the
  // corresponding *_ASSIGNED trigger just above.
  it('scopes removed-crew + removed-performer by the removed user id', () => {
    expect(buildDedupeKey('TECH_UNASSIGNED', JOB, 'user9')).toBe(`TECH_UNASSIGNED:${JOB}:user9`);
    expect(buildDedupeKey('WALKTHROUGH_PERFORMER_REMOVED', 'lead1', 'user9')).toBe('WALKTHROUGH_PERFORMER_REMOVED:lead1:user9');
  });

  // A job can only re-enter EN_ROUTE after a fresh SCHEDULED transition, so this
  // fires at most once per en_route_at — but scoping it anyway mirrors
  // JOB_RESCHEDULED's ISO-occurrence pattern rather than assuming that
  // invariant holds forever.
  it('scopes en-route by the en_route_at ISO', () => {
    const iso = '2026-07-21T15:00:00.000Z';
    expect(buildDedupeKey('JOB_EN_ROUTE', JOB, iso)).toBe(`JOB_EN_ROUTE:${JOB}:${iso}`);
  });

  // SRVW-113 — a job cycling A -> B -> A must re-fire on returning to A, so the
  // key is scoped by sub_status_id, not just the trigger + entity.
  it('scopes sub-status-entered by the sub_status_id (a job cycling A -> B -> A re-fires)', () => {
    expect(buildDedupeKey('JOB_SUB_STATUS_ENTERED', JOB, 'sub-status-1')).toBe(
      `JOB_SUB_STATUS_ENTERED:${JOB}:sub-status-1`,
    );
    expect(() => buildDedupeKey('JOB_SUB_STATUS_ENTERED', JOB)).toThrow(/occurrence/);
  });

  it('fires once (not occurrence-scoped) for completed + cancelled', () => {
    expect(buildDedupeKey('WALKTHROUGH_COMPLETED', 'lead1')).toBe('WALKTHROUGH_COMPLETED:lead1');
    expect(buildDedupeKey('WALKTHROUGH_CANCELLED', 'lead1')).toBe('WALKTHROUGH_CANCELLED:lead1');
  });

  // Task A6b: the four unified date-anchored triggers (Task A2) must be occurrence-scoped
  // the same way the legacy 8 already are, or a moved anchor date (rescheduled job,
  // extended invoice due date, ...) silently fails to re-arm its reminder.
  it('encodes the occurrence for the four date-anchored triggers (Task A6b)', () => {
    const iso = '2026-08-01T15:00:00.000Z';
    expect(buildDedupeKey('JOB_DATE_ANCHORED', JOB, iso)).toBe(`JOB_DATE_ANCHORED:${JOB}:${iso}`);
    expect(buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1', iso)).toBe(`LEAD_DATE_ANCHORED:lead1:${iso}`);
    expect(buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1', iso)).toBe(`INVOICE_DATE_ANCHORED:inv-1:${iso}`);
    expect(buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1', iso)).toBe(`ESTIMATE_DATE_ANCHORED:est-1:${iso}`);
  });

  it('a moved anchor date produces a different key for each date-anchored trigger (re-arms the reminder)', () => {
    // Mirrors the brief's concrete scenario: an invoice due date extended two weeks must
    // produce a fresh dedupe key so scanDateAnchorTriggers's re-enrollment on the new date
    // isn't silently swallowed by the (workflow_id, dedupe_key) unique constraint.
    const invoiceBefore = buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1', '2026-07-01T00:00:00.000Z');
    const invoiceAfter = buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1', '2026-07-15T00:00:00.000Z');
    expect(invoiceBefore).not.toBe(invoiceAfter);

    const jobA = buildDedupeKey('JOB_DATE_ANCHORED', JOB, '2026-07-14T13:00:00.000Z');
    const jobB = buildDedupeKey('JOB_DATE_ANCHORED', JOB, '2026-07-16T13:00:00.000Z');
    expect(jobA).not.toBe(jobB);

    const leadA = buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1', '2026-08-01T15:00:00.000Z');
    const leadB = buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1', '2026-08-02T15:00:00.000Z');
    expect(leadA).not.toBe(leadB);

    const estA = buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1', '2026-07-20T00:00:00.000Z');
    const estB = buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1', '2026-08-03T00:00:00.000Z');
    expect(estA).not.toBe(estB);
  });

  it('throws when a date-anchored trigger is missing its occurrence', () => {
    expect(() => buildDedupeKey('JOB_DATE_ANCHORED', JOB)).toThrow(/occurrence/);
    expect(() => buildDedupeKey('LEAD_DATE_ANCHORED', 'lead1')).toThrow(/occurrence/);
    expect(() => buildDedupeKey('INVOICE_DATE_ANCHORED', 'inv-1')).toThrow(/occurrence/);
    expect(() => buildDedupeKey('ESTIMATE_DATE_ANCHORED', 'est-1')).toThrow(/occurrence/);
  });
});

describe('shiftIntoWindow (BUSINESS_HOURS = 08:00–20:00 org-local)', () => {
  const NY = 'America/New_York';

  it('ANYTIME passes through unchanged', () => {
    const d = new Date('2026-07-14T02:30:00.000Z');
    expect(shiftIntoWindow(d, 'ANYTIME', NY).getTime()).toBe(d.getTime());
  });

  it('inside the window passes through unchanged', () => {
    // 2026-07-14 15:00 UTC = 11:00 New York (EDT, UTC-4)
    const d = new Date('2026-07-14T15:00:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).getTime()).toBe(d.getTime());
  });

  it('too early shifts to 08:00 the same local day', () => {
    // 2026-07-14 09:30 UTC = 05:30 New York → 08:00 New York = 12:00 UTC
    const d = new Date('2026-07-14T09:30:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).toISOString()).toBe('2026-07-14T12:00:00.000Z');
  });

  it('too late shifts to 08:00 the NEXT local day', () => {
    // 2026-07-14 02:00 UTC = Jul 13 22:00 New York → Jul 14 08:00 NY = 12:00 UTC
    const d = new Date('2026-07-14T02:00:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).toISOString()).toBe('2026-07-14T12:00:00.000Z');
  });

  it('exactly 20:00 local is out of window (shifts to next morning)', () => {
    // 2026-07-15 00:00 UTC = Jul 14 20:00 New York → Jul 15 08:00 NY = 12:00 UTC
    const d = new Date('2026-07-15T00:00:00.000Z');
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', NY).toISOString()).toBe('2026-07-15T12:00:00.000Z');
  });

  it('works for UTC-timezone orgs too', () => {
    const d = new Date('2026-07-14T21:15:00.000Z'); // 21:15 UTC-local → next day 08:00 UTC
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', 'UTC').toISOString()).toBe('2026-07-15T08:00:00.000Z');
  });

  it('never throws on a garbage org timezone — falls back to the default (America/New_York)', () => {
    const d = new Date('2026-07-14T09:30:00.000Z'); // 05:30 NY → 08:00 NY = 12:00 UTC under the fallback
    expect(() => shiftIntoWindow(d, 'BUSINESS_HOURS', 'Not/AZone')).not.toThrow();
    expect(shiftIntoWindow(d, 'BUSINESS_HOURS', 'Not/AZone').toISOString()).toBe('2026-07-14T12:00:00.000Z');
    // empty string too
    expect(() => shiftIntoWindow(d, 'BUSINESS_HOURS', '')).not.toThrow();
  });
});
