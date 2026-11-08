import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AutomationTriggerType } from '@prisma/client';
import { prisma } from '../../../lib/prisma';
import { TRIGGERS } from '../catalog';
import {
  enrollOnEvent,
  createEnrollment,
  advanceEnrollment,
  mapStepToActionType,
  RETIRED_IN_APP_STEP_DETAIL,
} from '../enrollment';
import { isSupportedStepType } from '../workflowValidation';

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
const LATE = new Date('2026-07-15T02:00:00.000Z'); // 22:00 July 14 America/New_York — outside window

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
  // Entitled to automations by default - every pre-existing test in this file
  // exercises the normal enrollment path, not the entitlement gate.
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: null,
};

// S8 §2 (A4, RATIFIED): the anchored-WAIT/STOP_IF/terminal-staleness resolver now reads
// context.ts's resolveNextJobVisit(isLiveVisit subset) instead of a flat Job.scheduled_start
// column, so `state.jobScheduledStart` (and so `job_rescheduled`'s STOP_IF condition and every
// JOB_DATE_ANCHORED staleness check below) tracks `visits[0].scheduled_at`, not the top-level
// `scheduled_start` field. `scheduled_start` itself is kept on the fixture for parity with the
// real Job row shape (other scenarios spread over JOB_ROW to change job.status, unrelated to
// scheduling), but any override that means to move the effective anchor date MUST also override
// `visits` — see the two PAST_START overrides below.
const JOB_ROW = {
  id: JOB_ID,
  job_number: 'J00042',
  status: 'SCHEDULED',
  scheduled_start: new Date('2026-07-15T13:00:00.000Z'),
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
  visits: [
    {
      id: 'visit-1',
      status: 'SCHEDULED',
      scheduled_at: new Date('2026-07-15T13:00:00.000Z'),
      scheduled_end: null,
      created_at: new Date('2026-07-01T00:00:00.000Z'),
      assignees: [{ user: { id: 'tech-1', email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' } }],
    },
  ],
};

// ── step + definition + row builders ──────────────────────────────────────────
const waitStep = (position: number, duration_minutes: number) => ({ position, step_type: 'WAIT', config: { duration_minutes } });
const emailStep = (position: number) => ({ position, step_type: 'SEND_EMAIL', config: { recipient: 'customer', subject: 's', body: 'b' } });
const textStep = (position: number) => ({ position, step_type: 'SEND_TEXT', config: { recipient: 'customer', body: 'b' } });
const notifyStep = (position: number) => ({ position, step_type: 'NOTIFY_TEAM', config: { recipient: 'assigned_techs', body: 'b' } });
const stopIfStep = (position: number, condition: string) => ({ position, step_type: 'STOP_IF', config: { condition } });

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
    version: { definition: def([emailStep(0)]) },
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
    updateMany: vi.fn().mockResolvedValue({ count: 1 }), // cursor CAS succeeds by default
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.automationRun = mockPrisma.automationRun ?? {};
  mockPrisma.automationRun.findUnique = vi.fn().mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);
});

// ── mapStepToActionType (point 18) ────────────────────────────────────────────
describe('mapStepToActionType', () => {
  it('maps every step type', () => {
    expect(mapStepToActionType('SEND_TEXT' as any)).toBe('SEND_SMS');
    expect(mapStepToActionType('SEND_EMAIL' as any)).toBe('SEND_EMAIL');
    expect(mapStepToActionType('WAIT' as any)).toBeNull();
    expect(mapStepToActionType('STOP_IF' as any)).toBeNull();
  });

  it('returns null for the retired in-app step, so the function agrees with isSupportedStepType', () => {
    // This function's whole job is to name the executor action a step dispatches
    // to, and the retired in-app step dispatches to nothing (docs/adr/0005).
    // While it still answered 'NOTIFY_TEAM' it was the last line in this file a
    // grep for the retired label could read as a live send path - unreachable
    // today only because advanceEnrollment's isSupportedStepType guard sits in
    // front of it. Returning null makes the two agree, so the non-null assertion
    // at the executeAction call is true by construction rather than by the
    // ordering of two branches. The legacy AutomationRule -> step direction is
    // unaffected: migrateRules.ts still maps the historic action to its label.
    expect(mapStepToActionType('NOTIFY_TEAM' as any)).toBeNull();
    expect(isSupportedStepType('NOTIFY_TEAM' as any)).toBe(false);
  });
});

// ── enrollOnEvent (points 1-2) ────────────────────────────────────────────────
describe('enrollOnEvent', () => {
  it('enrolls a matching PUBLISHED+enabled workflow and inline-advances it', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow()]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' } },
      NOW,
    );
    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
    // inline advance happened: a step-run was claimed and the send was dispatched
    expect(mockPrisma.workflowStepRun.create).toHaveBeenCalledTimes(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({ status: 'COMPLETED' });
  });

  it('excludes DRAFT / disabled workflows via the findMany where-clause', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([]);
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' } },
      NOW,
    );
    expect(mockPrisma.workflow.findMany.mock.calls[0][0]).toMatchObject({
      where: {
        organization_id: ORG,
        trigger_type: 'JOB_SCHEDULED',
        is_enabled: true,
        status: 'PUBLISHED',
        published_version_id: { not: null },
      },
    });
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('one failing workflow does not block the others', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow({ id: 'wf-a' }), workflowRow({ id: 'wf-b' })]);
    // first enrollment create throws (non-P2002) — createEnrollment swallows it and returns null;
    // second one enrolls + advances.
    mockPrisma.workflowEnrollment.create
      .mockRejectedValueOnce(new Error('db down'))
      .mockResolvedValueOnce({ id: ENR_ID });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID } },
      NOW,
    );
    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(2);
    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  // SRVW-113 — the ONE case enrollOnEvent must filter on trigger_config, not just
  // trigger_type + org + enabled: two JOB_SUB_STATUS_ENTERED workflows can watch
  // two DIFFERENT sub-statuses, so only the one matching THIS occurrence enrolls.
  describe('sub-status predicate (Approach A)', () => {
    const subStatusWorkflow = (subStatusId: string, overrides: Record<string, unknown> = {}) =>
      workflowRow({
        id: `wf-${subStatusId}`,
        trigger_type: 'JOB_SUB_STATUS_ENTERED',
        trigger_config: { sub_status_id: subStatusId },
        ...overrides,
      });

    it('enrolls the workflow whose trigger_config.sub_status_id matches the occurrence', async () => {
      mockPrisma.workflow.findMany.mockResolvedValueOnce([subStatusWorkflow('sub-a')]);
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({ dedupe_key: `JOB_SUB_STATUS_ENTERED:${JOB_ID}:sub-a`, occurrence_key: 'sub-a' }),
      );
      await enrollOnEvent(
        { type: 'JOB_SUB_STATUS_ENTERED', organizationId: ORG, entity: { type: 'job', id: JOB_ID }, occurrenceKey: 'sub-a' },
        NOW,
      );
      expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
    });

    it('skips a workflow whose trigger_config.sub_status_id does not match the occurrence', async () => {
      mockPrisma.workflow.findMany.mockResolvedValueOnce([subStatusWorkflow('sub-b')]);
      await enrollOnEvent(
        { type: 'JOB_SUB_STATUS_ENTERED', organizationId: ORG, entity: { type: 'job', id: JOB_ID }, occurrenceKey: 'sub-a' },
        NOW,
      );
      expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
    });

    it('two workflows watching different sub-statuses: only the matching one enrolls', async () => {
      mockPrisma.workflow.findMany.mockResolvedValueOnce([subStatusWorkflow('sub-a'), subStatusWorkflow('sub-b')]);
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({ dedupe_key: `JOB_SUB_STATUS_ENTERED:${JOB_ID}:sub-a`, occurrence_key: 'sub-a' }),
      );
      await enrollOnEvent(
        { type: 'JOB_SUB_STATUS_ENTERED', organizationId: ORG, entity: { type: 'job', id: JOB_ID }, occurrenceKey: 'sub-a' },
        NOW,
      );
      expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.workflowEnrollment.create.mock.calls[0][0].data.workflow_id).toBe('wf-sub-a');
    });
  });
});

