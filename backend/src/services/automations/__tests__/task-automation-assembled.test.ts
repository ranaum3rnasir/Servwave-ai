/**
 * task-automation-assembled.test.ts - Spec B's assembled path, from the first delivering
 * slice and growing with each later trigger.
 *
 * Everything between the dispatch site and the outbox runs for real here: enrollOnEvent,
 * createEnrollment's entitlement gate, advanceEnrollment, the task entity load, the audience
 * resolver, merge-field rendering and the email executor. Only prisma and the mail transport
 * are mocked.
 *
 * It exists because this spec's sharpest failure modes are invisible at the unit seams and
 * only appear assembled: a wrong audience key resolves to nobody, a merge field renders
 * empty, the acting user survives into the recipient list. Each of those passes a
 * module-level test and fails an admin.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { prisma } from '../../../lib/prisma';
import { sendAutomationEmail } from '../../../lib/email';
import { advanceEnrollment, createEnrollment, enrollOnEvent } from '../enrollment';
import { anchorWindow, candidatesForAnchor } from '../dateAnchorSweep';
import { DEFAULT_AUTOMATIONS } from '../defaultAutomations';
import { buildDefinition } from '../seedDefaultAutomations';
import { TASK_TRANSITIONS, taskTransitionEvent } from '../taskTransitions';

vi.mock('../../notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const mockSendEmail = sendAutomationEmail as ReturnType<typeof vi.fn>;

const ORG = '00000000-0000-0000-0000-000000000001';
const TASK_ID = 'aa000000-0000-0000-0000-0000000000d1';
const WF_ID = 'f0000000-0000-0000-0000-0000000000d1';
const VER_ID = 'a0000000-0000-0000-0000-0000000000d2';
const ENR_ID = 'e0000000-0000-0000-0000-0000000000d3';
// Spec B slice 2: the second workflow, on the second task trigger.
const WF_ASSIGNED_ID = 'f0000000-0000-0000-0000-0000000000d4';
const VER_ASSIGNED_ID = 'a0000000-0000-0000-0000-0000000000d5';
// Spec B slice 3: the third.
const WF_COMMENT_ID = 'f0000000-0000-0000-0000-0000000000d6';
const VER_COMMENT_ID = 'a0000000-0000-0000-0000-0000000000d7';
// Spec B slice 4: the fourth, and the only one whose entity is gone before it runs.
const WF_DELETED_ID = 'f0000000-0000-0000-0000-0000000000d8';
const VER_DELETED_ID = 'a0000000-0000-0000-0000-0000000000d9';
// Spec B slice 5: the fifth, and the only one the POLLER enrolls rather than an event.
const WF_DUE_ID = 'f0000000-0000-0000-0000-0000000000da';
const VER_DUE_ID = 'a0000000-0000-0000-0000-0000000000db';
// Slice 14 (visits-and-task-categories): "Task is done".
const WF_DONE_ID = 'f0000000-0000-0000-0000-0000000000dc';
const VER_DONE_ID = 'a0000000-0000-0000-0000-0000000000dd';
// Slice 15 (visits-and-task-categories): "Task is cancelled".
const WF_CANCELLED_ID = 'f0000000-0000-0000-0000-0000000000de';
const VER_CANCELLED_ID = 'a0000000-0000-0000-0000-0000000000df';
const NOTE_ID = 'bb000000-0000-0000-0000-0000000000c1';
const SECOND_NOTE_ID = 'bb000000-0000-0000-0000-0000000000c2';
const NOW = new Date('2026-08-28T15:00:00.000Z'); // 11:00 America/New_York

const CREATOR = { id: 'u9', email: 'dee@org.com', first_name: 'Dee', last_name: 'Fox', phone: '+15550000009' };
const ANN = { id: 'u1', email: 'ann@org.com', first_name: 'Ann', last_name: 'Lee', phone: '+15550000001' };
const BOB = { id: 'u2', email: 'bob@org.com', first_name: 'Bob', last_name: 'Ray', phone: '+15550000002' };
const CAT = { id: 'u3', email: 'cat@org.com', first_name: 'Cat', last_name: 'Diaz', phone: '+15550000003' };

const TITLE = 'Order the replacement thermostat';
const DUE_AT = new Date('2026-09-04T02:30:00.000Z'); // 22:30 Sep 3, America/New_York

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

const BODY = [
  'Task {{task.number}}: {{task.title}}',
  'Due {{task.due_date}} · {{task.status}} · {{task.priority}}',
  'On it: {{task.assignee_names}}',
  'Attached to {{task.linked_record}}',
  'Open it: {{task.link}}',
].join('\n');

const emailStep = (recipients: string[] = ['assignees']) => ({
  position: 0,
  step_type: 'SEND_EMAIL',
  config: { recipients, subject: 'New task: {{task.title}}', body: BODY },
});

function definition(recipients?: string[]) {
  return {
    trigger_type: 'TASK_CREATED',
    trigger_config: null,
    send_window: 'ANYTIME',
    steps: [emailStep(recipients)],
  };
}

function workflowRow() {
  return {
    id: WF_ID,
    name: 'Tell the assignees',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_CREATED',
    published_version_id: VER_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/**
 * Spec B slice 2. Addressed to `assigned_user`, which is the whole point: it resolves the
 * person the EVENT carried, not the live roster. Built on `assignees` this same workflow
 * would re-email everyone already on the task on every addition.
 */
function assignedDefinition(recipients: string[] = ['assigned_user']) {
  return {
    trigger_type: 'TASK_ASSIGNED',
    trigger_config: null,
    send_window: 'ANYTIME',
    steps: [{ position: 0, step_type: 'SEND_EMAIL', config: { recipients, subject: 'You were added to {{task.title}}', body: BODY } }],
  };
}

