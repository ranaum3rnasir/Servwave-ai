/**
 * legacy-in-app-step-double-notify.test.ts - the payoff of retiring the in-app step.
 *
 * Spec A's second live defect: a NOTIFY_TEAM step and the hardcoded assignment
 * emit() fire for the SAME job assignment, so the technician got two INTERRUPT
 * toasts - one DISPATCH (dispatch.job_assigned), one TEAM (automation.message) -
 * with different categories and no shared dedupe key, so nothing collapsed them.
 *
 * Every other test of the retirement asserts one half of the machinery in
 * isolation with the other half mocked away. This one runs both halves for real
 * against one job assignment and counts what a technician's bell actually ends
 * up holding, because that count is the thing the retirement was for. Only
 * `filterRecipientsByAccess` is stubbed (the emit.test.ts precedent) - the row
 * scope is not what is under test, and stubbing it PASSES recipients through, so
 * it can only ever mask a missing notification, never an extra one.
 *
 * The fixture is the likeliest legacy shape rather than a convenient one: a
 * TECH_ASSIGNED workflow, which is the trigger `tech-assignment-alert` (one of
 * the five gallery templates that minted these steps) installs.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { advanceEnrollment, RETIRED_IN_APP_STEP_DETAIL } from '../enrollment';
import { emit } from '../../notifications/notificationService';

// Row-scope access is not what this test is about, and a pass-through stub cannot
// manufacture the extra notification the assertion is hunting for.
vi.mock('../../notifications/filterByAccess', () => ({
  filterRecipientsByAccess: vi.fn((_t: string, _i: string, ids: string[]) => Promise.resolve(ids)),
}));

const mockPrisma = prisma as any;

const ORG = '00000000-0000-0000-0000-000000000001';
const JOB_ID = 'b0000000-0000-0000-0000-000000000001';
const WF_ID = 'f0000000-0000-0000-0000-000000000001';
const VER_ID = 'a0000000-0000-0000-0000-000000000002';
const ENR_ID = 'e0000000-0000-0000-0000-000000000003';
const TECH_ID = 'tech-1';
const DISPATCHER_ID = 'disp-1';
const NOW = new Date('2026-07-14T15:00:00.000Z'); // 11:00 America/New_York - inside business hours

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
      assignees: [{ user: { id: TECH_ID, email: 'mike@org.com', first_name: 'Mike', last_name: 'Torres' } }],
    },
  ],
};

/** A version PUBLISHED before the retirement: its step list is frozen JSON, so it carries
 *  the retired step for ever. `assigned_techs` is the config the gallery template shipped. */
const LEGACY_DEFINITION = {
  trigger_type: 'TECH_ASSIGNED',
  trigger_config: null,
  send_window: 'ANYTIME',
  steps: [{ position: 0, step_type: 'NOTIFY_TEAM', config: { recipient: 'assigned_techs', body: 'New job for you' } }],
};

const ENROLLMENT_ROW = {
  id: ENR_ID,
  workflow_id: WF_ID,
  workflow_version_id: VER_ID,
  status: 'ACTIVE',
  entity_type: 'job',
  entity_id: JOB_ID,
  entity_label: 'J00042',
  occurrence_key: TECH_ID, // this enrollment is FOR the technician who was just added
  dedupe_key: `TECH_ASSIGNED:${JOB_ID}:${TECH_ID}`,
  step_cursor: 0,
  resume_at: NOW,
  organization_id: ORG,
  // The dispatcher assigned the job, so Rule 0 drops the dispatcher and not the tech -
  // the tech is a genuine candidate for the legacy step's audience.
  event_payload: { actorId: DISPATCHER_ID },
  workflow: {
    id: WF_ID,
    name: 'Tech assignment alert',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TECH_ASSIGNED',
    published_version_id: VER_ID,
    organization_id: ORG,
  },
  version: { definition: LEGACY_DEFINITION },
};