// ── createEnrollment (point 3) ────────────────────────────────────────────────
describe('createEnrollment', () => {
  it('writes the enrollment with dedupe key + occurrence and returns its id', async () => {
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'TECH_ASSIGNED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID, label: 'J00042' },
      occurrenceKey: 'tech-1',
      now: NOW,
    });
    expect(res).toEqual({ id: ENR_ID });
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      workflow_id: WF_ID,
      workflow_version_id: VER_ID,
      status: 'ACTIVE',
      entity_type: 'job',
      entity_id: JOB_ID,
      occurrence_key: 'tech-1',
      dedupe_key: `TECH_ASSIGNED:${JOB_ID}:tech-1`,
      step_cursor: 0,
      organization_id: ORG,
    });
    expect(data.resume_at.getTime()).toBe(NOW.getTime());
  });

  it('cross-engine cutover guard: a folded workflow defers to an existing legacy run with the same dedupe key', async () => {
    mockPrisma.automationRun.findUnique.mockResolvedValueOnce({ id: 'legacy-run-1' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG, legacy_rule_id: 'rule-9' },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.automationRun.findUnique).toHaveBeenCalledWith({
      where: { rule_id_dedupe_key: { rule_id: 'rule-9', dedupe_key: `JOB_SCHEDULED:${JOB_ID}` } },
      select: { id: true },
    });
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('cross-engine cutover guard: no legacy run -> enrolls normally; non-folded workflows never even look', async () => {
    mockPrisma.workflowEnrollment.create.mockResolvedValue({ id: ENR_ID });
    const folded = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG, legacy_rule_id: 'rule-9' },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(folded).toEqual({ id: ENR_ID });
    mockPrisma.automationRun.findUnique.mockClear();
    const native = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG, legacy_rule_id: null },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(native).toEqual({ id: ENR_ID });
    expect(mockPrisma.automationRun.findUnique).not.toHaveBeenCalled();
  });

  it('returns null (no throw) on a P2002 dedupe collision — the idempotency guarantee', async () => {
    mockPrisma.workflowEnrollment.create.mockRejectedValueOnce({ code: 'P2002' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
  });

  it('returns null (no throw) when the occurrence key is missing for an occurrence-scoped trigger', async () => {
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'TECH_ASSIGNED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  // The removed technician has to survive to whatever step actually sends —
  // possibly after a WAIT of days — so it's captured at ENROLLMENT time, not
  // re-derived later (they're off the crew by then).
  it('persists eventPayload onto the enrollment row as event_payload', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair', phone: '+15550000011' };
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'TECH_UNASSIGNED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      occurrenceKey: 'r1',
      eventPayload: { recipient: removed },
      now: NOW,
    });
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toEqual({ recipient: removed });
  });

  it('writes event_payload as null when no eventPayload is given (every existing trigger)', async () => {
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toBeNull();
  });

  // Rule 0's plumbing. advanceEnrollment takes only an id and the cron sweeper
  // resumes a parked enrollment long after the request is gone, so the acting
  // user cannot be threaded in memory - it is persisted on the same JSON column
  // that already carries the removed recipient and the request-time merge fields.
  it('persists the dispatching actor onto the enrollment row', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow()]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      {
        type: 'JOB_SCHEDULED',
        organizationId: ORG,
        entity: { type: 'job', id: JOB_ID, label: 'J00042' },
        actorId: 'actor-1',
      },
      NOW,
    );
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toMatchObject({ actorId: 'actor-1' });
  });

  it('persists the actor ALONGSIDE whatever else the event captured', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair', phone: '+15550000011' };
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow({ trigger_type: 'TECH_UNASSIGNED' })]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      {
        type: 'TECH_UNASSIGNED',
        organizationId: ORG,
        entity: { type: 'job', id: JOB_ID },
        occurrenceKey: 'r1',
        actorId: 'actor-1',
        eventPayload: { recipient: removed, mergeFields: { 'event.note': 'left the crew' } },
      },
      NOW,
    );
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toEqual({
      recipient: removed,
      mergeFields: { 'event.note': 'left the crew' },
      actorId: 'actor-1',
    });
  });

  // The Stripe webhook and the public doors pass actorId: null deliberately, and
  // the cron sweeps pass no payload at all. Neither may start writing
  // { actorId: null } - the null-payload guarantee above is what keeps a
  // no-payload enrollment cheap and the existing assertion honest.
  it('an event with no payload and no actor still writes event_payload null', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow()]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      {
        type: 'JOB_SCHEDULED',
        organizationId: ORG,
        entity: { type: 'job', id: JOB_ID },
        actorId: null,
      },
      NOW,
    );
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.event_payload).toBeNull();
  });
});

// createEnrollment is the ONE choke point every enrollment path funnels through -
// enrollOnEvent's per-workflow loop AND cron.ts's date-anchored sweep both call it
// directly (see docstring). Gating here, rather than only in enrollOnEvent, is what
// makes the check survive a plan downgrade, a hand-built workflow, or any future
// dispatch site - see docs/adr/0001-gate-automation-engine-at-point-of-effect.md.
describe('createEnrollment - entitlement gate (#1069)', () => {
  it('a STARTER org (below automations\' PRO minimum) never enrolls - fails closed, no throw', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_ROW, plan: 'STARTER' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('a PRO org enrolls normally', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_ROW, plan: 'PRO' });
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toEqual({ id: ENR_ID });
  });

  it('a STARTER org with an explicit automations override still enrolls - the real entitlement resolver is used, not a hardcoded plan check', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      ...ORG_ROW,
      plan: 'STARTER',
      feature_overrides: { automations: true },
    });
    mockPrisma.workflowEnrollment.create.mockResolvedValueOnce({ id: ENR_ID });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toEqual({ id: ENR_ID });
  });

  it('downgrade case: a PRO org whose override explicitly revokes automations never enrolls, even for a hand-built workflow', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({
      ...ORG_ROW,
      plan: 'PRO',
      feature_overrides: { automations: false },
    });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it('a missing organization row fails closed rather than throwing', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce(null);
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  it("cron.ts's direct createEnrollment call (the date-anchored sweep / timed poller path) is covered too - same function, same gate", async () => {
    // No enrollOnEvent involved here - this reproduces cron.ts's call shape exactly
    // (see services/automations/cron.ts) to prove the poller path isn't a gap.
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ ...ORG_ROW, plan: 'STARTER' });
    const res = await createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_DATE_ANCHORED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      occurrenceKey: 'anchor-1',
      now: NOW,
    });
    expect(res).toBeNull();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });
});