function assignedWorkflowRow() {
  return {
    id: WF_ASSIGNED_ID,
    name: 'Tell the person just added',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_ASSIGNED',
    published_version_id: VER_ASSIGNED_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/**
 * Both published workflows, keyed by the id createEnrollment writes onto the row, so the
 * enrollment fakes below can hand advanceEnrollment the RIGHT definition. Two enabled task
 * workflows in one org is the shipping configuration - both defaults seed enabled - and a
 * mock that served one definition to both triggers would hide the very double-send this
 * slice's mutual exclusion exists to prevent.
 */
/**
 * Spec B slice 3. Addressed to the LIVE roster plus the watchers, which is the right
 * audience for a comment - it is about the task, not about one person - and the opposite
 * of the assigned workflow above.
 */
function commentDefinition(steps?: unknown[]) {
  return {
    trigger_type: 'TASK_COMMENT_ADDED',
    trigger_config: null,
    send_window: 'ANYTIME',
    steps: steps ?? [{
      position: 0,
      step_type: 'SEND_EMAIL',
      config: { recipients: ['assignees', 'watchers'], subject: 'New comment on {{task.title}}', body: BODY },
    }],
  };
}

function commentWorkflowRow() {
  return {
    id: WF_COMMENT_ID,
    name: 'Tell the people on the task',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_COMMENT_ADDED',
    published_version_id: VER_COMMENT_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/**
 * Spec B slice 4. The ONLY body in this file that is not BODY, and deliberately so: a deleted
 * task can honestly answer for its number and its title and nothing else, so the catalogue
 * offers exactly those two and the validator refuses the rest at save. A workflow built on
 * BODY could not be published against this trigger.
 */
const DELETED_BODY = [
  'Task {{task.number}}: {{task.title}} has been deleted.',
  'Nothing more to do here.',
].join('\n');

function deletedDefinition(steps?: unknown[]) {
  return {
    trigger_type: 'TASK_DELETED',
    trigger_config: null,
    send_window: 'ANYTIME',
    steps: steps ?? [{
      position: 0,
      step_type: 'SEND_EMAIL',
      config: { recipients: ['assignees', 'watchers'], subject: 'Cancelled: {{task.title}}', body: DELETED_BODY },
    }],
  };
}

function deletedWorkflowRow() {
  return {
    id: WF_DELETED_ID,
    name: 'Tell the people who were on it',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_DELETED',
    published_version_id: VER_DELETED_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/**
 * Spec B slice 5. The one task workflow with a trigger_config: its timing is
 * {anchor, direction, offset_minutes}, and the poller's sweep - not a dispatch site - decides
 * when it enrolls. `before` is the reminder, `after` is the overdue chase, from ONE trigger.
 */
function dueDefinition(direction: 'before' | 'after' = 'before', recipients: string[] = ['assignees']) {
  return {
    trigger_type: 'TASK_DATE_ANCHORED',
    trigger_config: { anchor: 'task.due_at', direction, offset_minutes: 24 * 60 },
    send_window: 'ANYTIME',
    steps: [{
      position: 0,
      step_type: 'SEND_EMAIL',
      config: { recipients, subject: 'Due soon: {{task.title}}', body: BODY },
    }],
  };
}

function dueWorkflowRow() {
  return {
    id: WF_DUE_ID,
    name: 'Remind the assignees before it is due',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_DATE_ANCHORED',
    published_version_id: VER_DUE_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/**
 * Slice 14. Addressed to everyone who might be waiting on the work - the assignees, the watchers
 * and the creator - which is exactly the audience that makes Rule 0 visible: the person who
 * marked it done is on the task and must still not be told.
 */
const DONE_BODY = [
  'Task {{task.number}}: {{task.title}}',
  'Finished by {{task.completed_by}} on {{task.completed_at}}',
  'Attached to {{task.linked_record}}',
].join('\n');

function doneDefinition(steps?: unknown[]) {
  return {
    trigger_type: 'TASK_COMPLETED',
    trigger_config: null,
    send_window: 'ANYTIME',
    steps: steps ?? [{
      position: 0,
      step_type: 'SEND_EMAIL',
      config: { recipients: ['assignees', 'watchers', 'creator'], subject: 'Done: {{task.title}}', body: DONE_BODY },
    }],
  };
}

function doneWorkflowRow() {
  return {
    id: WF_DONE_ID,
    name: 'Tell everyone the task is done',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_COMPLETED',
    published_version_id: VER_DONE_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

/** Slice 15. The same audience as "Task is done", for the same reason: it makes Rule 0 visible. */
const CANCELLED_BODY = [
  'Task {{task.number}}: {{task.title}}',
  'Cancelled by {{task.cancelled_by}} on {{task.cancelled_at}}',
  'Attached to {{task.linked_record}}',
].join('\n');

function cancelledDefinition(steps?: unknown[]) {
  return {
    trigger_type: 'TASK_CANCELLED',
    trigger_config: null,
    send_window: 'ANYTIME',
    steps: steps ?? [{
      position: 0,
      step_type: 'SEND_EMAIL',
      config: { recipients: ['assignees', 'watchers', 'creator'], subject: 'Cancelled: {{task.title}}', body: CANCELLED_BODY },
    }],
  };
}

function cancelledWorkflowRow() {
  return {
    id: WF_CANCELLED_ID,
    name: 'Tell everyone the task is off',
    status: 'PUBLISHED',
    is_enabled: true,
    trigger_type: 'TASK_CANCELLED',
    published_version_id: VER_CANCELLED_ID,
    organization_id: ORG,
    legacy_rule_id: null,
  };
}

const PUBLISHED = [
  { row: workflowRow(), definition: definition() },
  { row: doneWorkflowRow(), definition: doneDefinition() },
  { row: cancelledWorkflowRow(), definition: cancelledDefinition() },
  { row: assignedWorkflowRow(), definition: assignedDefinition() },
  { row: commentWorkflowRow(), definition: commentDefinition() },
  { row: deletedWorkflowRow(), definition: deletedDefinition() },
  { row: dueWorkflowRow(), definition: dueDefinition() },
];

/**
 * Exactly what cron.ts's scanDateAnchorTriggers does for ONE workflow: read the pinned
 * anchor/direction/offset off its trigger_config, compute the window, sweep for candidates,
 * and enroll each one - then let the same tick advance it, as `resume_at = now` makes it do.
 *
 * Reproduced here rather than calling runAutomationTick because the tick's other three phases
 * would need their own prisma fakes and would tell us nothing about a task reminder. The
 * where-clause that decides task workflows are SELECTED at all is pinned in cron.test.ts,
 * which is the assertion a mocked prisma cannot make from this side.
 */
async function sweepAndRun(definitionOverride?: ReturnType<typeof dueDefinition>): Promise<void> {
  const def = definitionOverride ?? dueDefinition();
  // The enrollment fake replays the PUBLISHED entry's definition back to advanceEnrollment, so
  // an overridden definition has to be the published one - a workflow cannot run against a
  // version other than the one its enrollment pins.
  PUBLISHED.find((w) => w.row.id === WF_DUE_ID)!.definition = def;
  const cfg = def.trigger_config;
  const window = anchorWindow(cfg.direction as 'before' | 'after', cfg.offset_minutes * 60_000, NOW);
  const candidates = await candidatesForAnchor('task.due_at', ORG, window);
  for (const candidate of candidates) {
    const created = await createEnrollment({
      workflow: {
        id: WF_DUE_ID,
        published_version_id: VER_DUE_ID,
        trigger_type: 'TASK_DATE_ANCHORED',
        organization_id: ORG,
        legacy_rule_id: null,
      },
      entity: { type: candidate.entityType, id: candidate.entityId, label: candidate.entityLabel },
      occurrenceKey: candidate.occurrence,
      now: NOW,
    });
    if (created) await advanceEnrollment(created.id, NOW);
  }
}

function enrollmentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ENR_ID,
    workflow_id: WF_ID,
    workflow_version_id: VER_ID,
    status: 'ACTIVE',
    entity_type: 'task',
    entity_id: TASK_ID,
    entity_label: TITLE,
    occurrence_key: null,
    dedupe_key: `TASK_CREATED:${TASK_ID}`,
    step_cursor: 0,
    resume_at: NOW,
    organization_id: ORG,
    // What the dispatch site handed enrollOnEvent, persisted: Rule 0's actor.
    event_payload: { actorId: CREATOR.id },
    workflow: workflowRow(),
    version: { definition: definition() },
    ...overrides,
  };
}

function taskRow(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    task_number: 'T00042',
    title: TITLE,
    status: 'IN_PROGRESS',
    priority: 'HIGH',
    // The creator is ALSO an assignee - the case story 14 is about.
    assignee_ids: [CREATOR.id, ANN.id, BOB.id],
    watcher_ids: [CAT.id],
    due_at: DUE_AT,
    linked_entity_type: 'JOB',
    linked_entity_id: 'bb000000-0000-0000-0000-000000000001',
    created_by: CREATOR.id,
    creator: CREATOR,
    ...overrides,
  };
}

const createdTask = () => ({
  type: 'TASK_CREATED' as const,
  organizationId: ORG,
  entity: { type: 'task' as const, id: TASK_ID, label: TITLE },
  actorId: CREATOR.id,
});

/** Exactly what task.controller.ts's addComment handler dispatches for one comment. */
const commentedTask = (noteId: string, commenterId: string = BOB.id) => ({
  type: 'TASK_COMMENT_ADDED' as const,
  organizationId: ORG,
  entity: { type: 'task' as const, id: TASK_ID, label: TITLE },
  // The note id, not the task id. Keyed on the task alone, only the FIRST comment on any
  // task would ever notify - for the life of that task, with nothing in the logs.
  occurrenceKey: noteId,
  actorId: commenterId,
});

/**
 * Exactly what task.controller.ts's remove handler dispatches - the whole event, because after
 * the transaction there is no row left for anything else to be read from.
 */
const deletedTask = (assigneeIds: string[], watcherIds: string[], actorId: string = CREATOR.id) => ({
  type: 'TASK_DELETED' as const,
  organizationId: ORG,
  entity: { type: 'task' as const, id: TASK_ID, label: TITLE },
  actorId,
  eventPayload: {
    mergeFields: { 'task.number': 'T00042', 'task.title': TITLE },
    taskSnapshot: { assigneeIds, watcherIds, creatorId: CREATOR.id },
  },
});

/** Exactly what task.controller.ts's update handler dispatches for one added person. */
const assignedTask = (added: typeof CAT) => ({
  type: 'TASK_ASSIGNED' as const,
  organizationId: ORG,
  entity: { type: 'task' as const, id: TASK_ID, label: TITLE },
  occurrenceKey: added.id,
  actorId: CREATOR.id,
  eventPayload: { recipient: added },
});

const sentTo = (): string[] =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSendEmail.mock.calls.map((c: any[]) => c[0].to).sort();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bodyFor = (address: string): string =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockSendEmail.mock.calls.find((c: any[]) => c[0].to === address)![0].text as string;

beforeEach(() => {
  vi.clearAllMocks();
  mockSendEmail.mockResolvedValue({ status: 'sent' });
  // Trigger-aware, so one org can hold BOTH published task workflows at once - which is the
  // shipping configuration, and the only setup in which a create firing both triggers would
  // actually show up as two emails.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.workflow = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findMany: vi.fn().mockImplementation(({ where }: any) =>
      Promise.resolve(PUBLISHED.filter((w) => w.row.trigger_type === where.trigger_type).map((w) => w.row))),
    update: vi.fn().mockResolvedValue({}),
  };
  // The enrollment fakes replay what createEnrollment just wrote, so advanceEnrollment reads
  // back the definition belonging to the workflow that actually enrolled.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const written = new Map<string, any>();
  mockPrisma.workflowEnrollment = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: vi.fn().mockImplementation(({ data }: any) => {
      const id = written.size === 0 ? ENR_ID : `${ENR_ID}-${written.size}`;
      written.set(id, data);
      return Promise.resolve({ id });
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    findUnique: vi.fn().mockImplementation(({ where }: any) => {
      const data = written.get(where.id);
      if (!data) return Promise.resolve(enrollmentRow());
      const wf = PUBLISHED.find((w) => w.row.id === data.workflow_id)!;
      return Promise.resolve(enrollmentRow({
        id: where.id,
        workflow_id: data.workflow_id,
        workflow_version_id: data.workflow_version_id,
        entity_label: data.entity_label,
        occurrence_key: data.occurrence_key,
        dedupe_key: data.dedupe_key,
        event_payload: data.event_payload,
        workflow: wf.row,
        version: { definition: wf.definition },
      }));
    }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.workflowStepRun = {
    create: vi.fn().mockResolvedValue({ id: 'run-1' }),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 1 }),
  };
  mockPrisma.automationRun = mockPrisma.automationRun ?? {};
  mockPrisma.automationRun.findUnique = vi.fn().mockResolvedValue(null);
  mockPrisma.organization.findUnique.mockResolvedValue(ORG_ROW);
  mockPrisma.task.findFirst.mockResolvedValue(taskRow());
  mockPrisma.user.findMany.mockResolvedValue([CREATOR, ANN, BOB, CAT]);
  mockPrisma.job.findFirst.mockResolvedValue({ job_number: 'J00042' });
});

describe('assembled: creating a task emails its assignees', () => {
  it('emails each assignee exactly once and never the creator who triggered it', async () => {
    await enrollOnEvent(createdTask(), NOW);

    expect(sentTo()).toEqual([ANN.email, BOB.email]);
    expect(sentTo()).not.toContain(CREATOR.email);
  });

  it('renders every task merge field into the body an assignee actually receives', async () => {
    await enrollOnEvent(createdTask(), NOW);

    const body = bodyFor(ANN.email);
    expect(body).toContain('T00042');
    expect(body).toContain(TITLE);
    // Org clock, not UTC: 02:30Z on Sep 4 is still Sep 3 in America/New_York.
    expect(body).toContain('Thu, Sep 3');
    expect(body).toContain('In progress');
    expect(body).toContain('High');
    expect(body).toContain('Dee Fox, Ann Lee, Bob Ray');
    expect(body).toContain('Job J00042');
    expect(body).toContain(`/tasks?task=${TASK_ID}`);
    // Nothing unresolved leaked through.
    expect(body).not.toContain('{{');
    expect(body).not.toContain('null');
  });

  // Every assignee gets their OWN email - one message each, not one message shared. The
  // bodies are identical (nothing in a rendered send varies by recipient since the per-
  // recipient name was removed on 2026-09-15), so the addressing is the whole assertion, and
  // reading the body back per address is what proves each of them really received one.
  it('sends each assignee their own copy, addressed to them', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        version: {
          definition: {
            ...definition(),
            steps: [{ position: 0, step_type: 'SEND_EMAIL', config: { recipients: ['assignees'], subject: 's', body: 'A note from {{org.name}}' } }],
          },
        },
      }),
    );

    await enrollOnEvent(createdTask(), NOW);

    expect(sentTo()).toEqual([ANN.email, BOB.email].sort());
    expect(bodyFor(ANN.email)).toBe('A note from Blue Ridge Plumbing');
    expect(bodyFor(BOB.email)).toBe('A note from Blue Ridge Plumbing');
  });

  it('reaches the watchers when the workflow is addressed to them, and only them', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({ version: { definition: definition(['watchers']) } }),
    );

    await enrollOnEvent(createdTask(), NOW);

    expect(sentTo()).toEqual([CAT.email]);
  });

  it('skips with a readable reason when nobody is watching - no error, no send to nobody', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ watcher_ids: [] }));
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({ version: { definition: definition(['watchers']) } }),
    );

    await enrollOnEvent(createdTask(), NOW);

    expect(mockSendEmail).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const outcome = mockPrisma.workflowStepRun.update.mock.calls.at(-1)![0].data as any;
    expect(outcome.status).toBe('SKIPPED');
    expect(outcome.detail).toContain('No one is watching this task');
  });

  it('drops an assignee id that no longer resolves, and still emails the rest', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, 'ghost-id'] }),
    );
    mockPrisma.user.findMany.mockResolvedValue([CREATOR, ANN, CAT]);

    await enrollOnEvent(createdTask(), NOW);

    expect(sentTo()).toEqual([ANN.email]);
  });

  it('renders a missing due date as an empty string rather than "null"', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: null }));

    await enrollOnEvent(createdTask(), NOW);

    const body = bodyFor(ANN.email);
    expect(body).toContain('Due  ·');
    expect(body).not.toContain('null');
  });

  it('writes no enrollment at all for an organization without the automations entitlement', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue({ ...ORG_ROW, plan: 'STARTER', feature_overrides: null });

    await enrollOnEvent(createdTask(), NOW);

    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
    expect(mockPrisma.workflowStepRun.create).not.toHaveBeenCalled();
    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('stops the enrollment with a readable reason when the task is already gone', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await enrollOnEvent(createdTask(), NOW);

    expect(mockSendEmail).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finish = mockPrisma.workflowEnrollment.update.mock.calls.at(-1)![0].data as any;
    expect(finish.status).toBe('STOPPED');
    expect(finish.finished_reason).toBe('The task no longer exists');
  });
});