/** Exactly what job.controller's assign() hook emits when a technician is added. */
function hardcodedAssignmentEmit() {
  return emit({
    verb: 'dispatch.job_assigned',
    organizationId: ORG,
    actorId: DISPATCHER_ID,
    object: { type: 'JOB', id: JOB_ID, label: 'J00042' },
    entity: { assignee_ids: [TECH_ID] },
    data: { customer_name: 'Sarah Mitchell' },
  });
}

/** Every recipient row written for a given user, across every notification created. */
function recipientRowsFor(userId: string) {
  return (mockPrisma.notificationRecipient.createMany.mock.calls as any[][])
    .flatMap((call) => call[0].data as any[])
    .filter((row) => row.recipient_id === userId);
}

/** The verb of every Notification event row written during the test. */
function createdVerbs(): string[] {
  return (mockPrisma.notification.create.mock.calls as any[][]).map((call) => call[0].data.verb);
}

beforeEach(() => {
  vi.clearAllMocks();

  mockPrisma.workflowEnrollment = {
    findUnique: vi.fn().mockResolvedValue(ENROLLMENT_ROW),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }), // cursor CAS succeeds
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.workflow = { findMany: vi.fn().mockResolvedValue([]), update: vi.fn().mockResolvedValue({}) };
  mockPrisma.automationRun = mockPrisma.automationRun ?? {};
  mockPrisma.automationRun.findUnique = vi.fn().mockResolvedValue(null);

  mockPrisma.organization.findUnique.mockResolvedValue({
    name: 'Blue Ridge Plumbing',
    phone: '(555) 204-7788',
    timezone: 'America/New_York',
    currency: 'USD',
    logo_url: null,
    brand_color: '#0C2D3A',
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: null,
  });
  mockPrisma.job.findFirst.mockResolvedValue(JOB_ROW);

  // The notification pipeline's own reads.
  mockPrisma.notification.findFirst.mockResolvedValue(undefined); // no dedupe hit
  mockPrisma.notification.create.mockImplementation((args: any) =>
    Promise.resolve({ id: `n-${args.data.verb}` }),
  );
  mockPrisma.user.findMany.mockResolvedValue([
    { id: TECH_ID, role: 'TECHNICIAN' },
    { id: DISPATCHER_ID, role: 'DISPATCHER' },
  ]);
});

describe('one job assignment with a legacy in-app step', () => {
  it('leaves the technician with exactly one notification - the hardcoded one', async () => {
    await hardcodedAssignmentEmit();
    await advanceEnrollment(ENR_ID, NOW);

    // The count that is the whole point: one assignment, one bell row.
    const techRows = recipientRowsFor(TECH_ID);
    expect(techRows).toHaveLength(1);
    expect(techRows[0]).toMatchObject({ priority: 'INTERRUPT' });

    // ...and it is the hardcoded one. Before the retirement the engine added a
    // second, automation.message at INTERRUPT, in a different category.
    expect(createdVerbs()).toEqual(['dispatch.job_assigned']);
  });

  it('runs the legacy step for real and records it as skipped rather than skipping the fixture', async () => {
    // Guards the test above from passing because nothing happened: the enrollment
    // must genuinely reach the retired step, claim it, and report the retirement.
    await hardcodedAssignmentEmit();
    await advanceEnrollment(ENR_ID, NOW);

    expect(mockPrisma.workflowStepRun.create).toHaveBeenCalledTimes(1);
    expect(mockPrisma.workflowStepRun.update.mock.calls[0][0].data).toMatchObject({
      status: 'SKIPPED',
      detail: RETIRED_IN_APP_STEP_DETAIL,
    });
    expect(mockPrisma.workflowEnrollment.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });

  it('emits nothing at all from the workflow run, even with the technician on the crew', async () => {
    await advanceEnrollment(ENR_ID, NOW); // the run alone, no hardcoded emit
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });
});