// ── advanceEnrollment (points 1-10) ───────────────────────────────────────────
// ── run counters (#1882) ────────────────────────────────────────────
// The automations list reads workflows.trigger_count + last_triggered_at as
// "Ran N times · last X ago", and sums the same column into "Runs all-time". They
// count RUNS, and one enrollment is one run. The count used to be bumped per SENT
// step inside advanceEnrollment, which was wrong in both directions.
describe('run counters (#1882)', () => {
  function enroll(overrides: Record<string, unknown> = {}) {
    return createEnrollment({
      workflow: { id: WF_ID, published_version_id: VER_ID, trigger_type: 'JOB_SCHEDULED', organization_id: ORG },
      entity: { type: 'job', id: JOB_ID },
      now: NOW,
      ...overrides,
    });
  }

  it('one enrollment counts once and stamps last_triggered_at', async () => {
    await enroll();
    expect(mockPrisma.workflow.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflow.update.mock.calls[0][0]).toMatchObject({
      where: { id: WF_ID },
      data: { trigger_count: { increment: 1 }, last_triggered_at: NOW },
    });
  });

  it('a run whose every send is SKIPPED still counts - the reported symptom', async () => {
    mockExecute.mockResolvedValueOnce({ status: 'SKIPPED', detail: 'No recipients' });
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow()]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID } },
      NOW,
    );
    // the run really did complete having sent nothing
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data.status).toBe('SKIPPED');
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
    expect(mockPrisma.workflow.update).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflow.update.mock.calls[0][0].data.trigger_count).toEqual({ increment: 1 });
  });

  it('a workflow with two send steps counts ONE run, not one per send', async () => {
    mockPrisma.workflow.findMany.mockResolvedValueOnce([workflowRow()]);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), textStep(1)]) } }),
    );
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID } },
      NOW,
    );
    expect(mockExecute).toHaveBeenCalledTimes(2);
    expect(mockPrisma.workflow.update).toHaveBeenCalledTimes(1);
  });

  it('a dedupe collision counts nothing - rescanning one occurrence is not a second run', async () => {
    mockPrisma.workflowEnrollment.create.mockRejectedValueOnce({ code: 'P2002' });
    expect(await enroll()).toBeNull();
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled();
  });

  it('an unentitled org counts nothing - the gate is upstream of the counter', async () => {
    mockPrisma.organization.findUnique.mockResolvedValueOnce({ plan: 'STARTER', trial_ends_at: null, feature_overrides: null });
    expect(await enroll()).toBeNull();
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled();
  });

  it('a failed counter update leaves the enrollment standing, so the caller still advances it', async () => {
    mockPrisma.workflow.update.mockRejectedValueOnce(new Error('db down'));
    expect(await enroll()).toEqual({ id: ENR_ID });
  });
});