// ── Spec B slice 2, assembled: create with two, then add a third ─────────────

describe('assembled: adding someone to an existing task emails that person, and only them', () => {
  /**
   * The acceptance criterion, end to end, in one org holding BOTH enabled task defaults.
   * Ann and Bob are put on the task at creation and hear about it once. Cat is added later
   * and is the only person the second event reaches - Ann and Bob are not told again.
   */
  it('two created-emails, then one assigned-email to one person', async () => {
    await enrollOnEvent(createdTask(), NOW);
    expect(sentTo()).toEqual([ANN.email, BOB.email]);

    mockSendEmail.mockClear();
    // The roster AFTER the addition: three people, of whom exactly one is new.
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id] }),
    );

    await enrollOnEvent(assignedTask(CAT), NOW);

    expect(sentTo()).toEqual([CAT.email]);
    expect(sentTo()).not.toContain(ANN.email);
    expect(sentTo()).not.toContain(BOB.email);
  });

  it('creating a task in an org holding BOTH defaults sends each assignee ONE email, not two', async () => {
    await enrollOnEvent(createdTask(), NOW);

    // One address each. A create that also fired TASK_ASSIGNED would land here as duplicates.
    expect(sentTo()).toEqual([ANN.email, BOB.email]);
    expect(mockSendEmail).toHaveBeenCalledTimes(2);
  });

  it('renders the task detail into the added person\'s email, addressed to them by name', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id] }),
    );

    await enrollOnEvent(assignedTask(CAT), NOW);

    const body = bodyFor(CAT.email);
    expect(body).toContain('T00042');
    expect(body).toContain(TITLE);
    expect(body).toContain('Dee Fox, Ann Lee, Bob Ray, Cat Diaz');
    expect(body).not.toContain('{{');
  });

  it('adding yourself to a task emails nobody - Rule 0 survives the trip through the payload', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id] }),
    );

    // The acting user IS the person added.
    await enrollOnEvent({ ...assignedTask(CAT), actorId: CAT.id, eventPayload: { recipient: CAT } }, NOW);

    expect(mockSendEmail).not.toHaveBeenCalled();
  });

  it('two people added in separate events produce two enrollments, not one swallowed duplicate', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id] }),
    );

    await enrollOnEvent(assignedTask(CAT), NOW);
    await enrollOnEvent(assignedTask(ANN), NOW);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keys = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data.dedupe_key);
    expect(keys).toEqual([`TASK_ASSIGNED:${TASK_ID}:${CAT.id}`, `TASK_ASSIGNED:${TASK_ID}:${ANN.id}`]);
    expect(new Set(keys).size).toBe(2);
    expect(sentTo()).toEqual([ANN.email, CAT.email].sort());
  });

  it('writes an enrollment at all - a missing occurrence would have made this silently zero', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id] }),
    );

    await enrollOnEvent(assignedTask(CAT), NOW);

    // buildDedupeKey throws without an occurrence and createEnrollment swallows the throw,
    // so the ONLY observable difference is that no row is written and no mail is sent.
    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
    expect(mockSendEmail).toHaveBeenCalledTimes(1);
  });
});

