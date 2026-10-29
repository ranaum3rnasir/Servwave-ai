import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { runAutomationTick } from '../cron';
import { tenantConfigValues, getTenantContext } from '../../../lib/tenant-context';

vi.mock('../enrollment', () => ({
  createEnrollment: vi.fn().mockResolvedValue({ id: 'enr-x' }),
  advanceEnrollment: vi.fn().mockResolvedValue(undefined),
}));
import { createEnrollment, advanceEnrollment } from '../enrollment';

const mockPrisma = prisma as any;
const mockCreateEnrollment = createEnrollment as ReturnType<typeof vi.fn>;
const mockAdvanceEnrollment = advanceEnrollment as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const NOW = new Date('2026-07-14T15:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const MINUTE = 60 * 1000;

function timedWorkflow(trigger: string, offsetMinutes: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `wf-${trigger}`,
    name: trigger,
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: trigger,
    trigger_config: { offset_minutes: offsetMinutes },
    published_version_id: 'ver-1',
    organization_id: ORG,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workflow = {
    findMany: vi.fn().mockResolvedValue([]),
  };
  mockPrisma.workflowEnrollment = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.workflowStepRun = {
    findMany: vi.fn().mockResolvedValue([]),
    findUnique: vi.fn().mockResolvedValue(null),
  };
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockCreateEnrollment.mockResolvedValue({ id: 'enr-x' });
  mockAdvanceEnrollment.mockResolvedValue(undefined);
});

