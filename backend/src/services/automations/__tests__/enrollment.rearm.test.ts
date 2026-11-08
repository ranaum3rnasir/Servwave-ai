import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { rearmAnchoredWaits } from '../enrollment';

// Mirror the sibling harnesses (enrollment.test.ts / enrollment.anchoredWait.test.ts):
// stub the executor so a stray send would be observable. rearm re-times pending
// waits ONLY — it must never dispatch a message.
vi.mock('../executors', () => ({
  executeAction: vi.fn().mockResolvedValue({ status: 'SENT', recipientSummary: 'x@y.com', detail: 'ok' }),
}));
import { executeAction } from '../executors';

const mockPrisma = prisma as any;
const mockExecute = executeAction as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
const WF_ID = 'f0000000-0000-0000-0000-000000000001';
const VER_ID = 'a0000000-0000-0000-0000-000000000002';
const ENR_ID = 'e0000000-0000-0000-0000-000000000003';

// The walkthrough date this enrollment was pinned to when it parked at the wait.
const OLD_WALKTHROUGH = new Date('2026-08-01T15:00:00.000Z');
const OFFSET = 1440; // minutes = 1 day (the "1 day before the walkthrough" reminder)

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
};

// Live lead row — walkthrough_scheduled_at is the anchor rearm reads FRESH via
// loadExecutionBundle (→ state.leadWalkthroughScheduledAt).
//
// Walkthrough-as-entity redesign, PR-B2: the anchor now resolves from the lead's CURRENT
// visit (D15) via the `walkthroughs` relation instead of the legacy flat column. `null` means
// "no current visit" (a REQUESTED-only lead), mirroring the old "walkthrough cleared" case.
const leadRow = (walkthroughAt: Date | null) => ({
  id: LEAD_ID,
  lead_number: 'L00042',
  status: 'CONTACTED',
  service_request: 'Leaking kitchen faucet',
  visits: walkthroughAt
    ? [{
        id: 'w0000000-0000-0000-0000-000000000001', status: 'SCHEDULED', scheduled_at: walkthroughAt,
        duration_minutes: 60, completed_at: null, cancelled_at: null, cancelled_reason: null,
        cancelled_by: null, customer_email_sent_at: null, notes: null, created_at: new Date('2026-07-01'),
        performers: [{ user: { first_name: 'Mike', last_name: 'Torres' } }],
      }]
    : [],
  customer: {
    id: 'c0000000-0000-0000-0000-000000000001',
    first_name: 'Sarah',
    last_name: 'Mitchell',
    email: 'sarah@example.com',
    phone: '+15551234567',
  },
});

// An anchored WAIT: parks until lead.walkthrough_scheduled_at − 1 day (read live).
const anchoredWaitStep = (
  position: number,
  overrides: Partial<{ anchor: string; direction: string; offset_minutes: number }> = {},
) => ({
  position,
  step_type: 'WAIT',
  config: { mode: 'anchored', anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: OFFSET, ...overrides },
});
const emailStep = (position: number) => ({ position, step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 's', body: 'b' } });
// A legacy RELATIVE wait (now + duration) — NOT anchored, so rearm must ignore it.
const relativeWaitStep = (position: number, duration_minutes: number) => ({ position, step_type: 'WAIT', config: { duration_minutes } });

function def(steps: unknown[], overrides: Record<string, unknown> = {}) {
  return { trigger_type: 'WALKTHROUGH_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps, ...overrides };
}

// A findMany enrollment row, shaped like the rearm include
// (version.definition + workflow.trigger_type) plus the scalar fields it reads.
// Default: an ACTIVE, fires-once (WALKTHROUGH_SCHEDULED) enrollment parked at an
// anchored WAIT at cursor 0, pinned to the OLD walkthrough occurrence.
function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENR_ID,
    workflow_id: WF_ID,
    workflow_version_id: VER_ID,
    status: 'ACTIVE',
    entity_type: 'lead',
    entity_id: LEAD_ID,
    entity_label: 'L00042',
    occurrence_key: OLD_WALKTHROUGH.toISOString(),
    dedupe_key: `WALKTHROUGH_SCHEDULED:${LEAD_ID}`,
    step_cursor: 0,
    organization_id: ORG,
    version: { definition: def([anchoredWaitStep(0)]) },
    workflow: { trigger_type: 'WALKTHROUGH_SCHEDULED' },
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Reassign with findMany + updateMany present (the two methods rearm calls);
  // the rest are here for parity with the sibling harnesses.
  mockPrisma.workflowEnrollment = {
    findMany: vi.fn().mockResolvedValue([]),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    create: vi.fn(),
    findUnique: vi.fn(),
    update: vi.fn().mockResolvedValue({}),
  };
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.lead.findFirst.mockResolvedValue(leadRow(OLD_WALKTHROUGH));
});