// ── Spec B slice 3, assembled: create, assign, then comment ──────────────────

describe('assembled: commenting on a task reaches the people on it', () => {
  /** The roster a comment resolves against: Ann and Bob assigned, Cat watching. */
  const onTheTask = () =>
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [ANN.id, BOB.id], watcher_ids: [CAT.id] }),
    );

  it('emails the other assignees and the watchers, and never the commenter', async () => {
    onTheTask();

    await enrollOnEvent(commentedTask(NOTE_ID), NOW);

    expect(sentTo()).toEqual([ANN.email, CAT.email].sort());
    expect(sentTo()).not.toContain(BOB.email);
  });

  it('a comment by someone NOT on the task still reaches everyone who is', async () => {
    onTheTask();

    await enrollOnEvent(commentedTask(NOTE_ID, CREATOR.id), NOW);

    expect(sentTo()).toEqual([ANN.email, BOB.email, CAT.email].sort());
  });

  /**
   * The acceptance criterion the occurrence key exists for. Without the note id on the
   * event, the second comment collides with the first on the [workflow_id, dedupe_key]
   * unique constraint and is swallowed - for the life of the task, with no error.
   */
  it('a SECOND comment enrolls again rather than being swallowed as a duplicate of the first', async () => {
    onTheTask();

    await enrollOnEvent(commentedTask(NOTE_ID), NOW);
    await enrollOnEvent(commentedTask(SECOND_NOTE_ID), NOW);

    const keys = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data.dedupe_key);
    expect(keys).toEqual([
      `TASK_COMMENT_ADDED:${TASK_ID}:${NOTE_ID}`,
      `TASK_COMMENT_ADDED:${TASK_ID}:${SECOND_NOTE_ID}`,
    ]);
    expect(new Set(keys).size).toBe(2);
    // Two comments, two rounds of mail to the same two people.
    expect(mockSendEmail).toHaveBeenCalledTimes(4);
  });

  it('writes an enrollment at all - a missing occurrence would have made this silently zero', async () => {
    onTheTask();

    await enrollOnEvent(commentedTask(NOTE_ID), NOW);

    expect(mockPrisma.workflowEnrollment.create).toHaveBeenCalledTimes(1);
  });

  /**
   * STORY 16, and the case a dispatch-time-only exclusion would fail while passing every
   * test above it: the workflow's first step is a WAIT, so the send happens a day later,
   * long after the request that carried the commenter is gone. The actor is re-read from
   * the enrollment's persisted event_payload on every step, which is why it survives.
   */
  it('still excludes the commenter when a WAIT delays the send by a day', async () => {
    onTheTask();
    const A_DAY = 24 * 60;
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        // Resuming at the send, the WAIT already behind it.
        step_cursor: 1,
        workflow_id: WF_COMMENT_ID,
        workflow_version_id: VER_COMMENT_ID,
        workflow: commentWorkflowRow(),
        version: {
          definition: commentDefinition([
            { position: 0, step_type: 'WAIT', config: { duration_minutes: A_DAY } },
            {
              position: 1,
              step_type: 'SEND_EMAIL',
              config: { recipients: ['assignees', 'watchers'], subject: 's', body: BODY },
            },
          ]),
        },
        event_payload: { actorId: BOB.id },
      }),
    );

    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + A_DAY * 60_000));

    expect(sentTo()).toEqual([ANN.email, CAT.email].sort());
    expect(sentTo()).not.toContain(BOB.email);
  });

  /**
   * The full assembled path this spec's test plan asks for: create, assign, then comment,
   * in one org holding all three enabled task workflows. Each person gets exactly the mail
   * their own moment earns them, and nobody is told about their own action.
   */
  it('create, then assign, then comment: the right people get one email each', async () => {
    // 1. Dee creates the task with Ann and Bob on it.
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id], watcher_ids: [] }),
    );
    await enrollOnEvent(createdTask(), NOW);
    expect(sentTo()).toEqual([ANN.email, BOB.email]);

    // 2. Dee adds Cat. Only Cat hears about it.
    mockSendEmail.mockClear();
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id], watcher_ids: [] }),
    );
    await enrollOnEvent(assignedTask(CAT), NOW);
    expect(sentTo()).toEqual([CAT.email]);

    // 3. Bob comments. Everyone else on the task hears about it; Bob does not.
    mockSendEmail.mockClear();
    await enrollOnEvent(commentedTask(NOTE_ID), NOW);
    expect(sentTo()).toEqual([ANN.email, CAT.email, CREATOR.email].sort());
    expect(sentTo()).not.toContain(BOB.email);
  });
});