describe('advanceEnrollment', () => {
  it('returns early when the enrollment is missing, not ACTIVE, or not yet due', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(null);
    await advanceEnrollment(ENR_ID, NOW);

    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow({ status: 'COMPLETED' }));
    await advanceEnrollment(ENR_ID, NOW);

    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ resume_at: new Date(NOW.getTime() + 60_000) }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
  });

  it('full walk [SEND_EMAIL]: claims, sends once, records SENT, CASes cursor, completes', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);

    // claim = the pessimistic FAILED provisional insert
    const claim = mockPrisma.workflowStepRun.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ enrollment_id: ENR_ID, step_index: 0, step_type: 'SEND_EMAIL', status: 'FAILED' });

    expect(mockExecute).toHaveBeenCalledTimes(1);
    // executor is fed a per-step id for the notification dedup key
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ id: `${WF_ID}:0`, action_type: 'SEND_EMAIL' });

    // outcome update on the claimed row
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0]).toMatchObject({
      where: { id: 'run-1' },
      data: { status: 'SENT' },
    });
    // The run counter belongs to the ENROLLMENT, not the step (#1882): advancing
    // never touches it, however many of the steps send.
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled();
    // cursor CAS 0 -> 1
    expect(mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: ENR_ID, step_cursor: 0, status: 'ACTIVE' },
      data: { step_cursor: 1 },
    });
    // completed
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      finished_reason: 'Completed all steps',
    });
  });

  // The enrollment's persisted event_payload must reach the executor on EVERY
  // step, not just the first — re-read fresh alongside the entity each time
  // (block 6), so it survives however many WAIT steps come before the send.
  it('threads the enrollment’s event_payload into the executor’s bundle (eventRecipient + merged mergeCtx)', async () => {
    const removed = { id: 'r1', email: 'removed@org.com', first_name: 'Priya', last_name: 'Nair', phone: '+15550000011' };
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        workflow: workflowRow({ trigger_type: 'TECH_UNASSIGNED' }),
        version: { definition: def([emailStep(0)], { trigger_type: 'TECH_UNASSIGNED' }) },
        event_payload: { recipient: removed, mergeFields: { 'event.note': 'left the crew' } },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    const bundle = mockExecute.mock.calls[0][1];
    expect(bundle.eventRecipient).toEqual(removed);
    expect(bundle.mergeCtx['event.note']).toBe('left the crew');
  });

  // The failure mode Rule 0 in the engine is most likely to have: correct on the
  // first step, silently lapsed after a WAIT - the one configuration where
  // nobody would notice. The actor is re-read from event_payload on EVERY step,
  // so a send parked behind days of WAIT still excludes the person who acted.
  it('the actor still reaches the executor bundle after a WAIT step', async () => {
    // Step 0 is the WAIT; the enrollment resumes at cursor 1, the send.
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        step_cursor: 1,
        version: { definition: def([waitStep(0, 4320), emailStep(1)]) },
        event_payload: { actorId: 'actor-1' },
      }),
    );
    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + 3 * 24 * 60 * 60_000));

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].actorId).toBe('actor-1');
  });

  it('[WAIT(1d), SEND_TEXT]: WAIT records CONTINUED, parks resume_at at now+1d, sends nothing', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([waitStep(0, 1440), textStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'CONTINUED',
      detail: 'Waited 1 day',
    });
    const cas = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(cas.where).toMatchObject({ id: ENR_ID, step_cursor: 0 });
    expect(cas.data.step_cursor).toBe(1);
    expect(cas.data.resume_at.getTime()).toBe(NOW.getTime() + 1440 * 60_000);
    expect(mockExecute).not.toHaveBeenCalled(); // parked before any send
  });

  it('resumes after a park (cursor=1, due) and finishes the flow', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ step_cursor: 1, version: { definition: def([waitStep(0, 1440), textStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.create.mock.calls[0][0].data.step_index).toBe(1);
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('STOP_IF holds -> step-run STOPPED + enrollment STOPPED; later steps never run', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: '2026-07-14T13:00:00.000Z', // differs from job.scheduled_start -> "rescheduled"
        version: { definition: def([stopIfStep(0, 'job_rescheduled'), textStep(1)]) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: 'Stopped — the job was rescheduled',
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Stopped — the job was rescheduled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it("STOP_IF doesn't hold -> CONTINUED, next step runs in the same tick", async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: '2026-07-15T13:00:00.000Z', // matches job.scheduled_start -> not rescheduled
        version: { definition: def([stopIfStep(0, 'job_rescheduled'), emailStep(1)]) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'CONTINUED',
      detail: 'Checked — kept going',
    });
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('terminal staleness (cancelled job on JOB_SCHEDULED) -> STOPPED; no send', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce({ ...JOB_ROW, status: 'CANCELLED' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: 'Job was cancelled',
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Job was cancelled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('entity gone (job.findFirst -> null) -> STOPPED "no longer exists"', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(null);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({ status: 'STOPPED' });
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data.detail).toMatch(/no longer exists/i);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.finished_reason).toMatch(/no longer exists/i);
  });

  it('send-window deferral: BUSINESS_HOURS at 22:00 -> parks WITHOUT claiming, cursor unchanged', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ resume_at: LATE, version: { definition: def([textStep(0)], { send_window: 'BUSINESS_HOURS' }) } }),
    );
    await advanceEnrollment(ENR_ID, LATE);
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled(); // no claim, no step-run row
    const park = mockPrisma.workflowEnrollment.updateMany.mock.calls[0][0];
    expect(park.where).toMatchObject({ id: ENR_ID, step_cursor: 0, status: 'ACTIVE' });
    expect(park.data.step_cursor).toBeUndefined(); // cursor unchanged
    expect(park.data.resume_at.toISOString()).toBe('2026-07-15T12:00:00.000Z'); // next 08:00 NY
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('claim race: workflowStepRun.create rejects P2002 -> return, no send, no CAS', async () => {
    mockPrisma.workflowStepRun.create.mockRejectedValueOnce({ code: 'P2002' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update).not.toHaveBeenCalled();
  });

  it('cursor CAS loses after a send (count 0) -> loop exits without advancing again', async () => {
    mockPrisma.workflowEnrollment.updateMany.mockResolvedValueOnce({ count: 0 });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.create).toHaveBeenCalledTimes(1); // only step 0 claimed
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update).not.toHaveBeenCalled(); // never reached COMPLETED
  });

  it('transient skip: executeAction SKIPPED -> step-run SKIPPED, flow continues', async () => {
    mockExecute
      .mockResolvedValueOnce({ status: 'SKIPPED', detail: 'Customer has no email address on file' })
      .mockResolvedValueOnce({ status: 'SKIPPED', detail: 'Customer has no email address on file' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data.status).toBe('SKIPPED');
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled(); // advancing never bumps counters (#1882)
    expect(mockExecute).toHaveBeenCalledTimes(2); // continued to step 1
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  // Slice 03 of the scheduling-notifications build: the executor now answers per audience,
  // and the ledger row must carry that answer or the Activity view has nothing to show.
  it('the per-audience outcomes the executor returns are written onto the step run', async () => {
    const audienceOutcomes = [
      { audience: 'customer', label: 'the customer', outcome: 'skipped', summary: 'The customer has no email address on file' },
      { audience: 'assigned_team', label: 'the assigned crew', outcome: 'sent', summary: 'Sent to mike@org.com' },
    ];
    mockExecute.mockResolvedValueOnce({ status: 'SENT', recipientSummary: 'mike@org.com', detail: 'ok', audienceOutcomes });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'SENT',
      audience_outcomes: audienceOutcomes,
    });
  });

  it('an executor result with no per-audience answer writes an empty list, never null', async () => {
    mockExecute.mockResolvedValueOnce({ status: 'SKIPPED', detail: 'Unknown action type' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data.audience_outcomes).toEqual([]);
  });

  it('executeAction throws -> step-run FAILED with the message, flow continues, no throw', async () => {
    mockExecute.mockRejectedValueOnce(new Error('resend exploded'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'FAILED',
      detail: 'resend exploded',
    });
    expect(mockExecute).toHaveBeenCalledTimes(2); // cursor CAS'd, step 1 still ran
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('TECH_ASSIGNED narrowing: occurrence tech no longer assigned -> SKIPPED, flow continues', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: 'tech-99', // not on the crew
        workflow: workflowRow({ trigger_type: 'TECH_ASSIGNED' }),
        // a step type that STILL sends - the retired in-app step is intercepted
        // before this block and never reaches the narrowing (see the retired-step
        // describe at the end of this file).
        version: { definition: def([emailStep(0)], { trigger_type: 'TECH_ASSIGNED' }) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'SKIPPED',
      detail: 'Technician is no longer assigned to this job',
    });
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED'); // continued, not stopped
  });

  it('workflow disabled mid-flight -> STOPPED "Automation was turned off"', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ workflow: workflowRow({ is_enabled: false }) }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Automation was turned off',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  it('an unexpected internal error is caught: no throw, and the GUARDED annotate can only touch a still-provisional claim', async () => {
    mockPrisma.job.findFirst.mockRejectedValueOnce(new Error('db exploded'));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(enrollmentRow());
    await expect(advanceEnrollment(ENR_ID, NOW)).resolves.toBeUndefined();
    // The catch-all uses a guarded updateMany filtered to the provisional
    // sentinel — a row already resolved (e.g. SENT before the CAS threw) is
    // never clobbered; the recovery sweeper finishes those instead.
    expect(mockPrisma.workflowStepRun.updateMany.mock.calls[0][0]).toEqual({
      where: { id: 'run-1', status: 'FAILED', detail: 'Interrupted mid-step' },
      data: { detail: 'db exploded' },
    });
  });

  it('executes with the PINNED definition trigger, not the live workflow row — a mid-flight trigger edit cannot corrupt staleness', async () => {
    // Live row was edited to INVOICE_OVERDUE, but this enrollment is pinned to a
    // JOB_SCHEDULED definition. The cancelled job MUST stop the flow — judging
    // it as INVOICE_OVERDUE would find no invoice state and wrongly send.
    mockPrisma.job.findFirst.mockResolvedValueOnce({ ...JOB_ROW, status: 'CANCELLED' });
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ workflow: workflowRow({ trigger_type: 'INVOICE_OVERDUE' }) }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: 'Job was cancelled',
    });
    expect(mockExecute).not.toHaveBeenCalled();
  });

  // ── direction wiring (Task A5b) — terminalStale.test.ts proves the pure
  //    function is direction-aware; these two prove enrollment.ts actually
  //    EXTRACTS trigger_config.direction and threads it through call site 7
  //    correctly, using the SAME already-passed anchor for both, so a wiring
  //    mistake (e.g. always passing 'before', or never reading trigger_config)
  //    would fail one of this pair.
  describe('date-anchored trigger direction wiring', () => {
    const PAST_START = new Date('2026-07-14T10:00:00.000Z'); // before NOW (2026-07-14T15:00:00.000Z)

    it("JOB_DATE_ANCHORED direction:'before' stops once the anchor has already passed", async () => {
      mockPrisma.job.findFirst.mockResolvedValueOnce({
        ...JOB_ROW,
        scheduled_start: PAST_START,
        // S8 §2 (A4): state.jobScheduledStart now tracks the live visit, not this top-level
        // column — the visit itself must move too for this override to take effect.
        visits: [{ ...JOB_ROW.visits[0], scheduled_at: PAST_START }],
      });
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({
          occurrence_key: PAST_START.toISOString(),
          workflow: workflowRow({ trigger_type: 'JOB_DATE_ANCHORED' }),
          version: {
            definition: def([emailStep(0)], {
              trigger_type: 'JOB_DATE_ANCHORED',
              trigger_config: { anchor: 'job.scheduled_start', direction: 'before', offset_minutes: 60 },
            }),
          },
        }),
      );
      await advanceEnrollment(ENR_ID, NOW);
      expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
        status: 'STOPPED',
        detail: 'Job start time has already passed',
      });
      expect(mockExecute).not.toHaveBeenCalled();
    });

    it("JOB_DATE_ANCHORED direction:'after' does NOT stop on the SAME already-passed anchor", async () => {
      mockPrisma.job.findFirst.mockResolvedValueOnce({
        ...JOB_ROW,
        scheduled_start: PAST_START,
        // S8 §2 (A4): state.jobScheduledStart now tracks the live visit, not this top-level
        // column — the visit itself must move too for this override to take effect.
        visits: [{ ...JOB_ROW.visits[0], scheduled_at: PAST_START }],
      });
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
        enrollmentRow({
          occurrence_key: PAST_START.toISOString(),
          workflow: workflowRow({ trigger_type: 'JOB_DATE_ANCHORED' }),
          version: {
            definition: def([emailStep(0)], {
              trigger_type: 'JOB_DATE_ANCHORED',
              trigger_config: { anchor: 'job.scheduled_start', direction: 'after', offset_minutes: 60 },
            }),
          },
        }),
      );
      await advanceEnrollment(ENR_ID, NOW);
      expect(mockExecute).toHaveBeenCalledTimes(1);
      expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
    });
  });
});