describe('runAutomationTick — scanTimeTriggers', () => {
  it('does nothing when no timed workflows are enabled', async () => {
    await runAutomationTick(NOW);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });

  it('scan where-clause requires PUBLISHED + enabled + a published version + a timed trigger', async () => {
    await runAutomationTick(NOW);
    const q = mockPrisma.workflow.findMany.mock.calls[0][0];
    expect(q.where).toEqual({
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
      trigger_type: { in: ['BEFORE_JOB_START', 'AFTER_JOB_COMPLETED', 'INVOICE_OVERDUE', 'ESTIMATE_FOLLOW_UP'] },
    });
  });

  // S8 §2 (A4, RATIFIED): PER-VISIT, not per-job — repointed onto `visits`. A single-visit job
  // still yields exactly one candidate, so this proves the query shape; the multi-visit fan-out
  // (spec user story 43 — "fires on all three mornings") is its own test below.
  // The headline trigger's select, asserted the way the date-anchor sweep already asserts both of
  // its own. Without `id: true` Postgres never returns it, `v.id` is undefined, and EVERY
  // BEFORE_JOB_START enrollment persists visit_id NULL - the whole fix silently reverting to
  // per-entity resolution on the day-before reminder, which is this spec's own worked example.
  // The mocked client ignores `select`, so no behavioural test here can see that; only reading
  // the query back can. `tsc` also catches it, and this says so out loud besides.
  it('BEFORE_JOB_START: asks Postgres for the visit id, so a candidate can name its own trip', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([]);
    await runAutomationTick(NOW);
    expect(mockPrisma.visit.findMany.mock.calls[0][0].select).toMatchObject({ id: true });
  });

  it('BEFORE_JOB_START: scans LIVE visits inside [now, now+offset], org-scoped, and enrolls each candidate', async () => {
    const start = new Date(NOW.getTime() + 2 * HOUR);
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-1', scheduled_at: start, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    await runAutomationTick(NOW);

    const q = mockPrisma.visit.findMany.mock.calls[0][0];
    expect(q.where.organization_id).toBe(ORG);
    // Belt-and-braces guard mirroring the LEAD arm's `lead_id: { not: null }` — `visits` holds
    // both jobs' and leads' trips.
    expect(q.where.job_id).toEqual({ not: null });
    // Spec B1 (B-6): widened past SCHEDULED alone so a technician marking themselves en route or
    // on site early does not kill the customer's appointment reminder -- terminalStaleReason is
    // what stops it once work has actually started.
    //
    // Multi-visit S8 §2: the candidate SET is unchanged, but it is now read directly off the
    // VISIT's own status (LIVE_VISIT_STATUSES) instead of inferred through the job-level
    // SCHEDULED/IN_PROGRESS proxy — EN_ROUTE and ON_SITE live on VisitStatus, not JobStatus.
    expect(q.where.status).toEqual({ in: ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] });
    expect(q.where.scheduled_at.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.scheduled_at.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.workflow).toEqual({
      id: 'wf-BEFORE_JOB_START',
      published_version_id: 'ver-1',
      trigger_type: 'BEFORE_JOB_START',
      organization_id: ORG,
    });
    expect(arg.entity).toEqual({ type: 'job', id: 'job-1', label: 'J00042' });
    expect(arg.occurrenceKey).toBe(start.toISOString());
    expect(arg.visitId).toBe('visit-1');
    expect(arg.now).toBe(NOW);
  });

  // ── Per-visit automation enrollment (spec 2026-09-14, criteria 4 + 5 + D6) ───────────────────
  //
  // TWO visits at two times, because with one the triggering trip and the parent's only trip are
  // the same row and every assertion below passes whether the id travels or not.
  it('BEFORE_JOB_START: each candidate carries its OWN visit id, and no candidate asks for a visit-scoped dedupe key', async () => {
    const tuesday = new Date(NOW.getTime() + HOUR);
    const thursday = new Date(NOW.getTime() + 3 * HOUR);
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-tue', scheduled_at: tuesday, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-thu', scheduled_at: thursday, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    await runAutomationTick(NOW);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(2);
    expect(mockCreateEnrollment.mock.calls.map((c) => c[0].visitId)).toEqual(['visit-tue', 'visit-thu']);
    // D6 - THE decision most likely to be got wrong. The visit id is persisted on the row and does
    // NOT join the dedupe key on this door: BEFORE_JOB_START's occurrence is a visit's FUTURE
    // scheduled_at, which historical rows already hold, so a widened key would stop colliding with
    // them and re-remind every customer inside the trigger's lead-time window on deploy day. The
    // dispatch doors escape that because their occurrences are minted fresh at dispatch time.
    for (const call of mockCreateEnrollment.mock.calls) {
      expect(call[0].visitScopedDedupe).toBeFalsy();
    }
  });

  // Criterion 5 at this door: the three per-entity timed triggers name no trip. AFTER_JOB_COMPLETED
  // is a question about the job, not about any one of its trips.
  it('AFTER_JOB_COMPLETED / INVOICE_OVERDUE / ESTIMATE_FOLLOW_UP emit no visit id', async () => {
    const at = new Date(NOW.getTime() - 30 * HOUR);
    mockPrisma.workflow.findMany.mockResolvedValueOnce([
      timedWorkflow('AFTER_JOB_COMPLETED', 24 * 60),
      timedWorkflow('INVOICE_OVERDUE', 24 * 60),
      timedWorkflow('ESTIMATE_FOLLOW_UP', 24 * 60),
    ]);
    mockPrisma.job.findMany.mockResolvedValue([{ id: 'job-1', job_number: 'J00042', completed_at: at }]);
    mockPrisma.invoice.findMany.mockResolvedValue([{ id: 'inv-1', invoice_number: 'I00073' }]);
    mockPrisma.estimate.findMany.mockResolvedValue([{ id: 'est-1', estimate_number: 'E00108' }]);

    await runAutomationTick(NOW);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(3);
    for (const call of mockCreateEnrollment.mock.calls) {
      expect(call[0].visitId).toBeUndefined();
    }
  });

  // Contract A4's headline behaviour change: this is what "1 fire becomes 3" looks like at the
  // poller's own boundary — one job, three live visits inside the window, three enrollment
  // attempts sharing one entity id but each carrying its own occurrence.
  it('BEFORE_JOB_START: a 3-visit job enrolls THREE times — one per visit, same job, distinct occurrences', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    const v1 = new Date(NOW.getTime() + HOUR);
    const v2 = new Date(NOW.getTime() + 2 * HOUR);
    const v3 = new Date(NOW.getTime() + 3 * HOUR);
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-1', scheduled_at: v1, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-2', scheduled_at: v2, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-3', scheduled_at: v3, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    await runAutomationTick(NOW);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(3);
    const occurrences = mockCreateEnrollment.mock.calls.map((c) => c[0].occurrenceKey);
    expect(occurrences).toEqual([v1.toISOString(), v2.toISOString(), v3.toISOString()]);
    expect(new Set(occurrences).size).toBe(3);
    for (const call of mockCreateEnrollment.mock.calls) {
      expect(call[0].entity).toEqual({ type: 'job', id: 'job-1', label: 'J00042' });
    }
  });

  it('BEFORE_JOB_START: createEnrollment resolving null (dedupe collision) does not throw or stop the loop for other candidates', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('BEFORE_JOB_START', 24 * 60)]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { scheduled_at: new Date(NOW.getTime() + HOUR), job: { id: 'job-1', job_number: 'J1' } },
      { scheduled_at: new Date(NOW.getTime() + 2 * HOUR), job: { id: 'job-2', job_number: 'J2' } },
    ]);
    mockCreateEnrollment.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'enr-2' });

    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockCreateEnrollment).toHaveBeenCalledTimes(2);
  });

  it('AFTER_JOB_COMPLETED: bounded lookback window (grace 48h) — never retroactive; occurrence = completed_at ISO', async () => {
    const completedAt = new Date(NOW.getTime() - 10 * HOUR);
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('AFTER_JOB_COMPLETED', 24 * 60)]);
    mockPrisma.job.findMany.mockResolvedValueOnce([
      { id: 'job-1', job_number: 'J00042', completed_at: completedAt },
    ]);
    await runAutomationTick(NOW);
    const q = mockPrisma.job.findMany.mock.calls[0][0];
    expect(q.where.status).toBe('COMPLETED');
    // completed_at ∈ [now − offset − 48h, now − offset]
    expect(q.where.completed_at.lte.getTime()).toBe(NOW.getTime() - 24 * HOUR);
    expect(q.where.completed_at.gte.getTime()).toBe(NOW.getTime() - 24 * HOUR - 48 * HOUR);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.occurrenceKey).toBe(completedAt.toISOString());
  });

  it('INVOICE_OVERDUE: scans unpaid invoices with due_date past offset (7d grace), amount_due > 0', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('INVOICE_OVERDUE', 3 * 24 * 60)]);
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'inv-1', invoice_number: 'I00073', due_date: new Date(NOW.getTime() - 4 * 24 * HOUR) },
    ]);
    await runAutomationTick(NOW);
    const q = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(q.where.status).toEqual({ in: ['SENT', 'PARTIAL'] });
    expect(q.where.amount_due).toEqual({ gt: 0 }); // never dun a zero-balance invoice
    expect(q.where.due_date.lte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR);
    expect(q.where.due_date.gte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR - 7 * 24 * HOUR);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.entity).toEqual({ type: 'invoice', id: 'inv-1', label: 'I00073' });
    expect(arg.occurrenceKey).toBeUndefined();
  });

  it('ESTIMATE_FOLLOW_UP: scans still-unanswered estimates by sent_at (7d grace)', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([timedWorkflow('ESTIMATE_FOLLOW_UP', 3 * 24 * 60)]);
    mockPrisma.estimate.findMany.mockResolvedValueOnce([
      { id: 'est-1', estimate_number: 'E00108', sent_at: new Date(NOW.getTime() - 4 * 24 * HOUR) },
    ]);
    await runAutomationTick(NOW);
    const q = mockPrisma.estimate.findMany.mock.calls[0][0];
    // SENT only — PENDING means the customer already answered (approved + signed, D6), so
    // chasing it for a decision would tell someone who said yes that we never heard back.
    expect(q.where.status).toBe('SENT');
    expect(q.where.sent_at.lte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR);
    expect(q.where.sent_at.gte.getTime()).toBe(NOW.getTime() - 3 * 24 * HOUR - 7 * 24 * HOUR);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.entity).toEqual({ type: 'estimate', id: 'est-1', label: 'E00108' });
  });

  it('a timed workflow with a missing/invalid offset_minutes is skipped with logger.warn, no candidate query', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([
      timedWorkflow('BEFORE_JOB_START', 0, { trigger_config: null }),
    ]);
    await runAutomationTick(NOW);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.visit.findMany).not.toHaveBeenCalled();
    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });
});