// ── Slice 14, assembled: "Task is done" ──────────────────────────────────────

describe('assembled: marking a task done tells the people waiting on it', () => {
  const COMPLETED_AT = new Date('2026-08-28T14:55:00.000Z'); // 10:55 AM America/New_York
  const DONE = TASK_TRANSITIONS.find((t) => t.trigger === 'TASK_COMPLETED')!;

  /** Exactly what task.controller.ts's update handler dispatches when Bob marks the task done. */
  const completedTask = (at: Date = COMPLETED_AT, actor: typeof BOB = BOB) =>
    taskTransitionEvent({
      transition: DONE,
      organizationId: ORG,
      task: { id: TASK_ID, title: TITLE },
      actorId: actor.id,
      actorName: `${actor.first_name} ${actor.last_name}`,
      at,
      timeZone: ORG_ROW.timezone,
    });

  /** Dee created it, Ann and Bob are on it, Cat watches - and it is DONE by the time the run loads it. */
  const finished = (over: Record<string, unknown> = {}) =>
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'DONE', assignee_ids: [ANN.id, BOB.id], watcher_ids: [CAT.id], ...over }),
    );

  /** The (workflow_id, dedupe_key) unique constraint the real table enforces, which the default fake does not. */
  const enforceUniqueDedupe = () => {
    const seen = new Set<string>();
    const create = mockPrisma.workflowEnrollment.create.getMockImplementation()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.workflowEnrollment.create.mockImplementation((args: any) => {
      const k = `${args.data.workflow_id}|${args.data.dedupe_key}`;
      if (seen.has(k)) return Promise.reject(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
      seen.add(k);
      return create(args);
    });
  };

  const lastFinish = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.workflowEnrollment.update.mock.calls.at(-1)![0].data as any;

  it('emails the assignees, the watchers and the creator - never the person who marked it done', async () => {
    finished();

    await enrollOnEvent(completedTask(), NOW);

    expect(sentTo()).toEqual([ANN.email, CAT.email, CREATOR.email].sort());
    expect(sentTo()).not.toContain(BOB.email);
  });

  it('drops the actor even when they are the creator - Rule 0 beats every audience', async () => {
    finished({ assignee_ids: [CREATOR.id, ANN.id] , watcher_ids: [] });

    await enrollOnEvent(completedTask(COMPLETED_AT, CREATOR), NOW);

    expect(sentTo()).toEqual([ANN.email]);
  });

  /**
   * THE TRAP. The finished-task floor stops a task run once the task is DONE or CANCELLED - and a
   * "Task is done" run is created precisely when the task is DONE. Without the exemption this run
   * finishes STOPPED with "The task was completed" on its first step and nothing is ever sent.
   */
  it('is NOT stopped by the finished-task floor - the run completes and actually sends', async () => {
    finished();

    await enrollOnEvent(completedTask(), NOW);

    expect(mockSendEmail).toHaveBeenCalled();
    expect(lastFinish().status).toBe('COMPLETED');
    expect(lastFinish().finished_reason).not.toBe('The task was completed');
  });

  it('still sends when a WAIT puts a day between the finish and the send', async () => {
    finished();
    const A_DAY = 24 * 60;
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        step_cursor: 1,
        workflow_id: WF_DONE_ID,
        workflow_version_id: VER_DONE_ID,
        occurrence_key: COMPLETED_AT.toISOString(),
        dedupe_key: `TASK_COMPLETED:${TASK_ID}:${COMPLETED_AT.toISOString()}`,
        workflow: doneWorkflowRow(),
        version: {
          definition: doneDefinition([
            { position: 0, step_type: 'WAIT', config: { duration_minutes: A_DAY } },
            { position: 1, step_type: 'SEND_EMAIL', config: { recipients: ['assignees', 'watchers'], subject: 's', body: DONE_BODY } },
          ]),
        },
        event_payload: { actorId: BOB.id, ...completedTask().eventPayload },
      }),
    );

    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + A_DAY * 60_000));

    expect(sentTo()).toEqual([ANN.email, CAT.email].sort());
    expect(bodyFor(ANN.email)).toContain('Finished by Bob Ray');
  });

  it('renders who finished it, when (org clock), and the linked record into the message', async () => {
    finished();

    await enrollOnEvent(completedTask(), NOW);

    const body = bodyFor(ANN.email);
    expect(body).toContain(`Task T00042: ${TITLE}`);
    expect(body).toContain('Finished by Bob Ray on August 28, 2026 at 10:55 AM');
    expect(body).toContain('Attached to Job J00042');
    expect(body).not.toContain('{{');
  });

  /**
   * THE SECOND TRAP. Done, reopened, done again: two finishes, two notices. The real table's
   * (workflow_id, dedupe_key) unique is enforced here, so a key built on the task alone would
   * collide and the second finish would be swallowed - silently, for the life of the task.
   */
  it('a second finish after a reopen enrolls and sends again rather than being swallowed', async () => {
    enforceUniqueDedupe();
    finished();

    await enrollOnEvent(completedTask(COMPLETED_AT), NOW);
    await enrollOnEvent(completedTask(new Date(COMPLETED_AT.getTime() + 3 * 60 * 60 * 1000)), NOW);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keys = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data.dedupe_key);
    expect(new Set(keys).size).toBe(2);
    // Two finishes, two rounds of mail to the same three people.
    expect(mockSendEmail).toHaveBeenCalledTimes(6);
  });

  it('the SAME finish dispatched twice is still one notice - the key is the occurrence, not the call', async () => {
    enforceUniqueDedupe();
    finished();

    await enrollOnEvent(completedTask(), NOW);
    await enrollOnEvent(completedTask(), NOW);

    expect(mockSendEmail).toHaveBeenCalledTimes(3);
  });

  it('other task triggers are still stopped by the floor on a finished task', async () => {
    finished();

    await enrollOnEvent(commentedTask(NOTE_ID), NOW);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: 'STOPPED', finished_reason: 'The task was completed' });
  });
});

// ── Slice 15, assembled: "Task is cancelled" ─────────────────────────────────

