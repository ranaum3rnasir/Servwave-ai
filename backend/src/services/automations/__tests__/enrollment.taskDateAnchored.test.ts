/**
 * enrollment.taskDateAnchored.test.ts - Spec B slice 5's enrollment wiring.
 *
 * enrollment.ts keeps a HAND-WRITTEN set, DATE_ANCHORED_TRIGGER_TYPES, that decides whether
 * `direction` and `anchor` are read off the PINNED workflow definition at all. A trigger
 * missing from that set does not throw and nothing goes red: both values arrive at
 * terminalStaleReason as `undefined`, which that function documents as failing OPEN for the
 * already-passed checks. The task staleness rules that would make this observable through a
 * STOPPED enrollment are the NEXT slice's, so the seam itself is asserted here - it is the
 * only thing that can see the omission today, and by the time it is observable the wiring
 * mistake would present as a task reminder behaving as though no direction were configured.
 *
 * The pinned-definition half matters just as much: drafts stay editable while published, so
 * judging an in-flight enrollment by an edited workflow's direction would flip an overdue
 * chase into a before-reminder mid-run.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';

vi.mock('../executors', () => ({
  executeAction: vi.fn().mockResolvedValue({ status: 'SENT', recipientSummary: 'ann@org.com', detail: 'ok' }),
}));
vi.mock('../terminalStale', () => ({ terminalStaleReason: vi.fn().mockReturnValue(null) }));

import { advanceEnrollment } from '../enrollment';
import { terminalStaleReason } from '../terminalStale';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockStale = terminalStaleReason as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const TASK_ID = 'aa000000-0000-0000-0000-0000000000e1';
const WF_ID = 'f0000000-0000-0000-0000-0000000000e1';
const VER_ID = 'a0000000-0000-0000-0000-0000000000e2';
const ENR_ID = 'e0000000-0000-0000-0000-0000000000e3';
const NOW = new Date('2026-08-28T15:00:00.000Z');
const DUE_AT = new Date('2026-09-04T02:30:00.000Z');

const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee' };

const ORG_ROW = {
  name: 'Blue Ridge Plumbing',
  phone: '(555) 204-7788',
  timezone: 'America/New_York',
  currency: 'USD',
  logo_url: null,
  brand_color: '#0C2D3A',
  plan: 'PRO',
  trial_ends_at: null,
  feature_overrides: null,
};

function definition(direction: 'before' | 'after') {
  return {
    trigger_type: 'TASK_DATE_ANCHORED',
    trigger_config: { anchor: 'task.due_at', direction, offset_minutes: 1440 },
    send_window: 'ANYTIME',
    steps: [
      {
        position: 0,
        step_type: 'SEND_EMAIL',
        config: { recipients: ['assignees'], subject: 'Due soon', body: 'Due {{task.due_date}}.' },
      },
    ],
  };
}

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENR_ID,
    workflow_id: WF_ID,
    workflow_version_id: VER_ID,
    status: 'ACTIVE',
    entity_type: 'task',
    entity_id: TASK_ID,
    entity_label: 'Order the replacement thermostat',
    occurrence_key: DUE_AT.toISOString(),
    dedupe_key: `TASK_DATE_ANCHORED:${TASK_ID}:${DUE_AT.toISOString()}`,
    step_cursor: 0,
    resume_at: NOW,
    organization_id: ORG,
    event_payload: null,
    workflow: {
      id: WF_ID,
      name: 'Task due reminder',
      status: 'PUBLISHED',
      is_enabled: true,
      trigger_type: 'TASK_DATE_ANCHORED',
      published_version_id: VER_ID,
      organization_id: ORG,
    },
    version: { definition: definition('before') },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockStale.mockReturnValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.task.findFirst.mockResolvedValue({
    id: TASK_ID,
    task_number: 'T00042',
    title: 'Order the replacement thermostat',
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    assignee_ids: [ANN.id],
    watcher_ids: [],
    due_at: DUE_AT,
    linked_entity_type: null,
    linked_entity_id: null,
    created_by: ANN.id,
    creator: ANN,
  });
  mockPrisma.user.findMany.mockResolvedValue([ANN]);
  mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(enrollmentRow());
  mockPrisma.workflowEnrollment.update.mockResolvedValue({});
  mockPrisma.workflowEnrollment.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
});

describe('advanceEnrollment - TASK_DATE_ANCHORED direction/anchor wiring', () => {
  it('passes the before-direction and the task anchor to the staleness check', async () => {
    await advanceEnrollment(ENR_ID, NOW);

    expect(mockStale).toHaveBeenCalled();
    const args = mockStale.mock.calls[0];
    expect(args[0]).toBe('TASK_DATE_ANCHORED');
    expect(args[1]).toBe(DUE_AT.toISOString());
    expect(args[4]).toBe('before');
    expect(args[5]).toBe('task.due_at');
  });

  it('passes the after-direction for the overdue chase, from the same trigger', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({ version: { definition: definition('after') } }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockStale.mock.calls[0][4]).toBe('after');
    expect(mockStale.mock.calls[0][5]).toBe('task.due_at');
  });

  /**
   * The PINNED definition governs, not the live workflow row. A published workflow's draft
   * stays editable, so reading the direction off the live row would let an admin flip an
   * in-flight overdue chase into a before-reminder halfway through its own run.
   */
  it('reads the direction off the PINNED definition, not an edited live workflow row', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        version: { definition: definition('after') },
        workflow: {
          ...enrollmentRow().workflow,
          // Edited since this enrollment was created.
          trigger_type: 'TASK_CREATED',
        },
      }),
    );

    await advanceEnrollment(ENR_ID, NOW);

    expect(mockStale.mock.calls[0][0]).toBe('TASK_DATE_ANCHORED');
    expect(mockStale.mock.calls[0][4]).toBe('after');
  });
});