describe('runAutomationTick — scanDateAnchorTriggers', () => {
  function dateAnchoredWorkflow(
    trigger: string,
    anchor: string,
    direction: 'before' | 'after',
    offsetMinutes: number,
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: `wf-${trigger}`,
      name: trigger,
      status: 'PUBLISHED',
      is_enabled: true,
      trigger_type: trigger,
      trigger_config: { anchor, direction, offset_minutes: offsetMinutes },
      published_version_id: 'ver-1',
      organization_id: ORG,
      legacy_rule_id: null,
      ...overrides,
    };
  }

  it('scan where-clause requires PUBLISHED + enabled + a published version + a date-anchored trigger', async () => {
    await runAutomationTick(NOW);
    // scanDateAnchorTriggers issues the SECOND workflow.findMany call of a tick
    // (scanTimeTriggers issues the first — see the "immediately after
    // scanTimeTriggers" ordering in runAutomationTick).
    const q = mockPrisma.workflow.findMany.mock.calls[1][0];
    expect(q.where).toEqual({
      is_enabled: true,
      status: 'PUBLISHED',
      published_version_id: { not: null },
      trigger_type: {
        in: [
          'JOB_DATE_ANCHORED',
          'LEAD_DATE_ANCHORED',
          'INVOICE_DATE_ANCHORED',
          'ESTIMATE_DATE_ANCHORED',
          'TASK_DATE_ANCHORED',
        ],
      },
    });
  });

  /**
   * ── Per-visit automation enrollment (spec 2026-09-14, criteria 4 + 5 + D6) ──────────────────
   *
   * The SECOND createEnrollment call site. It is a separate line from the timed sweep's, so it
   * needs its own assertion: a `visitScopedDedupe: true` added to this one alone would widen the
   * key for JOB_DATE_ANCHORED and LEAD_DATE_ANCHORED with nothing red, and re-remind every
   * customer inside the lead-time window once, on deploy day.
   *
   * Two trips on one parent, because with one the assertion cannot distinguish a candidate that
   * named its trip from one that named the only trip there was.
   */
  it('the date-anchor sweep hands each trip\u2019s OWN visit id over, and asks for no visit-scoped dedupe key', async () => {
    const tuesday = new Date(NOW.getTime() + HOUR);
    const thursday = new Date(NOW.getTime() + 3 * HOUR);
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dateAnchoredWorkflow('JOB_DATE_ANCHORED', 'job.scheduled_start', 'before', 24 * 60),
      ]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'visit-tue', scheduled_at: tuesday, job: { id: 'job-1', job_number: 'J00042' } },
      { id: 'visit-thu', scheduled_at: thursday, job: { id: 'job-1', job_number: 'J00042' } },
    ]);

    await runAutomationTick(NOW);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(2);
    expect(mockCreateEnrollment.mock.calls.map((c) => c[0].visitId)).toEqual(['visit-tue', 'visit-thu']);
    for (const call of mockCreateEnrollment.mock.calls) {
      expect(call[0].entity).toEqual({ type: 'job', id: 'job-1', label: 'J00042' }); // D5
      expect(call[0].visitScopedDedupe).toBeFalsy(); // D6
      expect(call[0].occurrenceKey).not.toContain('visit-'); // D3
    }
  });

  it('the lead walkthrough anchor does the same, for a showroom meeting and a site visit', async () => {
    const showroom = new Date(NOW.getTime() + HOUR);
    const site = new Date(NOW.getTime() + 3 * HOUR);
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dateAnchoredWorkflow('LEAD_DATE_ANCHORED', 'lead.walkthrough_scheduled_at', 'before', 24 * 60),
      ]);
    mockPrisma.visit.findMany.mockResolvedValueOnce([
      { id: 'wt-showroom', scheduled_at: showroom, lead: { id: 'lead-1', lead_number: 'L00277' } },
      { id: 'wt-site', scheduled_at: site, lead: { id: 'lead-1', lead_number: 'L00277' } },
    ]);

    await runAutomationTick(NOW);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(2);
    expect(mockCreateEnrollment.mock.calls.map((c) => c[0].visitId)).toEqual(['wt-showroom', 'wt-site']);
    for (const call of mockCreateEnrollment.mock.calls) {
      expect(call[0].visitScopedDedupe).toBeFalsy();
    }
  });

  // Criterion 5 at this door: the per-entity anchors name no trip.
  it('the task anchor emits no visit id', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dateAnchoredWorkflow('TASK_DATE_ANCHORED', 'task.due_at', 'before', 24 * 60)]);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-1', title: 'Order the replacement thermostat', due_at: new Date(NOW.getTime() + 21 * HOUR) },
    ]);

    await runAutomationTick(NOW);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCreateEnrollment.mock.calls[0][0].visitId).toBeUndefined();
  });

  /**
   * Spec B slice 5. DATE_ANCHORED_TRIGGERS in cron.ts is a bare array feeding this very
   * where-clause, so omitting TASK_DATE_ANCHORED from it does not break anything - it just
   * means the sweep never SELECTS a task workflow, and the whole feature is silent with
   * nothing in the logs and nothing red. The assertion above pins the list; this one pins
   * the consequence end to end.
   */
  it('enrolls a task due tomorrow for a "1 day before" task workflow, labelled by its TITLE', async () => {
    const due = new Date(NOW.getTime() + 21 * HOUR); // inside [now, now+24h]
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dateAnchoredWorkflow('TASK_DATE_ANCHORED', 'task.due_at', 'before', 24 * 60)]);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-1', title: 'Order the replacement thermostat', due_at: due },
    ]);

    await runAutomationTick(NOW);

    const q = mockPrisma.task.findMany.mock.calls[0][0];
    expect(q.where.organization_id).toBe(ORG);
    expect(q.where.status).toEqual({ notIn: ['DONE', 'CANCELLED'] });
    expect(q.where.due_at.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.due_at.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.entity).toEqual({ type: 'task', id: 'task-1', label: 'Order the replacement thermostat' });
    expect(arg.occurrenceKey).toBe(due.toISOString());
  });

  it('enrolls a task one day overdue for a "1 day after" workflow - the chase, from the same trigger', async () => {
    const due = new Date(NOW.getTime() - 24 * HOUR);
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dateAnchoredWorkflow('TASK_DATE_ANCHORED', 'task.due_at', 'after', 24 * 60)]);
    mockPrisma.task.findMany.mockResolvedValueOnce([
      { id: 'task-2', title: 'Chase the permit office', due_at: due },
    ]);

    await runAutomationTick(NOW);

    const q = mockPrisma.task.findMany.mock.calls[0][0];
    expect(q.where.due_at.lte.getTime()).toBe(NOW.getTime() - 24 * HOUR);
    expect(q.where.due_at.gte.getTime()).toBeLessThan(q.where.due_at.lte.getTime());

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCreateEnrollment.mock.calls[0][0].occurrenceKey).toBe(due.toISOString());
  });

  it('enrolls an invoice whose due date is one day out for a "1 day before" workflow', async () => {
    const due = new Date(NOW.getTime() + 21 * HOUR); // inside [now, now+24h]
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([]) // scanTimeTriggers: nothing timed
      .mockResolvedValueOnce([dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60)]);
    mockPrisma.invoice.findMany.mockResolvedValueOnce([
      { id: 'inv-1', invoice_number: 'I00001', due_date: due },
    ]);

    await runAutomationTick(NOW);

    const q = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(q.where.organization_id).toBe(ORG);
    expect(q.where.due_date.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.due_date.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);

    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    const arg = mockCreateEnrollment.mock.calls[0][0];
    expect(arg.workflow).toEqual({
      id: 'wf-INVOICE_DATE_ANCHORED',
      published_version_id: 'ver-1',
      trigger_type: 'INVOICE_DATE_ANCHORED',
      organization_id: ORG,
      legacy_rule_id: null,
    });
    expect(arg.entity).toEqual({ type: 'invoice', id: 'inv-1', label: 'I00001' });
    expect(arg.occurrenceKey).toBe(due.toISOString());
    expect(arg.now).toBe(NOW);
  });

  it('does not enroll an invoice whose due date has already passed — the window excludes it', async () => {
    const due = new Date(NOW.getTime() - 24 * HOUR); // a day in the past
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60)]);
    // A real DB query would exclude this row (due_date is below the window
    // floor) — assert on the where-bounds, not the mock's return, so the test
    // proves the window math rather than just trusting a hand-set mock.
    mockPrisma.invoice.findMany.mockResolvedValueOnce([]);

    await runAutomationTick(NOW);

    const q = mockPrisma.invoice.findMany.mock.calls[0][0];
    expect(q.where.due_date.gte.getTime()).toBe(NOW.getTime());
    expect(q.where.due_date.lte.getTime()).toBe(NOW.getTime() + 24 * HOUR);
    expect(due.getTime()).toBeLessThan(q.where.due_date.gte.getTime());

    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });

  it('a date-anchored workflow with a malformed trigger_config is skipped with logger.warn, no candidate query', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60, {
          trigger_config: { anchor: 'invoice.due_date' }, // missing direction + offset_minutes
        }),
      ]);
    await runAutomationTick(NOW);
    expect(mockPrisma.invoice.findMany).not.toHaveBeenCalled();
    expect(mockCreateEnrollment).not.toHaveBeenCalled();
  });

  it('one workflow whose candidate query throws does not stop the scan for other date-anchored workflows', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        dateAnchoredWorkflow('INVOICE_DATE_ANCHORED', 'invoice.due_date', 'before', 24 * 60),
        dateAnchoredWorkflow('ESTIMATE_DATE_ANCHORED', 'estimate.valid_until', 'before', 24 * 60),
      ]);
    mockPrisma.invoice.findMany.mockRejectedValueOnce(new Error('db boom'));
    mockPrisma.estimate.findMany.mockResolvedValueOnce([
      { id: 'est-1', estimate_number: 'E00001', valid_until: new Date(NOW.getTime() + 12 * HOUR) },
    ]);

    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockCreateEnrollment).toHaveBeenCalledTimes(1);
    expect(mockCreateEnrollment.mock.calls[0][0].entity).toEqual({ type: 'estimate', id: 'est-1', label: 'E00001' });
  });
});