describe('assembled: cancelling a task tells the people waiting on it', () => {
  const CANCELLED_AT = new Date('2026-08-28T14:55:00.000Z'); // 10:55 AM America/New_York
  const CANCEL = TASK_TRANSITIONS.find((t) => t.trigger === 'TASK_CANCELLED')!;

  /** Exactly what task.controller.ts's update handler dispatches when Bob cancels the task. */
  const cancelledTask = (at: Date = CANCELLED_AT, actor: typeof BOB = BOB) =>
    taskTransitionEvent({
      transition: CANCEL,
      organizationId: ORG,
      task: { id: TASK_ID, title: TITLE },
      actorId: actor.id,
      actorName: `${actor.first_name} ${actor.last_name}`,
      at,
      timeZone: ORG_ROW.timezone,
    });

  /** Dee created it, Ann and Bob are on it, Cat watches - and it is CANCELLED by the time the run loads it. */
  const cancelled = (over: Record<string, unknown> = {}) =>
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'CANCELLED', completed_at: null, assignee_ids: [ANN.id, BOB.id], watcher_ids: [CAT.id], ...over }),
    );

  /** The (workflow_id, dedupe_key) unique constraint the real table enforces, which the default fake does not. */
  const enforceUniqueDedupe = () => {
    const seen = new Set<string>();
    const create = mockPrisma.workflowEnrollment.create.getMockImplementation()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.workflowEnrollment.create.mockImplementation((args: any) => {
      const k = `${args.data.workflow_id}|${args.data.dedupe_key}`;
      if (seen.has(k)) return Promise.reject(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));
      seen.add(k);
      return create(args);
    });
  };

  const lastFinish = () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.workflowEnrollment.update.mock.calls.at(-1)![0].data as any;

  it('emails the assignees, the watchers and the creator - never the person who cancelled it', async () => {
    cancelled();

    await enrollOnEvent(cancelledTask(), NOW);

    expect(sentTo()).toEqual([ANN.email, CAT.email, CREATOR.email].sort());
    expect(sentTo()).not.toContain(BOB.email);
  });

  it('drops the actor even when they are the creator - Rule 0 beats every audience', async () => {
    cancelled({ assignee_ids: [CREATOR.id, ANN.id], watcher_ids: [] });

    await enrollOnEvent(cancelledTask(CANCELLED_AT, CREATOR), NOW);

    expect(sentTo()).toEqual([ANN.email]);
  });

  /**
   * The floor stops a task run once the task is CANCELLED - and a "Task is cancelled" run is
   * created precisely when it is. Exempt, the run completes and sends.
   */
  it('is NOT stopped by the finished-task floor - the run completes and actually sends', async () => {
    cancelled();

    await enrollOnEvent(cancelledTask(), NOW);

    expect(mockSendEmail).toHaveBeenCalled();
    expect(lastFinish().status).toBe('COMPLETED');
    expect(lastFinish().finished_reason).not.toBe('The task was cancelled');
  });

  it('still sends when a WAIT puts a day between the cancel and the send', async () => {
    cancelled();
    const A_DAY = 24 * 60;
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        step_cursor: 1,
        workflow_id: WF_CANCELLED_ID,
        workflow_version_id: VER_CANCELLED_ID,
        occurrence_key: CANCELLED_AT.toISOString(),
        dedupe_key: `TASK_CANCELLED:${TASK_ID}:${CANCELLED_AT.toISOString()}`,
        workflow: cancelledWorkflowRow(),
        version: {
          definition: cancelledDefinition([
            { position: 0, step_type: 'WAIT', config: { duration_minutes: A_DAY } },
            { position: 1, step_type: 'SEND_EMAIL', config: { recipients: ['assignees', 'watchers'], subject: 's', body: CANCELLED_BODY } },
          ]),
        },
        event_payload: { actorId: BOB.id, ...cancelledTask().eventPayload },
      }),
    );

    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + A_DAY * 60_000));

    expect(sentTo()).toEqual([ANN.email, CAT.email].sort());
    expect(bodyFor(ANN.email)).toContain('Cancelled by Bob Ray');
  });

  it('renders who cancelled it, when (org clock), and the linked record into the message', async () => {
    cancelled();

    await enrollOnEvent(cancelledTask(), NOW);

    const body = bodyFor(ANN.email);
    expect(body).toContain(`Task T00042: ${TITLE}`);
    expect(body).toContain('Cancelled by Bob Ray on August 28, 2026 at 10:55 AM');
    expect(body).toContain('Attached to Job J00042');
    expect(body).not.toContain('{{');
  });

  /** Cancelled, reopened, cancelled again: two cancels, two notices - with the real unique enforced. */
  it('a second cancel after a reopen enrolls and sends again rather than being swallowed', async () => {
    enforceUniqueDedupe();
    cancelled();

    await enrollOnEvent(cancelledTask(CANCELLED_AT), NOW);
    await enrollOnEvent(cancelledTask(new Date(CANCELLED_AT.getTime() + 3 * 60 * 60 * 1000)), NOW);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keys = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data.dedupe_key);
    expect(new Set(keys).size).toBe(2);
    expect(mockSendEmail).toHaveBeenCalledTimes(6);
  });

  it('the SAME cancel dispatched twice is still one notice - the key is the occurrence, not the call', async () => {
    enforceUniqueDedupe();
    cancelled();

    await enrollOnEvent(cancelledTask(), NOW);
    await enrollOnEvent(cancelledTask(), NOW);

    expect(mockSendEmail).toHaveBeenCalledTimes(3);
  });

  it('other task triggers are still stopped by the floor on a cancelled task', async () => {
    cancelled();

    await enrollOnEvent(commentedTask(NOTE_ID), NOW);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(lastFinish()).toMatchObject({ status: 'STOPPED', finished_reason: 'The task was cancelled' });
  });
});

// ── Spec B slice 4, assembled: the task is destroyed and the mail still lands ─

/**
 * The leg the spec's stated mechanism could NOT have delivered. Task deletion is a hard delete,
 * so `task.findFirst` returns null for the whole life of this enrollment - and until this slice
 * that killed the run on its first step, before any send, with "The task no longer exists".
 * Everything below is resolved from the enrollment's persisted event_payload.
 */
describe('assembled: a deleted task can still say which task it was', () => {
  /** The roster the delete handler snapshotted: Ann and Bob assigned, Cat watching. */
  const wereOnTheTask = () => deletedTask([ANN.id, BOB.id], [CAT.id]);

  beforeEach(() => {
    // The row is GONE, for good, on every step. Nothing below may depend on reading it.
    mockPrisma.task.findFirst.mockResolvedValue(null);
  });

  it('emails the former assignees and watchers, and never the person who deleted it', async () => {
    await enrollOnEvent(wereOnTheTask(), NOW);

    expect(sentTo()).toEqual([ANN.email, BOB.email, CAT.email].sort());
    expect(sentTo()).not.toContain(CREATOR.email);
  });

  it('names the task by number and title in the body each of them receives', async () => {
    await enrollOnEvent(wereOnTheTask(), NOW);

    const body = bodyFor(ANN.email);
    expect(body).toContain('T00042');
    expect(body).toContain(TITLE);
    expect(body).toContain('Nothing more to do here.');
    expect(body).not.toContain('{{');
    expect(body).not.toContain('null');
  });

  it('COMPLETES the run rather than stopping with "no longer exists"', async () => {
    await enrollOnEvent(wereOnTheTask(), NOW);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finish = mockPrisma.workflowEnrollment.update.mock.calls.at(-1)![0].data as any;
    expect(finish.status).toBe('COMPLETED');
    expect(finish.finished_reason).not.toBe('The task no longer exists');
  });

  /**
   * AC3, and the case a dispatch-time-only mechanism passes every test above and still fails:
   * the workflow's first step is a WAIT, so the send happens hours after the row was destroyed,
   * on a wake carrying nothing but an enrollment id. The identity and the roster are re-read
   * from the persisted payload on THAT step, which is why they are still there.
   */
  it('still names the task when a WAIT delays the send by hours', async () => {
    const FOUR_HOURS = 4 * 60;
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        step_cursor: 1, // resuming at the send, the WAIT already behind it
        workflow_id: WF_DELETED_ID,
        workflow_version_id: VER_DELETED_ID,
        dedupe_key: `TASK_DELETED:${TASK_ID}`,
        workflow: deletedWorkflowRow(),
        version: {
          definition: deletedDefinition([
            { position: 0, step_type: 'WAIT', config: { duration_minutes: FOUR_HOURS } },
            {
              position: 1,
              step_type: 'SEND_EMAIL',
              config: { recipients: ['assignees', 'watchers'], subject: 's', body: DELETED_BODY },
            },
          ]),
        },
        event_payload: {
          actorId: CREATOR.id,
          mergeFields: { 'task.number': 'T00042', 'task.title': TITLE },
          taskSnapshot: { assigneeIds: [ANN.id, BOB.id], watcherIds: [CAT.id], creatorId: CREATOR.id },
        },
      }),
    );

    await advanceEnrollment(ENR_ID, new Date(NOW.getTime() + FOUR_HOURS * 60_000));

    expect(sentTo()).toEqual([ANN.email, BOB.email, CAT.email].sort());
    expect(bodyFor(BOB.email)).toContain(`T00042: ${TITLE}`);
  });

  it('reaches the watchers alone when the workflow is addressed only to them', async () => {
    mockPrisma.workflowEnrollment.findUnique.mockResolvedValue(
      enrollmentRow({
        workflow_id: WF_DELETED_ID,
        workflow_version_id: VER_DELETED_ID,
        workflow: deletedWorkflowRow(),
        version: {
          definition: deletedDefinition([{
            position: 0,
            step_type: 'SEND_EMAIL',
            config: { recipients: ['watchers'], subject: 's', body: DELETED_BODY },
          }]),
        },
        event_payload: {
          actorId: CREATOR.id,
          mergeFields: { 'task.number': 'T00042', 'task.title': TITLE },
          taskSnapshot: { assigneeIds: [ANN.id, BOB.id], watcherIds: [CAT.id], creatorId: CREATOR.id },
        },
      }),
    );

    await enrollOnEvent(wereOnTheTask(), NOW);

    expect(sentTo()).toEqual([CAT.email]);
  });

  /**
   * The other half of the promise, assembled. A COMMENT enrollment whose task was deleted
   * mid-wait sends nothing at all - only the deleted trigger survives a vanished row, which is
   * what stops a destroyed task carrying on notifying people.
   */
  it('a comment enrollment on the SAME vanished task sends nothing', async () => {
    await enrollOnEvent(commentedTask(NOTE_ID), NOW);

    expect(mockSendEmail).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const finish = mockPrisma.workflowEnrollment.update.mock.calls.at(-1)![0].data as any;
    expect(finish).toMatchObject({ status: 'STOPPED', finished_reason: 'The task no longer exists' });
  });
});