// ── D18: the dedupe key carries the visit id, the occurrence key does NOT ─────
// Multi-visit S7/B1. Two visits on the SAME job under the SAME trigger must
// enrol twice: keyed on the job alone, visit 2's notification is swallowed by
// the [workflow_id, dedupe_key] unique constraint as a duplicate of visit 1's.
//
// The occurrence key is deliberately left byte-identical, because FOUR modules
// read it as an ISO timestamp (stopIf.ts:54, terminalStale.ts:66/:81/:157) and
// return a stale-reason - i.e. they SILENTLY kill the run - when the compare
// fails. Widening that format would break every anchored wait with no test
// anywhere seeing it, so these cases are the guard on it.
describe('visit-scoped dedupe key (D18)', () => {
  const V1 = 'd0000000-0000-0000-0000-0000000000a1';
  const V2 = 'd0000000-0000-0000-0000-0000000000a2';

  beforeEach(() => {
    mockPrisma.workflow.findMany.mockResolvedValue([workflowRow()]);
  });

  it('two visits on one job produce two distinct enrollments, both with a bare occurrence key', async () => {
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' }, visitId: V1 },
      NOW,
    );
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' }, visitId: V2 },
      NOW,
    );

    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(2);
    const first = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    const second = mockPrisma.workflowEnrollment.create.mock.calls[1][0].data;

    expect(first.dedupe_key).toBe(`JOB_SCHEDULED:${JOB_ID}:${V1}`);
    expect(second.dedupe_key).toBe(`JOB_SCHEDULED:${JOB_ID}:${V2}`);
    expect(first.dedupe_key).not.toBe(second.dedupe_key);

    // Unchanged from today: JOB_SCHEDULED is not occurrence-scoped.
    expect(first.occurrence_key).toBeNull();
    expect(second.occurrence_key).toBeNull();
  });

  it('a rescheduled visit keeps occurrence_key as the bare new-start ISO, with no visit id inside it', async () => {
    const newStart = new Date('2026-07-20T13:00:00.000Z');
    mockPrisma.workflow.findMany.mockResolvedValue([workflowRow({ trigger_type: 'JOB_RESCHEDULED' })]);
    await enrollOnEvent(
      {
        type: 'JOB_RESCHEDULED',
        organizationId: ORG,
        entity: { type: 'job', id: JOB_ID, label: 'J00042' },
        occurrenceKey: newStart.toISOString(),
        visitId: V1,
      },
      NOW,
    );

    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.occurrence_key).toBe(newStart.toISOString());
    expect(data.occurrence_key).not.toContain(V1);
    expect(data.dedupe_key).toBe(`JOB_RESCHEDULED:${JOB_ID}:${V1}:${newStart.toISOString()}`);
  });

  it('an event with no visit id keys byte-identically to today (the cron and date-anchor paths)', async () => {
    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' } },
      NOW,
    );
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.dedupe_key).toBe(`JOB_SCHEDULED:${JOB_ID}`);
    expect(data.occurrence_key).toBeNull();
  });
});

/**
 * ── Per-visit automation enrollment (spec 2026-09-14): the enrollment RECORDS which trip it is
 *    about, and the dedupe key does not change ──────────────────────────────────────────────────
 *
 * Criterion 6 (`createEnrollment` writes `visit_id`), criterion 7 (`dedupe_key` is byte-identical
 * for every CRON-enrolled trigger) and criterion 8 (`occurrence_key` stays a bare ISO date).
 *
 * Criterion 7 is the one this file exists to hold, and D6 spells out why it is the decision most
 * likely to be got wrong. `createEnrollment` has accepted a `visitId` since #2086 and splices it
 * into the key as `entityId:visitId` - for the DISPATCH doors, whose occurrences are freshly
 * minted millisecond stamps that no historical row can hold. A cron occurrence is a visit's FUTURE
 * `scheduled_at`, which historical rows DO hold, so the same one-word edit here would stop those
 * rows colliding and re-remind every customer inside the trigger's lead-time window, once, on
 * deploy day. The fixture has two visits so that a key which silently acquired a visit id would
 * differ from the pinned string rather than merely looking longer.
 */