describe('runAutomationTick — advanceDueEnrollments', () => {
  it('advances due ACTIVE enrollments oldest-first, bounded batch of 50', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }]);
    await runAutomationTick(NOW);
    const q = mockPrisma.workflowEnrollment.findMany.mock.calls[0][0];
    expect(q.where).toEqual({ status: 'ACTIVE', resume_at: { lte: NOW } });
    expect(q.orderBy).toEqual({ resume_at: 'asc' });
    expect(q.take).toBe(50);
    expect(q.select).toEqual({ id: true });
    expect(mockAdvanceEnrollment).toHaveBeenCalledTimes(2);
    expect(mockAdvanceEnrollment).toHaveBeenNthCalledWith(1, 'e1', NOW);
    expect(mockAdvanceEnrollment).toHaveBeenNthCalledWith(2, 'e2', NOW);
  });

  it('one failing advanceEnrollment call does not stop the batch', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }, { id: 'e2' }]);
    mockAdvanceEnrollment.mockRejectedValueOnce(new Error('boom'));
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockAdvanceEnrollment).toHaveBeenCalledTimes(2);
  });
});

describe('runAutomationTick — recoverWedgedEnrollments (crash recovery)', () => {
  // The sweep phase issues the SECOND workflowEnrollment.findMany of a tick
  // (the first is the advance phase).
  function sweepQueryArgs() {
    return mockPrisma.workflowEnrollment.findMany.mock.calls[1][0];
  }
  /** Make the SWEEP phase (second findMany) return these stuck enrollments. */
  function stuck(enrollments: Array<{ id: string; step_cursor: number }>) {
    mockPrisma.workflowEnrollment.findMany
      .mockResolvedValueOnce([]) // advance phase
      .mockResolvedValueOnce(enrollments); // sweep phase
  }

  it('selects ACTIVE enrollments overdue past the 30-minute grace, bounded batch of 50', async () => {
    await runAutomationTick(NOW);
    const q = sweepQueryArgs();
    expect(q.where.status).toBe('ACTIVE');
    expect(q.where.resume_at.lte.getTime()).toBe(NOW.getTime() - 30 * MINUTE);
    expect(q.take).toBe(50);
  });

  it('no claim row at the cursor = backlog, not a wedge — nothing is touched', async () => {
    stuck([{ id: 'enr-1', step_cursor: 2 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce(null);
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowStepRun.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enrollment_id_step_index: { enrollment_id: 'enr-1', step_index: 2 } } }),
    );
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
  });

  it('FAILED claim (unknowable outcome) -> enrollment closed FAILED, never retried', async () => {
    stuck([{ id: 'enr-1', step_cursor: 2 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'FAILED', step_type: 'SEND_EMAIL', executed_at: NOW });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 2 },
      data: {
        status: 'FAILED',
        finished_at: NOW,
        finished_reason: 'A system interruption stopped this automation mid-step',
      },
    });
  });

  it('STOPPED claim (finish write was lost) -> enrollment closed STOPPED', async () => {
    stuck([{ id: 'enr-1', step_cursor: 1 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'STOPPED', step_type: 'STOP_IF', executed_at: NOW });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 1 },
      data: {
        status: 'STOPPED',
        finished_at: NOW,
        finished_reason: 'Stopped mid-flow during a system interruption',
      },
    });
  });

  it('SENT claim (crash landed after the send, before the CAS) -> the lost CAS is finished and the flow resumes', async () => {
    stuck([{ id: 'enr-1', step_cursor: 0 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'SENT', step_type: 'SEND_TEXT', executed_at: NOW });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 0 },
      data: { step_cursor: 1, resume_at: NOW },
    });
  });

  it('recovered WAIT resumes at claim-time + configured duration — the author\'s delay is preserved', async () => {
    const claimedAt = new Date(NOW.getTime() - 45 * MINUTE);
    stuck([{ id: 'enr-1', step_cursor: 1 }]);
    mockPrisma.workflowStepRun.findUnique.mockResolvedValueOnce({ status: 'CONTINUED', step_type: 'WAIT', executed_at: claimedAt });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce({
      version: { definition: { steps: [{ position: 0, config: {} }, { position: 1, config: { duration_minutes: 1440 } }] } },
    });
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledWith({
      where: { id: 'enr-1', status: 'ACTIVE', step_cursor: 1 },
      data: { step_cursor: 2, resume_at: new Date(claimedAt.getTime() + 1440 * MINUTE) },
    });
  });

  it('multiple wedges recover independently — one failure does not stop the others', async () => {
    stuck([
      { id: 'enr-1', step_cursor: 0 },
      { id: 'enr-2', step_cursor: 1 },
    ]);
    mockPrisma.workflowStepRun.findUnique
      .mockRejectedValueOnce(new Error('db boom'))
      .mockResolvedValueOnce({ status: 'FAILED', step_type: 'SEND_EMAIL', executed_at: NOW });
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
  });
});