describe('rearmAnchoredWaits', () => {
  // ── Scenario 1: re-arm on move (fires-once trigger) — later + earlier ────────
  it('re-arms a fires-once anchored wait to a LATER date: resume_at = newDate − offset, occurrence_key = newDate ISO', async () => {
    const LATER = new Date('2026-08-05T15:00:00.000Z'); // moved 4 days later
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([enrollmentRow()]);
    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow(LATER));

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    // CAS-scoped to this enrollment's parked cursor.
    expect(call.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    // resume_at follows the moved date (start − 1 day) …
    expect(call.data.resume_at.getTime()).toBe(LATER.getTime() - OFFSET * 60_000);
    // … and occurrence_key syncs to the live date so Task 4b staleness keeps it.
    expect(call.data.occurrence_key).toBe(LATER.toISOString());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('re-arms a fires-once anchored wait to an EARLIER date too', async () => {
    const EARLIER = new Date('2026-07-20T15:00:00.000Z'); // moved earlier than OLD
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([enrollmentRow()]);
    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow(EARLIER));

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(call.data.resume_at.getTime()).toBe(EARLIER.getTime() - OFFSET * 60_000);
    expect(call.data.occurrence_key).toBe(EARLIER.toISOString());
  });

  // ── Scenario 2: skip the reschedule trigger (THE double-send guard) ──────────
  it('SKIPS an enrollment whose pinned trigger is the entity reschedule trigger (double-send guard)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      enrollmentRow({
        version: { definition: def([anchoredWaitStep(0)], { trigger_type: 'WALKTHROUGH_RESCHEDULED' }) },
        workflow: { trigger_type: 'WALKTHROUGH_RESCHEDULED' },
      }),
    ]);
    // Even though the walkthrough moved, this reschedule-triggered enrollment gets
    // a FRESH enrollment from the new event + is dropped by staleness — re-arming
    // it would resurrect a superseded copy and double-send. Must be left untouched.
    // (No lead.findFirst mock: we assert below that it is never even loaded.)

    await rearmAnchoredWaits('lead', LEAD_ID);

    // Untouched: no re-arm write, and we short-circuit BEFORE loading the entity.
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findFirst).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── Scenario 3: ignore non-anchored-wait enrollments ────────────────────────
  it('leaves non-anchored-wait enrollments untouched (a SEND_EMAIL step and a relative WAIT step)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      // current step is a SEND_EMAIL — not a wait at all
      enrollmentRow({ id: 'e0000000-0000-0000-0000-00000000000a', version: { definition: def([emailStep(0)]) } }),
      // current step is a legacy RELATIVE wait (now + duration) — a WAIT but not anchored
      enrollmentRow({ id: 'e0000000-0000-0000-0000-00000000000b', version: { definition: def([relativeWaitStep(0, 1440)]) } }),
    ]);

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── Scenario 4: anchor null → skip (STOP happens at the next wake, not here) ──
  it('leaves the enrollment as-is when the live anchor date is null (un-scheduled walkthrough)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([enrollmentRow()]);
    mockPrisma.lead.findFirst.mockResolvedValueOnce(leadRow(null)); // walkthrough cleared

    await rearmAnchoredWaits('lead', LEAD_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});