describe('per-visit enrollment - the visit is persisted, the dedupe key is not widened', () => {
  const JOB_VISIT_TUE = 'c0000000-0000-0000-0000-0000000000b1';
  const JOB_VISIT_THU = 'c0000000-0000-0000-0000-0000000000b2';
  const TUESDAY = new Date('2026-07-15T13:00:00.000Z');
  const THURSDAY = new Date('2026-07-17T17:30:00.000Z');

  /** The cron door: a candidate names its trip, and asks for NO visit-scoped dedupe key. */
  const sweepEnrollment = (visitId: string, occurrence: Date) =>
    createEnrollment({
      workflow: {
        id: WF_ID,
        published_version_id: VER_ID,
        trigger_type: 'BEFORE_JOB_START',
        organization_id: ORG,
      },
      entity: { type: 'job', id: JOB_ID, label: 'J00042' },
      occurrenceKey: occurrence.toISOString(),
      visitId,
      now: NOW,
    });

  it('writes visit_id on the row for each of a job’s two trips (criterion 6)', async () => {
    await sweepEnrollment(JOB_VISIT_TUE, TUESDAY);
    await sweepEnrollment(JOB_VISIT_THU, THURSDAY);

    const [first, second] = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data);
    expect(first.visit_id).toBe(JOB_VISIT_TUE);
    expect(second.visit_id).toBe(JOB_VISIT_THU);
    // D5: the entity stays the parent job on both.
    expect(first.entity_id).toBe(JOB_ID);
    expect(second.entity_id).toBe(JOB_ID);
  });

  it('keeps dedupe_key byte-identical to the pre-change cron key, with no visit id inside it (D6, criterion 7)', async () => {
    await sweepEnrollment(JOB_VISIT_TUE, TUESDAY);
    await sweepEnrollment(JOB_VISIT_THU, THURSDAY);

    const [first, second] = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data);
    expect(first.dedupe_key).toBe(`BEFORE_JOB_START:${JOB_ID}:${TUESDAY.toISOString()}`);
    expect(second.dedupe_key).toBe(`BEFORE_JOB_START:${JOB_ID}:${THURSDAY.toISOString()}`);
    expect(first.dedupe_key).not.toContain(JOB_VISIT_TUE);
    expect(second.dedupe_key).not.toContain(JOB_VISIT_THU);
    // Two trips at different times already mint two keys and already both enrol, which is why the
    // visit id buys the dedupe key nothing here and costs a deploy-day double send.
    expect(first.dedupe_key).not.toBe(second.dedupe_key);
  });

  it('keeps occurrence_key a bare ISO date on the visit-scoped path (D3, criterion 8)', async () => {
    await sweepEnrollment(JOB_VISIT_THU, THURSDAY);

    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.occurrence_key).toBe(THURSDAY.toISOString());
    expect(data.occurrence_key).not.toContain(JOB_VISIT_THU);
    // The format stopIf.ts and terminalStale.ts compare against, restated as the round trip they
    // make: anything wider parses back to a different instant and goes silently stale.
    expect(new Date(data.occurrence_key).toISOString()).toBe(data.occurrence_key);
  });

  /**
   * The DISPATCH door keeps its visit-scoped key, unchanged. D6's rule is not "never scope by
   * visit" but "scope by visit only where the occurrence is minted fresh at dispatch time", and
   * #2086 is deployed on staging emitting exactly this shape. Pinned here beside the cron key so
   * the two cannot be conflated by whoever reads one of them next.
   */
  it('still scopes the dispatch door’s key by visit, and persists the same visit id (D6, D11)', async () => {
    mockPrisma.workflow.findMany.mockResolvedValue([workflowRow()]);

    await enrollOnEvent(
      {
        type: 'JOB_SCHEDULED',
        organizationId: ORG,
        entity: { type: 'job', id: JOB_ID, label: 'J00042' },
        visitId: JOB_VISIT_THU,
      },
      NOW,
    );

    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.dedupe_key).toBe(`JOB_SCHEDULED:${JOB_ID}:${JOB_VISIT_THU}`);
    expect(data.visit_id).toBe(JOB_VISIT_THU);
  });

  it('writes visit_id NULL when no trip is named, so every existing row and every per-entity trigger is unchanged (D10)', async () => {
    mockPrisma.workflow.findMany.mockResolvedValue([workflowRow()]);

    await enrollOnEvent(
      { type: 'JOB_SCHEDULED', organizationId: ORG, entity: { type: 'job', id: JOB_ID, label: 'J00042' } },
      NOW,
    );

    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data;
    expect(data.visit_id).toBeNull();
  });
});

/**
 * ── D4: a missing visit STOPS the enrollment; it never falls back (criterion 14) ───────────────
 *
 * The precedent is `deletedTaskBundle`: a message about work that has been destroyed is worse than
 * silence. The alternative on offer here is strictly worse than silence - falling back to the
 * parent's own resolution sends the customer a DIFFERENT trip's date, address and crew, which is
 * the defect this whole spec exists to remove. It is also why `visit_id` carries no foreign key
 * (D2): SetNull would perform exactly that silent fallback on every deleted visit.
 *
 * The reason names the VISIT, not the parent, because the parent is usually perfectly alive.
 */
describe('advanceEnrollment - a visit that is gone (D4)', () => {
  const GONE = 'c0000000-0000-0000-0000-0000000000ff';

  it('stops the enrollment, with a reason naming the visit, when visit_id matches no visit on the job', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ visit_id: GONE, version: { definition: def([emailStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The visit no longer exists',
    });
  });

  /**
   * A visit belonging to ANOTHER organisation is the same answer, and it is the same code path:
   * the parent is read with the tenant clause and the trip is looked up among ITS visits, so a
   * foreign visit is simply not there. Stated separately because the failure it prevents is a
   * cross-tenant leak, not a stale reminder.
   */
  it('never falls back to the parent’s own resolution - the job’s live visit is NOT rendered instead', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ visit_id: GONE, version: { definition: def([emailStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    // JOB_ROW has a live visit on 2026-07-15 that the per-entity resolver would happily have
    // picked. Nothing was sent at all, which is the point.
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.finished_reason).not.toContain('job');
  });

  it('an enrollment with visit_id null keeps today’s message when the PARENT is the thing that vanished', async () => {
    mockPrisma.job.findFirst.mockResolvedValueOnce(null);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([emailStep(0)]) } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The job no longer exists',
    });
  });
});

/**
 * ── Criterion 16: terminalStale judges the CARRIED visit, not the parent's own pick ────────────
 *
 * User story 6 - "a reminder for Thursday survives Tuesday's visit being completed". `EntityState`
 * travels separately from the merge fields, so a test that pins the rendered strings cannot see
 * this: `leadWalkthroughScheduledAt` and `leadVisitStatus` are what terminalStale reads, and
 * before this change both came from `resolveCurrentWalkthrough` - the lead's EARLIEST LIVE visit.
 *
 * THREE visits, and that is not padding. With two (one finished, one live) the earliest-live
 * resolver lands on the same row the enrollment carries, and the assertion passes on unfixed code.
 * A third live trip in between is what makes "the parent's pick" and "the carried trip" different
 * rows, so the test can actually fail.
 */
describe('advanceEnrollment - the carried visit governs staleness (criterion 16)', () => {
  const LEAD_ID = 'd0000000-0000-0000-0000-000000000001';
  const TUESDAY = { id: 'wt-tue', at: new Date('2026-07-15T13:00:00.000Z') }; // finished
  const WEDNESDAY = { id: 'wt-wed', at: new Date('2026-07-16T13:00:00.000Z') }; // live, the parent's pick
  const THURSDAY = { id: 'wt-thu', at: new Date('2026-07-17T13:00:00.000Z') }; // live, what this reminder is about

  const leadRow = () => ({
    id: LEAD_ID,
    lead_number: 'L00042',
    status: 'CONTACTED',
    service_request: 'replace the shop doors',
    job_type: 'door replacement',
    customer: {
      id: 'c0000000-0000-0000-0000-000000000001',
      first_name: 'Sarah',
      last_name: 'Mitchell',
      email: 'sarah@emanuel-demo.local',
      phone: '+15550100155',
    },
    visits: [
      { id: TUESDAY.id, status: 'COMPLETED', scheduled_at: TUESDAY.at, completed_at: TUESDAY.at, cancelled_at: null, created_at: new Date('2026-07-01'), assignees: [] },
      { id: WEDNESDAY.id, status: 'SCHEDULED', scheduled_at: WEDNESDAY.at, completed_at: null, cancelled_at: null, created_at: new Date('2026-07-02'), assignees: [] },
      { id: THURSDAY.id, status: 'SCHEDULED', scheduled_at: THURSDAY.at, completed_at: null, cancelled_at: null, created_at: new Date('2026-07-03'), assignees: [] },
    ],
    commission_owner: null,
    service_location: { address_line1: '11 Cedar Lane', city: 'Asheville', state: 'NC' },
    created_at: new Date('2026-07-01'),
    contacted_at: new Date('2026-07-02'),
    walkthrough_first_booked_at: null,
    last_visit_completed_at: TUESDAY.at,
    first_estimate_sent_at: null,
  });

  const LEAD_ANCHOR = { anchor: 'lead.walkthrough_scheduled_at', direction: 'before', offset_minutes: 1440 };

  const leadEnrollment = (overrides: Record<string, unknown> = {}) =>
    enrollmentRow({
      entity_type: 'lead',
      entity_id: LEAD_ID,
      entity_label: 'L00042',
      occurrence_key: THURSDAY.at.toISOString(),
      dedupe_key: `LEAD_DATE_ANCHORED:${LEAD_ID}:${THURSDAY.at.toISOString()}`,
      workflow: workflowRow({ trigger_type: 'LEAD_DATE_ANCHORED' }),
      version: {
        definition: def([emailStep(0)], { trigger_type: 'LEAD_DATE_ANCHORED', trigger_config: LEAD_ANCHOR }),
      },
      ...overrides,
    });

  beforeEach(() => {
    mockPrisma.lead.findFirst.mockResolvedValue(leadRow());
  });

  it("sends Thursday's reminder though Tuesday's trip was completed and Wednesday's is the lead's current visit", async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(leadEnrollment({ visit_id: THURSDAY.id }));

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      finished_reason: 'Completed all steps',
    });
  });

  it('resolves leadWalkthroughScheduledAt and leadVisitStatus off the carried trip (criterion 12)', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(leadEnrollment({ visit_id: THURSDAY.id }));

    await advanceEnrollment(ENR_ID, NOW);

    // Rendered through the send, because the state is not returned anywhere a test can read it
    // directly on this path: the date the customer is given IS the carried visit's.
    const ctx = mockExecute.mock.calls[0][1].mergeCtx;
    expect(ctx['lead.walkthrough_date']).not.toBe('');
    expect(ctx['lead.walkthrough_time']).not.toBe('');
  });

  /**
   * The same enrollment WITHOUT a visit id, which is every row created before this shipped (D10).
   * It keeps today's behaviour byte for byte: the parent's earliest live trip is Wednesday, the
   * occurrence says Thursday, and the reminder stops as superseded. Asserted on the same
   * three-visit fixture so that if per-entity resolution ever quietly became per-visit, this test
   * - not only the one above - would notice.
   */
  it('a visit_id-less enrollment still resolves per entity and stops as superseded (criterion 13)', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(leadEnrollment());

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'Walkthrough was rescheduled — this reminder was replaced by an updated one',
    });
  });
});