describe('runAutomationTick — tick guard + phase isolation', () => {
  it('skips overlapping ticks: a second tick while the first is in-flight is a no-op', async () => {
    let releaseScan: () => void = () => {};
    mockPrisma.workflow.findMany.mockImplementationOnce(
      () => new Promise((resolve) => { releaseScan = () => resolve([]); }),
    );
    const first = runAutomationTick(NOW);
    await runAutomationTick(NOW);
    expect(mockPrisma.workflowEnrollment.findMany).not.toHaveBeenCalled();
    releaseScan();
    await first;
    mockPrisma.workflowEnrollment.findMany.mockClear();
    mockPrisma.workflow.findMany.mockResolvedValueOnce([]);
    await runAutomationTick(NOW);
    // one tick = advance phase + sweep phase, each with one enrollment query
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2);
  });

  it('a scan failure does not prevent the advance phase or the sweep phase from running', async () => {
    mockPrisma.workflow.findMany.mockRejectedValueOnce(new Error('scan boom'));
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }]); // advance phase
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockAdvanceEnrollment).toHaveBeenCalledWith('e1', NOW);
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2); // sweep phase still ran
  });

  it('an advance-phase failure does not prevent the sweep phase from running', async () => {
    mockPrisma.workflowEnrollment.findMany.mockRejectedValueOnce(new Error('advance boom'));
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2); // sweep phase still queried
  });

  it('a date-anchor scan failure does not prevent the advance phase or the sweep phase from running', async () => {
    mockPrisma.workflow.findMany
      .mockResolvedValueOnce([]) // scanTimeTriggers: nothing timed
      .mockRejectedValueOnce(new Error('date-anchor scan boom')); // scanDateAnchorTriggers
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([{ id: 'e1' }]); // advance phase
    await expect(runAutomationTick(NOW)).resolves.toBeUndefined();
    expect(mockAdvanceEnrollment).toHaveBeenCalledWith('e1', NOW);
    expect(mockPrisma.workflowEnrollment.findMany).toHaveBeenCalledTimes(2); // sweep phase still ran
  });
});

