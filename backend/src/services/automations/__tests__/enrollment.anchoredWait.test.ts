import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { advanceEnrollment } from '../enrollment';

// Mirror enrollment.test.ts: stub the executor so a stray send is observable
// (none of these scenarios should ever dispatch).
vi.mock('../executors', () => ({
  executeAction: vi.fn().mockResolvedValue({ status: 'SENT', recipientSummary: 'x@y.com', detail: 'ok' }),
}));
import { executeAction } from '../executors';

const mockPrisma = prisma as any;
const mockExecute = executeAction as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const WF_ID = 'f0000000-0000-0000-0000-000000000001';
const VER_ID = 'a0000000-0000-0000-0000-000000000002';
const ENR_ID = 'e0000000-0000-0000-0000-000000000003';
const NOW = new Date('2026-07-14T15:00:00.000Z'); // 11:00 America/New_York — inside business hours

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

// S8 §2 (A4, RATIFIED): the anchored-WAIT resolver now reads context.ts's
// resolveNextJobVisit(isLiveVisit subset) instead of a flat Job.scheduled_start column, so the
// fixture carries a `visits` array — exactly what `include: { visits: {...} }` would return —
// rather than a bare scheduled_start. `jobRow(scheduledStart)` is the single-visit convenience
// wrapper every pre-existing scenario used; `jobRowWithVisits(visits)` is the multi-visit form
// the new scenarios below need. Passing `null` means NO live visit at all (the empty-`visits`
// case), matching "no longer scheduled" exactly as a bare null column used to.
type VisitFixture = {
  id: string;
  status: string;
  scheduled_at: Date | null;
  scheduled_end?: Date | null;
  created_at: Date;
  assignees: { user: { id: string; email: string; first_name: string; last_name: string } }[];
};

const TECH = { user: { id: 'tech-1', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' } };

function liveVisit(id: string, scheduledAt: Date, createdAt = new Date('2026-07-01T00:00:00.000Z')): VisitFixture {
  return { id, status: 'SCHEDULED', scheduled_at: scheduledAt, scheduled_end: null, created_at: createdAt, assignees: [TECH] };
}

const jobRowWithVisits = (visits: VisitFixture[]) => ({
  id: JOB_ID,
  job_number: 'J00042',
  status: 'SCHEDULED',
  job_type: 'HVAC Service',
  completed_at: null,
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Mitchell',
    email: 'sarah@example.com',
    phone: '+15551234567',
  },
  service_location: { address_line1: '18 Maple Ave', address_line2: null, city: 'Richmond', state: 'VA', zip: '23220' },
  visits,
});

// Base job row (SCHEDULED so JOB_SCHEDULED staleness never stops it). Each scenario overrides
// scheduled_start — the anchor the engine reads live, now via the job's single live visit.
const jobRow = (scheduledStart: Date | null) =>
  jobRowWithVisits(scheduledStart ? [liveVisit('visit-1', scheduledStart)] : []);

// An anchored WAIT step: parks until job.scheduled_start ± offset, read live.
const anchoredWaitStep = (
  position: number,
  overrides: Partial<{ anchor: string; direction: string; offset_minutes: number }> = {},
) => ({
  position,
  step_type: 'WAIT',
  config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 1440, ...overrides },
});

function def(steps: unknown[], overrides: Record<string, unknown> = {}) {
  return { trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps, ...overrides };
}

function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WF_ID,
    name: 'Welcome flow',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'JOB_SCHEDULED',
    published_version_id: VER_ID,
    organization_id: ORG,
    ...overrides,
  };
}

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENR_ID,
    workflow_id: WF_ID,
    workflow_version_id: VER_ID,
    status: 'ACTIVE',
    entity_type: 'job',
    entity_id: JOB_ID,
    entity_label: 'J00042',
    occurrence_key: null,
    dedupe_key: `JOB_SCHEDULED:${JOB_ID}`,
    step_cursor: 0,
    resume_at: NOW,
    organization_id: ORG,
    workflow: workflowRow(),
    version: { definition: def([anchoredWaitStep(0)]) },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.workflow = {
    findMany: vi.fn().mockResolvedValue([]),
    update: vi.fn().mockResolvedValue({}),
  };
  mockPrisma.workflowEnrollment = {
    create: vi.fn().mockResolvedValue({ id: ENR_ID }),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }), // cursor CAS / park succeeds by default
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.automationRun = mockPrisma.automationRun ?? {};
  mockPrisma.automationRun.findUnique = vi.fn().mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findFirst.mockResolvedValue(jobRow(new Date('2026-07-15T13:00:00.000Z')));
});