// ── the retired in-app step, at run time ──────────────────────────────────────
// Published versions are immutable, so a version published before the in-app step
// was retired keeps it in its frozen definition JSON for ever. It must stop sending
// WITHOUT breaking the run, and the admin must see product copy rather than the
// executor's internal `Unknown action type` string.
describe('advanceEnrollment - a legacy in-app step', () => {
  it('is skipped with a human-readable detail and the enrollment continues to the next step', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([notifyStep(0), emailStep(1)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    const skipped = mockPrisma.workflowStepRun.update.mock.calls[0][0].data;
    expect(skipped.status).toBe('SKIPPED');
    expect(skipped.detail).toBe(RETIRED_IN_APP_STEP_DETAIL);
    expect(skipped.detail).not.toMatch(/unknown action type/i);

    // the retired step never reaches the executor; the next step still runs
    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][0].action_type).toBe('SEND_EMAIL');
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  // Pins the BRANCH POSITION. The TECH_ASSIGNED narrowing below it skips with
  // 'Technician is no longer assigned to this job' - false for a retired step, and
  // tech-assignment-alert was one of the gallery templates that minted these steps,
  // so this is the likeliest legacy case rather than a corner one.
  it('reports the retired-step reason on a TECH_ASSIGNED trigger, not the unassigned-technician reason', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        occurrence_key: 'tech-99', // not on the crew
        workflow: workflowRow({ trigger_type: 'TECH_ASSIGNED' }),
        version: { definition: def([notifyStep(0)], { trigger_type: 'TECH_ASSIGNED' }) },
      }),
    );
    await advanceEnrollment(ENR_ID, NOW);

    const skipped = mockPrisma.workflowStepRun.update.mock.calls[0][0].data;
    expect(skipped).toMatchObject({ status: 'SKIPPED', detail: RETIRED_IN_APP_STEP_DETAIL });
    expect(skipped.detail).not.toMatch(/no longer assigned/i);
  });

  it('is skipped immediately rather than parked until the send window opens', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        resume_at: LATE,
        version: { definition: def([notifyStep(0)], { send_window: 'BUSINESS_HOURS' }) },
      }),
    );
    await advanceEnrollment(ENR_ID, LATE);

    expect(mockPrisma.workflowStepRun.create).toHaveBeenCalledTimes(1); // claimed, not parked
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'SKIPPED',
      detail: RETIRED_IN_APP_STEP_DETAIL,
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('emits nothing and bumps no trigger counter', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({ version: { definition: def([notifyStep(0)]) } }),
    );
    await advanceEnrollment(ENR_ID, NOW);
    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflow.update).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Spec B slice 4 - the ONE entity whose row can be legitimately gone
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A deleted task is the only case in this engine where the entity is guaranteed absent by the
 * time the workflow runs, and the change that lets it survive lands in the hottest shared path
 * there is: the per-step entity load that every enrollment of every entity walks on every step.
 *
 * So this block asserts BOTH halves. The escape hatch opens for TASK_DELETED, and it opens for
 * nothing else - not for the other four entities, whose stop message is asserted by TEXT so a
 * regression is visible rather than merely counted, and not for the other task triggers, whose
 * survival would mean a deleted task went on chasing people with reminders.
 */