// ── the overlap guard (#1916) ─────────────────────────────────────────────────
// Every phase has its own try/catch, so a phase that THROWS can never strand the
// guard - the `finally` still runs, and the tests above prove the later phases go
// anyway. A phase that HANGS was the hole: the `finally` was never reached, the
// guard stayed shut, and the poller silently stopped advancing anything at all
// until the process restarted.
//
// These tests hang phase 1 on purpose by handing scanTimeTriggers a promise that
// never settles, then start the next tick with a LATER `now` - runAutomationTick
// is a pure function of `now`, so no fake timers are involved. While every phase-1
// call hangs, the workflow.findMany call count is an exact census of the ticks
// that got past the guard.
describe('runAutomationTick — overlap guard (#1916)', () => {
  let pending: Array<(rows: unknown[]) => void>;
  let ticks: Array<Promise<void>>;

  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const ticksAdmitted = () => mockPrisma.workflow.findMany.mock.calls.length;

  function startTick(at: Date): Promise<void> {
    const t = runAutomationTick(at);
    ticks.push(t);
    return t;
  }

  /** Stop hanging: every later phase resolves normally. */
  function stopHanging(): void {
    mockPrisma.workflow.findMany.mockResolvedValue([]);
  }

  beforeEach(() => {
    pending = [];
    ticks = [];
    mockPrisma.workflow.findMany.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve as (rows: unknown[]) => void)),
    );
  });

  afterEach(async () => {
    // Let every parked tick run out so its `finally` releases the module-level
    // guard rather than leaking it into the next test.
    stopHanging();
    for (const release of pending) release([]);
    await Promise.all(ticks);
  });

  it('skips the next minute while the previous tick is genuinely still running', async () => {
    startTick(NOW);
    await settle();
    expect(ticksAdmitted()).toBe(1);

    await runAutomationTick(new Date(NOW.getTime() + MINUTE));
    expect(ticksAdmitted()).toBe(1); // skipped, as it should be
  });

  it('takes the guard back from a tick that has hung past the stale threshold', async () => {
    startTick(NOW);
    await settle();

    // inside the threshold the poller still defers to the holder
    await runAutomationTick(new Date(NOW.getTime() + 9 * MINUTE));
    expect(ticksAdmitted()).toBe(1);

    // past it, the holder is treated as never coming back
    startTick(new Date(NOW.getTime() + 11 * MINUTE));
    await settle();
    expect(ticksAdmitted()).toBe(2);
  });

  it('an abandoned tick that settles late does not unlock the poller under its successor', async () => {
    const abandoned = startTick(NOW);
    await settle();

    startTick(new Date(NOW.getTime() + 11 * MINUTE)); // takes over, then hangs in turn
    await settle();
    expect(ticksAdmitted()).toBe(2);

    // the abandoned tick finally settles and runs all four phases to completion
    stopHanging();
    pending[0]([]);
    await abandoned;

    // its `finally` must not release the guard the successor now holds, so this
    // tick is skipped: no advance query, no sweep query.
    const enrollmentQueries = mockPrisma.workflowEnrollment.findMany.mock.calls.length;
    await runAutomationTick(new Date(NOW.getTime() + 12 * MINUTE));
    expect(mockPrisma.workflowEnrollment.findMany.mock.calls.length).toBe(enrollmentQueries);
  });
});