// ── Anchored WAIT execution (block 4b) ────────────────────────────────────────
describe('advanceEnrollment — anchored WAIT', () => {
  it('(a) parks WITHOUT claiming when the anchored target is still in the future', async () => {
    // scheduled_start = now + 25h; target = start − 24h (1440m before) = now + 1h → future.
    const scheduledStart = new Date(NOW.getTime() + 25 * 60 * 60_000);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(scheduledStart));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // No claim row — a reschedule can re-arm resume_at later (Task 5).
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    // Parked at THIS step: cursor unchanged, resume_at == target (start − 24h).
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(park.data.step_cursor).toBeUndefined(); // cursor NOT advanced
    expect(park.data.resume_at.getTime()).toBe(scheduledStart.getTime() - 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('(b) fires when the anchored target already passed: claims CONTINUED + advances the cursor to 1', async () => {
    // scheduled_start = now + 1h; target = start − 24h = now − 23h → already due.
    const scheduledStart = new Date(NOW.getTime() + 1 * 60 * 60_000);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(scheduledStart));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // Idempotent claim row records the completed wait (NOT the pessimistic FAILED provisional).
    const claim = mockPrisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ enrollment_id: ENR_ID, step_index: 0, step_type: 'WAIT', status: 'CONTINUED' });
    expect(claim.detail).toContain('before the appointment time');
    // cursor CAS 0 → 1
    const cas = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(cas.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(cas.data.step_cursor).toBe(1);
    expect(mockExecute).not.toHaveBeenCalled(); // WAIT never sends
  });

  it('(c) stops the enrollment when the job has no visits at all — anchor resolves null (no longer scheduled)', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(null));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // no claim row
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'the appointment is no longer scheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('(d) stops the enrollment when EVERY visit on the job is CANCELLED — same as no visits at all', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([
        { id: 'visit-1', status: 'CANCELLED', scheduled_at: new Date('2026-07-15T13:00:00.000Z'), created_at: new Date('2026-07-01'), assignees: [] },
        { id: 'visit-2', status: 'CANCELLED', scheduled_at: new Date('2026-07-20T13:00:00.000Z'), created_at: new Date('2026-07-02'), assignees: [] },
      ]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'the appointment is no longer scheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // S8 §2 (A4, RATIFIED): the anchored WAIT stays PER-JOB even on a multi-visit job — it parks
  // against whichever visit resolveNextJobVisit calls "next" (earliest UPCOMING live visit),
  // never the one that originally triggered enrollment (context.ts has no per-visit context on
  // the enrollment by design). A past, already-actioned-looking visit and a further-out visit
  // must not win over the genuinely next one.
  //
  // resolveNextJobVisit's "upcoming" filter has no injectable clock (it defaults to
  // `new Date()`, same as syncJobFromVisits's own caller) — context.ts calls it the same way,
  // so this test's "next"/"later" fixtures are built off REAL Date.now(), not the fixed NOW used
  // for the enrollment engine's due-vs-park comparison, matching the existing convention for
  // this exact constraint (job-visits.test.ts's `past`/`future` fixtures).
  it('(e) on a 3-visit job, parks against the NEXT upcoming live visit — not the earliest and not the furthest', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const past = new Date(Date.now() - 10 * HOUR_MS); // already elapsed
    const next = new Date(Date.now() + 5 * DAY_MS); // the one that should win
    const later = new Date(Date.now() + 20 * DAY_MS); // further out
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([liveVisit('visit-past', past), liveVisit('visit-next', next), liveVisit('visit-later', later)]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // no claim — still parked
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.data.step_cursor).toBeUndefined(); // cursor NOT advanced
    expect(park.data.resume_at.getTime()).toBe(next.getTime() - 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  /**
   * ── Per-visit automation enrollment (spec 2026-09-14), criterion 15 ───────────────────────────
   *
   * User story 5: "a reminder for Thursday does not fire on Monday."
   *
   * Scenario (e) directly above pins the OLD rule and is still right for the rows it describes -
   * an enrollment with no visit id keeps parking against the job's next upcoming trip, for ever
   * (D10: nothing is back-filled). This is the new rule beside it: an enrollment that DOES record
   * its trip counts down to THAT trip's anchor.
   *
   * The carried trip is the LATER of two live ones, so `resolveNextJobVisit` and "the trip this
   * enrollment is about" are different rows and the assertion can fail. Both sit well ahead of the
   * real wall clock because `resolveNextJobVisit` takes no injectable clock - the same convention
   * scenario (e) records.
   */
  it('(e2) parks against the CARRIED visit, not the job\u2019s next upcoming one (criterion 15)', async () => {
    const HOUR_MS = 60 * 60 * 1000;
    const DAY_MS = 24 * HOUR_MS;
    const tuesday = new Date(Date.now() + 5 * DAY_MS);
    const thursday = new Date(Date.now() + 7 * DAY_MS);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([liveVisit('visit-tue', tuesday), liveVisit('visit-thu', thursday)]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ visit_id: 'visit-thu', version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // still parked
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.data.step_cursor).toBeUndefined();
    expect(park.data.resume_at.getTime()).toBe(thursday.getTime() - 1440 * 60_000);
    // Stated as the failure it prevents: Tuesday minus a day is when this used to wake, which is
    // two days before the trip the customer is being reminded about.
    expect(park.data.resume_at.getTime()).not.toBe(tuesday.getTime() - 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled();
  });

  /**
   * D4 at the anchored-WAIT door specifically. This is the SECOND place advanceEnrollment loads
   * the entity and treats null as fatal, and a fix applied only to the per-step load at block 6
   * produces a workflow that works without a wait step and dies with one - the shape of bug that
   * reaches production because the happy-path test has no wait in it.
   */
  it('(e3) stops with a reason naming the visit when the carried trip is gone, even at the WAIT', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ visit_id: 'visit-deleted', version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The visit no longer exists',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('(f) on a 3-visit job with every visit already elapsed, falls back to the EARLIEST rather than nothing', async () => {
    // resolveNextJobVisit's own documented fallback when nothing is upcoming: earliest of the
    // timed set wins, ties broken by created_at — preserved here purely by reuse.
    const earliest = new Date(NOW.getTime() - 48 * 60 * 60_000);
    const middle = new Date(NOW.getTime() - 24 * 60 * 60_000);
    const latest = new Date(NOW.getTime() - 1 * 60 * 60_000);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([liveVisit('visit-mid', middle), liveVisit('visit-earliest', earliest), liveVisit('visit-latest', latest)]),
    );
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([anchoredWaitStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // target (earliest − 24h) is deep in the past → already due → fires rather than parks.
    const claim = mockPrisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ status: 'CONTINUED' });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Spec B slice 4 - the SECOND null-bundle guard
// ══════════════════════════════════════════════════════════════════════════════

/**
 * There are two places advanceEnrollment loads the entity and treats a null as fatal: the
 * per-step load at block 6, and this one - the anchored-WAIT re-check at block 4b, which until
 * this slice did not pass event_payload through AT ALL.
 *
 * A fix applied only to block 6 produces a deleted-task workflow that works with no wait step
 * and dies with one, which is precisely the bug that reaches production because the happy-path
 * test has no wait in it. These two scenarios are the guard against that.
 */
describe('advanceEnrollment - anchored WAIT on a deleted task', () => {
  const TASK_ID = 'aa000000-0000-0000-0000-0000000000f3';
  const TASK_TITLE = 'Order the replacement thermostat';
  const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };

  const taskAnchoredWait = (position: number) => ({
    position,
    step_type: 'WAIT',
    config: { mode: 'anchored', anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
  });

  function deletedTaskEnrollment() {
    return enrollmentRow({
      entity_type: 'task',
      entity_id: TASK_ID,
      entity_label: TASK_TITLE,
      dedupe_key: `TASK_DELETED:${TASK_ID}`,
      event_payload: {
        mergeFields: { 'task.number': 'T00042', 'task.title': TASK_TITLE },
        taskSnapshot: { assigneeIds: [ANN.id], watcherIds: [], creatorId: null },
      },
      workflow: workflowRow({ trigger_type: 'TASK_DELETED' }),
      version: {
        definition: def(
          [taskAnchoredWait(0), { position: 1, step_type: 'SEND_EMAIL', config: { recipients: ['assignees'], subject: 's', body: '{{task.title}}' } }],
          { trigger_type: 'TASK_DELETED' },
        ),
      },
    });
  }

  beforeEach(() => {
    mockPrisma.task.findFirst.mockResolvedValue(null); // hard-deleted
    mockPrisma.user.findMany.mockResolvedValue([ANN]);
  });

  it('survives this guard - it does NOT die with "The task no longer exists"', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(deletedTaskEnrollment());

    await advanceEnrollment(ENR_ID, NOW);

    const finish = mockPrisma.workflowEnrollment.update.mock.calls[0][0].data;
    expect(finish.finished_reason).not.toBe('The task no longer exists');
  });

  /**
   * And then stops for the HONEST reason instead. A deleted task has no due date left, so
   * there is nothing to count backwards from - the synthesised bundle deliberately carries no
   * EntityState, which is what makes the anchor unresolvable rather than fabricated. This is
   * the same message any entity whose anchor date was cleared already gets.
   */
  it('stops on the anchor it can no longer resolve, and sends nothing', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(deletedTaskEnrollment());

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'the task due date is no longer scheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Spec B slice 6 - the SECOND staleness guard
// ══════════════════════════════════════════════════════════════════════════════

/**
 * There are TWO terminal-staleness call sites, and they must not diverge: the per-step guard at
 * block 6 (covered in enrollment.test.ts) and the anchored-WAIT re-check at block 4b, here.
 *
 * A workflow whose send is preceded by an anchored wait never reaches block 6 while it is
 * parked - it wakes, re-reads the task, and re-decides at 4b. Testing only the per-step guard
 * would ship a suppression that works for simple workflows and silently fails for the ones that
 * wait, which is exactly the shape of the deleted-task bug slice 4 had to fix at this same
 * guard.
 */
describe('advanceEnrollment - anchored WAIT on a task that finished', () => {
  const TASK_ID = 'aa000000-0000-0000-0000-0000000000f5';
  const TASK_TITLE = 'Replace the lobby thermostat';
  const DUE_AT = new Date(NOW.getTime() + 25 * 60 * 60_000); // target = due - 24h = now + 1h
  const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };

  const taskAnchoredWait = (position: number) => ({
    position,
    step_type: 'WAIT',
    config: { mode: 'anchored', anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
  });

  const taskRow = (status: string) => ({
    id: TASK_ID,
    task_number: 'T00042',
    title: TASK_TITLE,
    status,
    priority: 'HIGH',
    assignee_ids: [ANN.id],
    watcher_ids: [],
    due_at: DUE_AT,
    linked_entity_type: null,
    linked_entity_id: null,
    created_by: ANN.id,
    creator: ANN,
  });

  function taskEnrollment() {
    return enrollmentRow({
      entity_type: 'task',
      entity_id: TASK_ID,
      entity_label: TASK_TITLE,
      occurrence_key: DUE_AT.toISOString(),
      dedupe_key: `TASK_DATE_ANCHORED:${TASK_ID}:${DUE_AT.toISOString()}`,
      workflow: workflowRow({ trigger_type: 'TASK_DATE_ANCHORED' }),
      version: {
        definition: def(
          [
            taskAnchoredWait(0),
            { position: 1, step_type: 'SEND_EMAIL', config: { recipients: ['assignees'], subject: 's', body: 'b' } },
          ],
          {
            trigger_type: 'TASK_DATE_ANCHORED',
            trigger_config: { anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
          },
        ),
      },
    });
  }

  beforeEach(() => {
    mockPrisma.user.findMany.mockResolvedValue([ANN]);
  });

  it('stops AT THE WAIT, with the readable reason and without claiming a step run', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow('DONE'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment());

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The task was completed',
    });
    // Block 4b stops BEFORE it claims, which is what proves this is the WAIT guard and not the
    // per-step one: a claim row would mean the enrollment had walked past the wait.
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('stops at the wait for a cancelled task too, with its own sentence', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow('CANCELLED'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment());

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The task was cancelled',
    });
  });

  /**
   * The contrast that makes the two above mean something: the SAME workflow, the SAME dates,
   * an open task - it parks on the anchor as it always did, so what changed is the suppression
   * and not the fixture.
   */
  it('an open task still parks on the anchor and stays alive', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow('IN_PROGRESS'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment());

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowEnrollment.update).not.toHaveBeenCalled();
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.data.resume_at.getTime()).toBe(DUE_AT.getTime() - 1440 * 60_000);
  });
});