// ── Spec B slice 5: reminders before a task is due, and chases after ─────────

/**
 * The one task workflow the POLLER enrolls. Everything above starts at a dispatch site; this
 * starts at the due-date sweep, so the assembled path here is: window math -> candidate query
 * -> entity label -> occurrence key -> entitlement gate -> enrollment -> task load -> audience
 * resolution -> merge-field rendering -> outbox.
 *
 * That whole chain is silent when it breaks. candidatesForAnchor's switch defaults to an empty
 * list and cron's trigger list is a bare array, so a task workflow can publish, enable, validate
 * and read back perfectly in the builder while never firing, with nothing red and nothing logged.
 */
describe('assembled: a reminder a day before the task is due', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const DUE_TOMORROW = new Date(NOW.getTime() + 21 * 60 * 60 * 1000); // inside [now, now+24h]

  beforeEach(() => {
    mockPrisma.task.findMany.mockResolvedValue([
      { id: TASK_ID, title: TITLE, due_at: DUE_TOMORROW },
    ]);
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: DUE_TOMORROW }));
  });

  it('emails each assignee of a task due tomorrow, exactly once', async () => {
    await sweepAndRun();

    expect(sentTo()).toEqual([ANN.email, BOB.email, CREATOR.email]);
  });

  /**
   * No actor. Unlike the four event triggers, nobody DID anything here - the clock did - so the
   * creator is a legitimate recipient of their own task's reminder rather than someone being
   * told what they just did.
   */
  it('includes the creator when they are an assignee - a clock has no acting user to drop', async () => {
    await sweepAndRun();

    expect(sentTo()).toContain(CREATOR.email);
  });

  it('renders the due date the reminder is about into the body', async () => {
    await sweepAndRun();

    const body = bodyFor(ANN.email);
    expect(body).toContain(TITLE);
    expect(body).toContain('T00042');
    expect(body).not.toContain('{{');
  });

  it('keys the enrollment on the bare ISO due date and labels it with the task TITLE', async () => {
    await sweepAndRun();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data as any;
    expect(data.entity_type).toBe('task');
    expect(data.entity_label).toBe(TITLE);
    expect(data.occurrence_key).toBe(DUE_TOMORROW.toISOString());
    expect(data.dedupe_key).toBe(`TASK_DATE_ANCHORED:${TASK_ID}:${DUE_TOMORROW.toISOString()}`);
  });

  it('sends the overdue chase from the SAME trigger, one day the other side of the due date', async () => {
    const overdue = new Date(NOW.getTime() - DAY_MS);
    mockPrisma.task.findMany.mockResolvedValue([{ id: TASK_ID, title: TITLE, due_at: overdue }]);
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: overdue }));

    await sweepAndRun(dueDefinition('after'));

    expect(sentTo()).toEqual([ANN.email, BOB.email, CREATOR.email]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data = mockPrisma.workflowEnrollment.create.mock.calls[0][0].data as any;
    expect(data.occurrence_key).toBe(overdue.toISOString());
  });

  it('reaches the watchers instead when the workflow is addressed to them', async () => {
    await sweepAndRun(dueDefinition('before', ['watchers']));

    expect(sentTo()).toEqual([CAT.email]);
  });

  /**
   * A task with no due date is never a candidate, so an org that does not use due dates gets
   * no mail from an enabled reminder - story 26's shape, at the sweep.
   */
  it('sends nothing for a task with no due date', async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ id: TASK_ID, title: TITLE, due_at: null }]);

    await sweepAndRun();

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });

  /**
   * Date-anchored triggers have NO re-arm by design: nothing is parked ahead of the fire moment,
   * so a moved due date is simply a new occurrence picked up on a later tick. Two due dates
   * therefore mint two distinct dedupe keys and produce two reminders, one per date.
   *
   * The other half of that promise - suppressing an IN-FLIGHT run whose due date moved out from
   * under it - is send-time staleness and belongs to the next slice, not to the sweep.
   */
  it('a due date that moves twice produces two reminders, one per date, on distinct dedupe keys', async () => {
    const second = new Date(NOW.getTime() + 23 * 60 * 60 * 1000);

    await sweepAndRun();
    mockPrisma.task.findMany.mockResolvedValue([{ id: TASK_ID, title: TITLE, due_at: second }]);
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: second }));
    await sweepAndRun();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const keys = mockPrisma.workflowEnrollment.create.mock.calls.map((c: any[]) => c[0].data.dedupe_key);
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(2);
    expect(keys[0]).toContain(DUE_TOMORROW.toISOString());
    expect(keys[1]).toContain(second.toISOString());
    // Two enrollments, two sends - six addresses across three assignees, twice over.
    expect(mockSendEmail).toHaveBeenCalledTimes(6);
  });
});

// ── Spec B slice 7, assembled: the five SEEDED defaults, as shipped ──────────

/**
 * Final form. Every block above runs hand-written copy, which proves the ENGINE works; this
 * one runs the registry's own five entries through `buildDefinition` - the exact function the
 * seeder freezes into each org's published version - which proves the PRODUCT works.
 *
 * The distinction is the whole point of this block. A default can validate, publish, enable
 * and read back correctly in the builder while addressing the wrong audience, rendering a
 * merge field into an empty string, or carrying a trigger_config the poller refuses. None of
 * those is a compile error, a validation issue or a log line. They are only visible here.
 */