/**
 * The poller's TENANT SCOPE, and why it is a test rather than a line of wiring in index.ts.
 *
 * Production connects as `app_rls` - a role with NO BYPASSRLS - and every tenant table
 * carries a FORCED `tenant_isolation` policy reading two session vars:
 *
 *   current_setting('app.bypass_rls') = 'on'  OR  organization_id = current_setting('app.current_org_id')
 *
 * `wrapWithTenantGuard` fills those in from the AsyncLocalStorage tenant context. A request
 * has one because `authenticate` opens it; the poller is nobody's request, so with no
 * context `tenantConfigValues()` returns the fail-closed pair and the policy matches NO
 * ROWS. The poller's own queries are org-LESS by design (it sweeps every tenant), so the
 * failure lands on the very first query of every phase: `workflow.findMany` returns [],
 * `scanDateAnchorTriggers` takes its `workflows.length === 0` early return, and the anchor
 * sweep is never reached. Nothing throws and nothing is logged - the tick simply does
 * nothing, every minute, for ever. Measured on production 2026-09-03: the date-anchored
 * scan's own SELECT stood at 219 calls with `rows = 0` on every one, while the identical
 * predicate run by hand as a BYPASSRLS role returned a live PUBLISHED workflow.
 *
 * So the assertion is on the CONTEXT the guard reads, not on a query shape: a mocked prisma
 * answers any where-clause and can never see this. `tenant-guard.test.ts` owns the other
 * half (that this context becomes the right `set_config` call).
 */