// ── Job entity mirror — same function, the OTHER entityType branch ──────────
// job.controller.ts calls rearmAnchoredWaits('job', id) right after a reschedule
// (existing.scheduled_start ? 'JOB_RESCHEDULED' : 'JOB_SCHEDULED'). The lead
// coverage above proves the shared step-filtering/offset-math logic; this proves
// the job-specific wiring itself: job.scheduled_start is read live, and
// RESCHEDULE_TRIGGER.job ('JOB_RESCHEDULED') is the correct double-send skip key.
describe('rearmAnchoredWaits — job entity', () => {
  const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
  const OLD_START = new Date('2026-08-01T13:00:00.000Z');
  const JOB_ENR_ID = 'e0000000-0000-0000-0000-00000000000c';

  // S8 §2 (A4, RATIFIED): the anchored-WAIT resolver now reads context.ts's
  // resolveNextJobVisit(isLiveVisit subset) instead of a flat Job.scheduled_start column — the
  // fixture carries a `visits` array (what `include: { visits: {...} }` would return) rather
  // than a bare scheduled_start. `jobRow(scheduledStart)` is the single-visit convenience form
  // every pre-existing scenario here uses (a single live visit makes "upcoming vs not"
  // irrelevant — one item always wins regardless); `jobRowWithVisits` below is the multi-visit
  // form the new "re-parks when the NEXT visit changes" scenario needs.
  type JobVisitFixture = {
    id: string;
    status: string;
    scheduled_at: Date | null;
    scheduled_end?: Date | null;
    created_at: Date;
    assignees: { user: { id: string; email: string; first_name: string; last_name: string } }[];
  };
  const JOB_TECH = { user: { id: 'tech-1', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' } };
  function jobLiveVisit(id: string, scheduledAt: Date, createdAt = new Date('2026-07-01T00:00:00.000Z')): JobVisitFixture {
    return { id, status: 'SCHEDULED', scheduled_at: scheduledAt, scheduled_end: null, created_at: createdAt, assignees: [JOB_TECH] };
  }
  const jobRowWithVisits = (visits: JobVisitFixture[]) => ({
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
  const jobRow = (scheduledStart: Date | null) =>
    jobRowWithVisits(scheduledStart ? [jobLiveVisit('visit-1', scheduledStart)] : []);

  const jobAnchoredWaitStep = (position: number) => ({
    position,
    step_type: 'WAIT',
    config: { mode: 'anchored', anchor: 'job.scheduled_start', direction: 'before', offset_minutes: OFFSET },
  });

  function jobDef(steps: unknown[], overrides: Record<string, unknown> = {}) {
    return { trigger_type: 'JOB_SCHEDULED', trigger_config: null, send_window: 'ANYTIME', steps, ...overrides };
  }

  function jobEnrollmentRow(overrides: Record<string, unknown> = {}) {
    return {
      id: JOB_ENR_ID,
      workflow_id: WF_ID,
      workflow_version_id: VER_ID,
      status: 'ACTIVE',
      entity_type: 'job',
      entity_id: JOB_ID,
      entity_label: 'J00042',
      occurrence_key: OLD_START.toISOString(),
      dedupe_key: `JOB_SCHEDULED:${JOB_ID}`,
      step_cursor: 0,
      organization_id: ORG,
      version: { definition: jobDef([jobAnchoredWaitStep(0)]) },
      workflow: { trigger_type: 'JOB_SCHEDULED' },
      ...overrides,
    } as any;
  }

  beforeEach(() => {
    mockPrisma.job.findFirst.mockResolvedValue(jobRow(OLD_START));
  });

  it('re-arms a fires-once anchored wait when the job is RESCHEDULED to a later date', async () => {
    const LATER = new Date('2026-08-05T13:00:00.000Z');
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([jobEnrollmentRow()]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(LATER));

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(call.where).toMatchObject({ id: JOB_ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(call.data.resume_at.getTime()).toBe(LATER.getTime() - OFFSET * 60_000);
    expect(call.data.occurrence_key).toBe(LATER.toISOString());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('SKIPS a JOB_RESCHEDULED-triggered enrollment — the double-send guard for jobs', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      jobEnrollmentRow({
        version: { definition: jobDef([jobAnchoredWaitStep(0)], { trigger_type: 'JOB_RESCHEDULED' }) },
        workflow: { trigger_type: 'JOB_RESCHEDULED' },
      }),
    ]);
    // A reschedule-triggered enrollment gets a FRESH copy from the new event and
    // is dropped by staleness — re-arming it here would resurrect a superseded
    // copy and double-send. Must be left untouched, entity never even loaded.

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('leaves the enrollment as-is when the job is no longer scheduled (scheduled_start cleared)', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([jobEnrollmentRow()]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(jobRow(null));

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('leaves the enrollment as-is when EVERY visit on the job is CANCELLED — same as no visits at all', async () => {
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([jobEnrollmentRow()]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([
        { id: 'visit-1', status: 'CANCELLED', scheduled_at: OLD_START, created_at: new Date('2026-07-01'), assignees: [] },
      ]),
    );

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // S8 §2 (A4, RATIFIED): "re-parks when that one moves" — the multi-visit half of the WAIT
  // contract. The enrollment was originally pinned to visit-1's date (occurrence_key =
  // OLD_START), but by the time this job's reschedule fires rearmAnchoredWaits, visit-1 has
  // been pushed WAY out and a DIFFERENT visit (visit-2) is now the soonest upcoming one. Because
  // context.ts re-resolves resolveNextJobVisit over the live set on every load (never persists
  // "which visit"), rearm must re-park against visit-2 — proving the anchor tracks whichever
  // visit is next, not whichever visit was next when the enrollment was created.
  //
  // resolveNextJobVisit's "upcoming" filter has no injectable clock (defaults to `new Date()`,
  // exactly like syncJobFromVisits's own caller) — so the visits that must win the "upcoming"
  // race are built off REAL Date.now(), matching the established convention for this exact
  // constraint (job-visits.test.ts's past/future fixtures; enrollment.anchoredWait.test.ts's
  // multi-visit park test above).
  it('re-parks against a DIFFERENT visit than the one it was pinned to when that visit is now the soonest upcoming one', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const pastVisit = new Date(Date.now() - 2 * DAY_MS); // visit-3: already elapsed
    const pushedOut = new Date(Date.now() + 30 * DAY_MS); // visit-1: originally pinned, now pushed out
    const newSoonest = new Date(Date.now() + 5 * DAY_MS); // visit-2: now the soonest upcoming
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([jobEnrollmentRow()]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([
        jobLiveVisit('visit-1', pushedOut),
        jobLiveVisit('visit-2', newSoonest),
        jobLiveVisit('visit-3', pastVisit),
      ]),
    );

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(call.data.resume_at.getTime()).toBe(newSoonest.getTime() - OFFSET * 60_000);
    expect(call.data.occurrence_key).toBe(newSoonest.toISOString());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  /**
   * ── Per-visit automation enrollment (spec 2026-09-14), D9 and criterion 17 ────────────────────
   *
   * User story 7: "rescheduling one trip does not silently re-point the reminder at another."
   *
   * `rearmAnchoredWaits` is the ONE `loadExecutionBundle` site that passes neither an event
   * payload nor a trigger, and the cost of it not passing the visit id is worse than a wrong
   * countdown: it WRITES its answer back as `occurrence_key`. The occurrence key is half the
   * dedupe key, so on a visit-scoped enrollment a per-entity re-arm silently moves the row's
   * identity onto a trip it is not about - and that survives long after this function returns.
   *
   * The scenario directly above pins the per-ENTITY rule and stays right for rows with no visit id
   * (D10 back-fills nothing). This is the same fixture with the id carried: visit-1 was pushed out
   * to +30 days and, because the enrollment is about visit-1, that is where it must re-park - even
   * though visit-2 is now the soonest trip on the job.
   */
  it('re-parks and re-keys against the CARRIED visit, not the job\u2019s new soonest one (criterion 17)', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const pushedOut = new Date(Date.now() + 30 * DAY_MS); // visit-1: the trip this reminder is about
    const newSoonest = new Date(Date.now() + 5 * DAY_MS); // visit-2: sooner, and none of its business
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      jobEnrollmentRow({ visit_id: 'visit-1' }),
    ]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([jobLiveVisit('visit-1', pushedOut), jobLiveVisit('visit-2', newSoonest)]),
    );

    await rearmAnchoredWaits('job', JOB_ID);

    expect(mockPrisma.workflowEnrollment.updateMany).toHaveBeenCalledTimes(1);
    const call = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(call.data.resume_at.getTime()).toBe(pushedOut.getTime() - OFFSET * 60_000);
    // THE half that outlives the send: occurrence_key is re-synced to the carried trip's own date,
    // never to a sibling's. Written wrong, the enrollment's identity moves onto another trip.
    expect(call.data.occurrence_key).toBe(pushedOut.toISOString());
    expect(call.data.occurrence_key).not.toBe(newSoonest.toISOString());
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('leaves a carried-visit enrollment alone when that trip is gone, rather than re-keying it onto a sibling', async () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    mockPrisma.workflowEnrollment.findMany.mockResolvedValueOnce([
      jobEnrollmentRow({ visit_id: 'visit-deleted' }),
    ]);
    mockPrisma.job.findFirst.mockResolvedValueOnce(
      jobRowWithVisits([jobLiveVisit('visit-2', new Date(Date.now() + 5 * DAY_MS))]),
    );

    await rearmAnchoredWaits('job', JOB_ID);

    // The loader returns null (D4) and rearm's own `if (!loaded) continue` leaves the row exactly
    // as it is; the STOP is the enrollment's next wake to record, as it already is for a cleared
    // anchor. What must NOT happen is a re-key onto visit-2.
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockExecute).not.toHaveBeenCalled();
  });
});