describe('assembled: the five seeded defaults, exactly as the seeder writes them', () => {
  type PublishedDefinition = (typeof PUBLISHED)[number]['definition'];

  const seeded = (builtinKey: string): PublishedDefinition => {
    const entry = DEFAULT_AUTOMATIONS.find((d) => d.builtin_key === builtinKey);
    expect(entry, `${builtinKey} is not in DEFAULT_AUTOMATIONS`).toBeDefined();
    return buildDefinition(entry!) as unknown as PublishedDefinition;
  };

  /** What the file's own fixtures use, restored after this block so nothing downstream inherits. */
  const HAND_WRITTEN = PUBLISHED.map((w) => w.definition);
  const SEEDED_DUE = seeded('default-task-due-reminder');

  const DUE_TOMORROW = new Date(NOW.getTime() + 21 * 60 * 60 * 1000); // inside [now, now+24h]

  beforeEach(() => {
    PUBLISHED.find((w) => w.row.id === WF_ID)!.definition = seeded('default-task-created');
    PUBLISHED.find((w) => w.row.id === WF_ASSIGNED_ID)!.definition = seeded('default-task-assigned');
    PUBLISHED.find((w) => w.row.id === WF_COMMENT_ID)!.definition = seeded('default-task-comment-added');
    PUBLISHED.find((w) => w.row.id === WF_DELETED_ID)!.definition = seeded('default-task-deleted');
    PUBLISHED.find((w) => w.row.id === WF_DUE_ID)!.definition = SEEDED_DUE;
    mockPrisma.task.findMany.mockResolvedValue([{ id: TASK_ID, title: TITLE, due_at: DUE_TOMORROW }]);
  });

  afterEach(() => {
    PUBLISHED.forEach((w, i) => {
      w.definition = HAND_WRITTEN[i];
    });
  });

  it('the created default emails the assignees, and never the person who created the task', async () => {
    await enrollOnEvent(createdTask(), NOW);

    expect(sentTo()).toEqual([ANN.email, BOB.email]);
    expect(sentTo()).not.toContain(CREATOR.email);
  });

  /**
   * The seeded proof of the slice's highest-damage line. Cat is added to a task that already
   * carries three people; on `assignees` this default would mail all four.
   */
  it('the assignment default emails ONE person when one person is added to a three-person task', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id], watcher_ids: [] }),
    );

    await enrollOnEvent(assignedTask(CAT), NOW);

    expect(sentTo()).toEqual([CAT.email]);
  });

  it('the comment default reaches the assignees and the watchers, never the commenter', async () => {
    await enrollOnEvent(commentedTask(NOTE_ID), NOW);

    expect(sentTo()).toEqual([ANN.email, CAT.email, CREATOR.email].sort());
    expect(sentTo()).not.toContain(BOB.email);
  });

  it('the deleted default reaches everyone who was on it, naming the task by number and title', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await enrollOnEvent(deletedTask([ANN.id, BOB.id], [CAT.id]), NOW);

    expect(sentTo()).toEqual([ANN.email, BOB.email, CAT.email].sort());
    const body = bodyFor(ANN.email);
    expect(body).toContain('T00042');
    expect(body).toContain(TITLE);
  });

  /**
   * THE regression this slice's seeder change exists for. Seeded with the old hardcoded
   * `trigger_config: null` this test sends nothing at all: the sweep is never reached because
   * the poller cannot read the config, and the failure is a warn line rather than an error.
   */
  it('the reminder default actually fires - its seeded trigger_config is a real anchor, not a null', async () => {
    expect(SEEDED_DUE.trigger_config).toEqual({
      anchor: 'task.due_at',
      direction: 'before',
      offset_minutes: 24 * 60,
    });
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: DUE_TOMORROW }));

    await sweepAndRun(SEEDED_DUE as unknown as ReturnType<typeof dueDefinition>);

    expect(sentTo()).toEqual([ANN.email, BOB.email, CREATOR.email]);
  });

  /**
   * The validator refuses an ILLEGAL merge field. It cannot refuse a LEGAL one that resolves to
   * an empty string, and an empty field reads as a broken template rather than as missing data.
   * Every assertion below is anchored on the character that must follow the field.
   */
  it('renders every seeded body with no leftover token and no blank where a value belongs', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ due_at: DUE_TOMORROW }));

    await enrollOnEvent(createdTask(), NOW);
    const created = bodyFor(ANN.email);
    expect(created).not.toContain('{{');
    expect(created).not.toContain('null');
    expect(created).not.toContain('undefined');
    expect(created).toMatch(/Everyone on it: \S/);
    expect(created).toMatch(/Open it here: \S/);
    expect(created).toContain('Blue Ridge Plumbing');
    // The seeded copy opens on its own payload now, not on a greeting - see the registry
    // note in defaultAutomations.ts. Asserted as a PREFIX so a greeting creeping back in
    // (which would mean the retired merge field came back) fails here.
    expect(created.startsWith('A new task has been assigned to you at ')).toBe(true);

    mockSendEmail.mockClear();
    await sweepAndRun(SEEDED_DUE as unknown as ReturnType<typeof dueDefinition>);
    const reminder = bodyFor(ANN.email);
    expect(reminder).not.toContain('{{');
    // The blank this catches is the one the whole "seeded copy" risk is about: `task.due_date`
    // renders empty for a task with no due date, and "is due ." reads as a bug.
    expect(reminder).toMatch(/is due \S/);
  });

  /**
   * The whole spec, in one org, in order. Five moments, five audiences, one email each.
   */
  it('create, assign, comment, delete, remind: the right people get one email each', async () => {
    // 1. Dee creates the task with Ann and Bob on it. The two of them hear; Dee does not.
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id], watcher_ids: [] }),
    );
    await enrollOnEvent(createdTask(), NOW);
    expect(sentTo()).toEqual([ANN.email, BOB.email]);

    // 2. Dee adds Cat. Only Cat hears about it - not the three already on it.
    mockSendEmail.mockClear();
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id, CAT.id], watcher_ids: [] }),
    );
    await enrollOnEvent(assignedTask(CAT), NOW);
    expect(sentTo()).toEqual([CAT.email]);

    // 3. Bob comments. Everyone else on the task hears; Bob does not.
    mockSendEmail.mockClear();
    await enrollOnEvent(commentedTask(NOTE_ID), NOW);
    expect(sentTo()).toEqual([ANN.email, CAT.email, CREATOR.email].sort());

    // 4. The reminder, a day before it is due. No actor, so the creator is included.
    mockSendEmail.mockClear();
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [CREATOR.id, ANN.id, BOB.id], watcher_ids: [], due_at: DUE_TOMORROW }),
    );
    await sweepAndRun(SEEDED_DUE as unknown as ReturnType<typeof dueDefinition>);
    expect(sentTo()).toEqual([ANN.email, BOB.email, CREATOR.email]);

    // 5. Dee deletes it. Everyone who was on it hears; Dee does not.
    mockSendEmail.mockClear();
    mockPrisma.task.findFirst.mockResolvedValue(null);
    await enrollOnEvent(deletedTask([CREATOR.id, ANN.id, BOB.id], [CAT.id]), NOW);
    expect(sentTo()).toEqual([ANN.email, BOB.email, CAT.email].sort());
    expect(sentTo()).not.toContain(CREATOR.email);
  });

  /**
   * Story 26. An org that has the five seeded and no tasks sends nothing: the four event
   * triggers have no event, and the sweep has no candidate.
   */
  it('an org with the defaults and no tasks sends nothing at all', async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);

    await sweepAndRun(SEEDED_DUE as unknown as ReturnType<typeof dueDefinition>);

    expect(mockSendEmail).not.toHaveBeenCalled();
    expect(mockPrisma.workflowEnrollment.create).not.toHaveBeenCalled();
  });
});