describe('runAutomationTick — tenant scope (the RLS backstop)', () => {
  it('runs EVERY phase under the cross-org bypass, so RLS cannot blank the sweep', async () => {
    const seen: Array<{ query: string; config: { orgId: string; bypass: string } }> = [];
    const recording = (query: string, result: unknown) =>
      vi.fn(async () => {
        seen.push({ query, config: tenantConfigValues() });
        return result;
      });
    mockPrisma.workflow.findMany = recording('workflow.findMany', []);
    mockPrisma.workflowEnrollment.findMany = recording('workflowEnrollment.findMany', []);

    await runAutomationTick(NOW);

    // scanTimeTriggers, scanDateAnchorTriggers, advanceDueEnrollments, recoverWedgedEnrollments
    expect(seen.map((s) => s.query)).toEqual([
      'workflow.findMany',
      'workflow.findMany',
      'workflowEnrollment.findMany',
      'workflowEnrollment.findMany',
    ]);
    // '' + 'on' is what runUnscoped yields: no org filter, the controlled cross-tenant bypass.
    // The unfixed poller produced { orgId: '', bypass: '' } here - the fail-closed pair.
    for (const s of seen) {
      expect(s.config).toEqual({ orgId: '', bypass: 'on' });
    }
  });

  it('does not leak the bypass past the tick', async () => {
    await runAutomationTick(NOW);
    expect(getTenantContext()).toBeUndefined();
  });
});