describe('advanceEnrollment - a vanished entity', () => {
  const TASK_ID = 'aa000000-0000-0000-0000-0000000000f1';
  const TASK_TITLE = 'Order the replacement thermostat';
  const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };
  const CAT = { id: 'u3', email: 'cat@org.com', first_name: 'Cat', last_name: 'Diaz' };

  const taskEmailStep = (position: number) => ({
    position,
    step_type: 'SEND_EMAIL',
    config: { recipients: ['assignees', 'watchers'], subject: 'Cancelled: {{task.title}}', body: 'Task {{task.number}} is gone' },
  });

  const DELETED_PAYLOAD = {
    mergeFields: { 'task.number': 'T00042', 'task.title': TASK_TITLE },
    taskSnapshot: { assigneeIds: [ANN.id], watcherIds: [CAT.id], creatorId: null },
    actorId: 'u9',
  };

  /** An enrollment for a task that has already been hard-deleted. */
  function taskEnrollment(trigger: string, overrides: Record<string, unknown> = {}) {
    return enrollmentRow({
      entity_type: 'task',
      entity_id: TASK_ID,
      entity_label: TASK_TITLE,
      dedupe_key: `${trigger}:${TASK_ID}`,
      event_payload: DELETED_PAYLOAD,
      workflow: workflowRow({ trigger_type: trigger }),
      version: { definition: def([taskEmailStep(0)], { trigger_type: trigger }) },
      ...overrides,
    });
  }

  beforeEach(() => {
    mockPrisma.task.findFirst.mockResolvedValue(null); // hard-deleted, for the whole enrollment
    mockPrisma.user.findMany.mockResolvedValue([ANN, CAT]);
  });

  it('TASK_DELETED runs its send against the payload instead of stopping', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment('TASK_DELETED'));

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'COMPLETED',
      finished_reason: 'Completed all steps',
    });
  });

  it('hands the executor the snapshot roster and the identity fields, off a row that is gone', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment('TASK_DELETED'));

    await advanceEnrollment(ENR_ID, NOW);

    const bundle = mockExecute.mock.calls[0][1];
    expect(bundle.assignees).toEqual([ANN]);
    expect(bundle.watchers).toEqual([CAT]);
    expect(bundle.mergeCtx['task.number']).toBe('T00042');
    expect(bundle.mergeCtx['task.title']).toBe(TASK_TITLE);
    expect(bundle.entityRef).toEqual({ type: 'task', id: TASK_ID, label: TASK_TITLE });
  });

  /**
   * THE CONSTRAINING TEST. Derived from the catalogue rather than hand-listed, so the
   * date-anchored task trigger the reminder slice adds is constrained the day it exists - which
   * is the whole point: a broad "a missing task is survivable" hatch would let a DELETED task
   * carry on taking its due-date reminders, and this suite is where that is prevented.
   */
  it('every OTHER task trigger still STOPS with the existing message - a deleted task is not chased', async () => {
    const otherTaskTriggers = Object.values(AutomationTriggerType).filter(
      (t) => TRIGGERS[t].entity === 'task' && t !== 'TASK_DELETED',
    );
    expect(otherTaskTriggers.length).toBeGreaterThan(0);

    for (const trigger of otherTaskTriggers) {
      vi.clearAllMocks();
      mockPrisma.task.findFirst.mockResolvedValue(null);
      mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
      mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment(trigger));

      await advanceEnrollment(ENR_ID, NOW);

      expect(mockExecute, `${trigger} sent mail about a deleted task`).not.toHaveBeenCalled();
      expect(
        mockPrisma.workflowEnrollment.update.mock.calls[0][0].data,
        `${trigger} did not stop`,
      ).toMatchObject({ status: 'STOPPED', finished_reason: 'The task no longer exists' });
    }
  });

  /**
   * The regression the reviewer is asked to look for, asserted by TEXT rather than by shape:
   * the hatch lands in the per-step load every entity shares, and a genuinely-vanished job,
   * lead, estimate or invoice must stop exactly as it did before, with exactly the same words
   * in the enrollment's finished_reason and on the claimed step run.
   */
  it.each([
    ['job', 'JOB_SCHEDULED'],
    ['lead', 'LEAD_CREATED'],
    ['estimate', 'ESTIMATE_SENT'],
    ['invoice', 'INVOICE_SENT'],
  ])('a vanished %s still stops with "The %s no longer exists", unchanged', async (entity, trigger) => {
    mockPrisma[entity].findFirst.mockResolvedValue(null);
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      enrollmentRow({
        entity_type: entity,
        entity_id: 'c0000000-0000-0000-0000-0000000000f2',
        // The payload a task deletion would carry, on the WRONG entity. Even handed the
        // snapshot, these four must not synthesise anything.
        event_payload: DELETED_PAYLOAD,
        workflow: workflowRow({ trigger_type: trigger }),
        version: { definition: def([emailStep(0)], { trigger_type: trigger }) },
      }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      detail: `The ${entity} no longer exists`,
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: `The ${entity} no longer exists`,
    });
  });

  /**
   * Story 21 with a WAIT in front of it. The send happens hours after the row was destroyed,
   * on a wake that carries nothing but an enrollment id - so the identity has to come off the
   * persisted payload, which is exactly what a dispatch-time-only mechanism would fail to do.
   */
  it('renders the identity on a wake HOURS after the delete, with a WAIT step in front', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      taskEnrollment('TASK_DELETED', {
        step_cursor: 1, // the WAIT is already behind it
        version: { definition: def([waitStep(0, 240), taskEmailStep(1)], { trigger_type: 'TASK_DELETED' }) },
      }),
    );

    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + 4 * 60 * 60_000));

    expect(mockExecute).toHaveBeenCalledTimes(1);
    expect(mockExecute.mock.calls[0][1].mergeCtx['task.title']).toBe(TASK_TITLE);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Spec B slice 6 - a finished task stops chasing people
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Stories 19 and 20, at the seam an admin actually sees. terminalStale.ts's own suite proves
 * the pure rule; this block proves the engine ACTS on it - the send does not happen, the
 * enrollment finishes rather than erroring or vanishing, and the words written to the step run
 * are the readable sentence the activity tab renders.
 *
 * The message text is asserted verbatim on purpose: it is product copy, not an internal code.
 */
describe('advanceEnrollment - a task that finished before the send', () => {
  const TASK_ID = 'aa000000-0000-0000-0000-0000000000f4';
  const TASK_TITLE = 'Replace the lobby thermostat';
  const DUE_AT = new Date('2026-07-16T13:00:00.000Z');
  const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };

  const taskEmail = (position: number) => ({
    position,
    step_type: 'SEND_EMAIL',
    config: { recipients: ['assignees'], subject: 'Due soon', body: 'Due {{task.due_date}}' },
  });

  const taskRow = (overrides: Record<string, unknown> = {}) => ({
    id: TASK_ID,
    task_number: 'T00042',
    title: TASK_TITLE,
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    assignee_ids: [ANN.id],
    watcher_ids: [],
    due_at: DUE_AT,
    linked_entity_type: null,
    linked_entity_id: null,
    created_by: ANN.id,
    creator: ANN,
    ...overrides,
  });

  function taskEnrollment(trigger: string, overrides: Record<string, unknown> = {}) {
    return enrollmentRow({
      entity_type: 'task',
      entity_id: TASK_ID,
      entity_label: TASK_TITLE,
      occurrence_key: DUE_AT.toISOString(),
      dedupe_key: `${trigger}:${TASK_ID}:${DUE_AT.toISOString()}`,
      workflow: workflowRow({ trigger_type: trigger }),
      version: {
        definition: def([taskEmail(0)], {
          trigger_type: trigger,
          trigger_config: { anchor: 'task.due_at', direction: 'before', offset_minutes: 1440 },
        }),
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow());
    mockPrisma.user.findMany.mockResolvedValue([ANN]);
  });

  it('sends nothing and stops the enrollment when the task was completed', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ status: 'DONE' }));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment('TASK_DATE_ANCHORED'));

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toEqual({
      status: 'STOPPED',
      detail: 'The task was completed',
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The task was completed',
    });
  });

  it('stops with its own sentence when the task was cancelled', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ status: 'CANCELLED', due_at: DUE_AT }));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment('TASK_DATE_ANCHORED'));

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toEqual({
      status: 'STOPPED',
      detail: 'The task was cancelled',
    });
  });

  it('still sends for a task that is merely BLOCKED - blocked work is what a chase is for', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ status: 'BLOCKED' }));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment('TASK_DATE_ANCHORED'));

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).toHaveBeenCalledTimes(1);
  });

  it('stops when the due date has moved off the occurrence this run was enrolled for', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: new Date('2026-07-20T13:00:00.000Z') }));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(taskEnrollment('TASK_DATE_ANCHORED'));

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The task due date was changed - this run was replaced by an updated reminder',
    });
  });

  /**
   * The event triggers get the same floor. A workflow that waits a day before mailing about a
   * new task must not mail about one that was finished inside that day.
   */
  it('suppresses an event-triggered send for a task completed during the wait', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ status: 'DONE' }));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValueOnce(
      taskEnrollment('TASK_CREATED', {
        occurrence_key: null,
        step_cursor: 1,
        version: {
          definition: def([waitStep(0, 1440), taskEmail(1)], { trigger_type: 'TASK_CREATED', trigger_config: null }),
        },
      }),
    );

    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + 24 * 60 * 60_000));

    expect(mockExecute).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data).toMatchObject({
      status: 'STOPPED',
      finished_reason: 'The task was completed',
    });
  });
});
