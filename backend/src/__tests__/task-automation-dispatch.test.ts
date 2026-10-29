/**
 * task-automation-dispatch.test.ts - Spec B slice 1
 *
 * Creating a task is now an Automation Center event. This file pins the CONTROLLER half:
 * that TASK_CREATED is dispatched at all, that it carries what the engine needs (org, entity
 * ref labelled with the TITLE, the acting user for Rule 0), that it fires POST-COMMIT, and
 * that `notify: { email: false }` suppresses it while the bell verbs still ring - the same
 * per-request channel toggle the job assign endpoint already accepts (#361).
 *
 * Slice 2 adds the mutual exclusion and its mirror: creating a task fires TASK_CREATED and
 * NOT TASK_ASSIGNED, while adding a person to a task that already existed fires TASK_ASSIGNED
 * once, for that person, carrying the occurrence the dedupe key needs.
 *
 * The engine half (who actually receives the email) lives in the automations suites; the
 * assembled path lives in task-automation-assembled.test.ts.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, stubTaskRowLocks } from './helpers';
import { buildDedupeKey } from '../services/automations/dedupe';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

vi.mock('../services/automations/dispatch', () => ({
  dispatchAutomationEvent: vi.fn(),
}));
import { dispatchAutomationEvent } from '../services/automations/dispatch';
const mockDispatch = dispatchAutomationEvent as ReturnType<typeof vi.fn>;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const TASK_ID = 'aa000000-0000-0000-0000-0000000000e1';
const ACTOR = TEST_USERS.admin.id;
const DANA = 'aaaaaaa1-0000-0000-0000-000000000001';
const TITLE = 'Order the replacement thermostat';

const ELI = 'aaaaaaa1-0000-0000-0000-000000000002';
const FAY = 'aaaaaaa1-0000-0000-0000-000000000003';

const ORG_USERS = [
  { id: ACTOR, email: 'admin@org.com', role: 'ADMIN', first_name: 'Test', last_name: 'Admin', is_active: true, organization_id: ALPHA_ORG_ID },
  { id: DANA, email: 'dana@org.com', role: 'DISPATCHER', first_name: 'Dana', last_name: 'Cohen', is_active: true, organization_id: ALPHA_ORG_ID },
  { id: ELI, email: 'eli@org.com', role: 'TECHNICIAN', first_name: 'Eli', last_name: 'Ramos', is_active: true, organization_id: ALPHA_ORG_ID },
  { id: FAY, email: 'fay@org.com', role: 'TECHNICIAN', first_name: 'Fay', last_name: 'Ng', is_active: true, organization_id: ALPHA_ORG_ID },
];

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  task_number: 'T00042',
  organization_id: ALPHA_ORG_ID,
  title: TITLE,
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [ACTOR, DANA],
  watcher_ids: [] as string[],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  completed_at: null,
  created_by: ACTOR,
  created_at: new Date('2026-08-28'),
  updated_at: new Date('2026-08-28'),
  ...over,
});

const dispatchesOf = (type: string) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockDispatch.mock.calls.map((c: any[]) => c[0]).filter((e) => e.type === type);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  mockPrisma.user.findMany.mockResolvedValue(ORG_USERS);
  mockPrisma.task.findFirst.mockResolvedValue(taskRow());
  mockPrisma.task.create.mockResolvedValue(taskRow());
  mockPrisma.task.update.mockResolvedValue(taskRow());
  // A lone request wins its own status compare-and-set. Re-armed here because the race suite
  // below swaps in a stateful fake, and clearAllMocks does not undo an implementation.
  mockPrisma.task.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
});

describe('POST /api/tasks - TASK_CREATED dispatch', () => {
  it('dispatches TASK_CREATED with the org, the task and the acting user', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [ACTOR, DANA] });

    expect(res.status).toBe(201);
    const events = dispatchesOf('TASK_CREATED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'TASK_CREATED',
      organizationId: ALPHA_ORG_ID,
      // Rule 0's carrier: the creator is dropped from every resolved audience, so the person
      // who just made the task is not emailed about it.
      actorId: ACTOR,
    });
    // The TITLE, not the task number - a task's number means nothing to the person being
    // told about it, and this label is what the Activity tab renders.
    expect(events[0].entity).toEqual({ type: 'task', id: TASK_ID, label: TITLE });
  });

  it('carries no occurrence key - one create is one occurrence', async () => {
    await request(app).post('/api/tasks').set(authHeader('admin')).send({ title: TITLE });
    expect(dispatchesOf('TASK_CREATED')[0].occurrenceKey).toBeUndefined();
  });

  it('dispatches AFTER the transaction commits (#271)', async () => {
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let dispatchedBeforeCommit = false;
    mockDispatch.mockImplementation(() => {
      if (!committed) dispatchedBeforeCommit = true;
    });

    await request(app).post('/api/tasks').set(authHeader('admin')).send({ title: TITLE });
    expect(dispatchedBeforeCommit).toBe(false);
  });

  it('notify.email:false suppresses the dispatch but still rings the bell', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [ACTOR, DANA], notify: { email: false } });

    expect(res.status).toBe(201);
    expect(dispatchesOf('TASK_CREATED')).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.assigned')).toBe(true);
  });

  it('notify.in_app:false suppresses the bell but still dispatches the automation', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [ACTOR, DANA], notify: { in_app: false } });

    expect(res.status).toBe(201);
    expect(dispatchesOf('TASK_CREATED')).toHaveLength(1);
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('an omitted notify object behaves exactly as before - both channels fire', async () => {
    await request(app).post('/api/tasks').set(authHeader('admin')).send({ title: TITLE, assignee_ids: [ACTOR, DANA] });
    expect(dispatchesOf('TASK_CREATED')).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.assigned')).toBe(true);
  });
});

describe('PATCH /api/tasks/:id - the notify toggle', () => {
  it('accepts notify and suppresses the added-assignee bell without 400ing on the extra key', async () => {
    // A REAL delta: the task starts with the actor alone, so adding Dana would normally ring
    // task.assigned. Without the delta this test would pass against a controller that ignores
    // `notify` entirely.
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [ACTOR] }));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA], notify: { in_app: false } });

    expect(res.status).toBe(200);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.assigned')).toBe(false);
  });

  it('still rings task.assigned when notify is omitted', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [ACTOR] }));

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA] });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.assigned')).toBe(true);
  });

  it('dispatches no TASK_CREATED - an edit is not a creation', async () => {
    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ title: 'Renamed' });
    expect(dispatchesOf('TASK_CREATED')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Spec B slice 2 - TASK_ASSIGNED, and its mutual exclusion with TASK_CREATED
// ══════════════════════════════════════════════════════════════════════════════

describe('TASK_CREATED and TASK_ASSIGNED are mutually exclusive at creation', () => {
  /**
   * The single most valuable test in the spec. Both task defaults ship enabled and both
   * target the same people, so a create that fired BOTH would email every new task's
   * assignees twice on day one, silently. Asserted through the dispatch interface rather
   * than by reading the controller, so it survives a refactor of how the create handler
   * is written.
   */
  it('creating a task with TWO assignees fires created ONCE and assigned NEVER', async () => {
    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [DANA, ELI] });

    expect(res.status).toBe(201);
    expect(dispatchesOf('TASK_CREATED')).toHaveLength(1);
    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
  });

  it('editing a task never fires created - an edit is not a creation', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [ACTOR] }));

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA] });

    expect(dispatchesOf('TASK_CREATED')).toHaveLength(0);
  });
});

describe('PATCH /api/tasks/:id - TASK_ASSIGNED dispatch', () => {
  /** The task already has two people on it, which is what makes the audience question real. */
  const twoOnIt = (assignees: string[] = [ACTOR, DANA]) =>
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: assignees }));

  it('fires once for the person ADDED, scoped to them, and not for the two already on it', async () => {
    twoOnIt();

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI] });

    expect(res.status).toBe(200);
    const events = dispatchesOf('TASK_ASSIGNED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'TASK_ASSIGNED',
      organizationId: ALPHA_ORG_ID,
      // The occurrence discriminator. Without it buildDedupeKey throws, createEnrollment
      // swallows the throw and returns null, and the trigger silently never enrolls.
      occurrenceKey: ELI,
      actorId: ACTOR,
    });
    expect(events[0].entity).toEqual({ type: 'task', id: TASK_ID, label: TITLE });
    // The added person's own row rides the event, because `assigned_user` resolves from the
    // dispatching event and not from the live roster.
    expect(events[0].eventPayload.recipient).toMatchObject({ id: ELI, email: 'eli@org.com' });
    expect(events[0].occurrenceKey).not.toBe(ACTOR);
    expect(events[0].occurrenceKey).not.toBe(DANA);
  });

  it('supplies an occurrence the dedupe key can actually be built from', async () => {
    twoOnIt();

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI] });

    const ev = dispatchesOf('TASK_ASSIGNED')[0];
    // A miss here is TOTAL, PERMANENT and SILENT: the throw is caught inside createEnrollment,
    // which logs at warn and returns null, so nothing downstream can observe it.
    expect(() => buildDedupeKey(ev.type, ev.entity.id, ev.occurrenceKey)).not.toThrow();
    expect(buildDedupeKey(ev.type, ev.entity.id, ev.occurrenceKey)).toBe(`TASK_ASSIGNED:${TASK_ID}:${ELI}`);
  });

  it('fires once PER newly added person when two arrive in the same PATCH', async () => {
    twoOnIt();

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI, FAY] });

    const events = dispatchesOf('TASK_ASSIGNED');
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.occurrenceKey).sort()).toEqual([ELI, FAY].sort());
  });

  it('produces a DISTINCT enrollment key for a second person added later, rather than a duplicate of the first', async () => {
    twoOnIt();
    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI] });

    twoOnIt([ACTOR, DANA, ELI]);
    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI, FAY] });

    const keys = dispatchesOf('TASK_ASSIGNED').map((e) => buildDedupeKey(e.type, e.entity.id, e.occurrenceKey));
    expect(keys).toHaveLength(2);
    // The (workflow_id, dedupe_key) unique constraint is what would swallow the second one.
    expect(new Set(keys).size).toBe(2);
  });

  it('re-sending an UNCHANGED assignee list dispatches nothing', async () => {
    twoOnIt();

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [DANA, ACTOR] });

    expect(res.status).toBe(200);
    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
  });

  it('dispatches nothing when the PATCH never mentions the roster at all', async () => {
    twoOnIt();

    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ title: 'Renamed' });

    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
  });

  /**
   * Watching is self-service following, not work being handed to someone. The bell is
   * deliberately louder here than the automation: `task.watching` still rings.
   */
  it('adding a WATCHER dispatches no automation at all, while the watching bell verb still rings', async () => {
    twoOnIt();

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ watcher_ids: [ELI] });

    expect(res.status).toBe(200);
    expect(mockDispatch).not.toHaveBeenCalled();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.watching')).toBe(true);
  });

  it('a person REMOVED from the task dispatches nothing - only the assigned delta dispatches', async () => {
    twoOnIt([ACTOR, DANA, ELI]);

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA] });

    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
  });

  it('notify.email:false suppresses the dispatch but still rings the bell', async () => {
    twoOnIt();

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI], notify: { email: false } });

    expect(res.status).toBe(200);
    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.assigned')).toBe(true);
  });

  it('notify.in_app:false suppresses the bell but still dispatches the automation', async () => {
    twoOnIt();

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI], notify: { in_app: false } });

    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(1);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.assigned')).toBe(false);
  });

  it('dispatches AFTER the transaction commits (#271) - a rolled-back edit leaves no enrollment', async () => {
    twoOnIt();
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let dispatchedBeforeCommit = false;
    mockDispatch.mockImplementation(() => {
      if (!committed) dispatchedBeforeCommit = true;
    });

    await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI] });

    expect(dispatchedBeforeCommit).toBe(false);
  });

  it('dispatches nothing when the write itself fails', async () => {
    twoOnIt();
    mockPrisma.task.update.mockRejectedValue(new Error('constraint'));

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('admin'))
      .send({ assignee_ids: [ACTOR, DANA, ELI] });

    expect(res.status).toBe(500);
    expect(dispatchesOf('TASK_ASSIGNED')).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Spec B slice 3 - TASK_COMMENT_ADDED
// ══════════════════════════════════════════════════════════════════════════════

const NOTE_ID = 'bb000000-0000-0000-0000-0000000000c1';
const SECOND_NOTE_ID = 'bb000000-0000-0000-0000-0000000000c2';

const noteRow = (id: string = NOTE_ID) => ({
  id,
  entity_type: 'TASK',
  entity_id: TASK_ID,
  content: 'Which panel is it behind?',
  created_by: ACTOR,
  organization_id: ALPHA_ORG_ID,
  created_at: new Date('2026-08-28T15:00:00.000Z'),
});

describe('POST /api/tasks/:id/comments - TASK_COMMENT_ADDED dispatch', () => {
  beforeEach(() => {
    mockPrisma.note.create.mockResolvedValue(noteRow());
  });

  it('dispatches TASK_COMMENT_ADDED with the org, the task and the commenter', async () => {
    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('admin'))
      .send({ body: 'Which panel is it behind?' });

    expect(res.status).toBe(201);
    const events = dispatchesOf('TASK_COMMENT_ADDED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'TASK_COMMENT_ADDED',
      organizationId: ALPHA_ORG_ID,
      // Rule 0's carrier, and the ONLY thing that keeps the commenter out of the audience
      // once a WAIT step has parked the send for a day.
      actorId: ACTOR,
    });
    // The TITLE, not the task number - the same choice the bell verbs make.
    expect(events[0].entity).toEqual({ type: 'task', id: TASK_ID, label: TITLE });
  });

  it('supplies the NOTE id as the occurrence the dedupe key is built from', async () => {
    await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('admin'))
      .send({ body: 'Which panel is it behind?' });

    const ev = dispatchesOf('TASK_COMMENT_ADDED')[0];
    // A miss here is TOTAL, PERMANENT and SILENT: buildDedupeKey throws, createEnrollment
    // catches it, logs at warn and returns null, so nothing downstream can observe it.
    expect(ev.occurrenceKey).toBe(NOTE_ID);
    expect(() => buildDedupeKey(ev.type, ev.entity.id, ev.occurrenceKey)).not.toThrow();
    expect(buildDedupeKey(ev.type, ev.entity.id, ev.occurrenceKey))
      .toBe(`TASK_COMMENT_ADDED:${TASK_ID}:${NOTE_ID}`);
  });

  it('a SECOND comment on the same task produces a DISTINCT key, not a duplicate of the first', async () => {
    await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin')).send({ body: 'one' });
    mockPrisma.note.create.mockResolvedValue(noteRow(SECOND_NOTE_ID));
    await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin')).send({ body: 'two' });

    const keys = dispatchesOf('TASK_COMMENT_ADDED')
      .map((e) => buildDedupeKey(e.type, e.entity.id, e.occurrenceKey));
    expect(keys).toHaveLength(2);
    // The [workflow_id, dedupe_key] unique constraint is what would swallow the second one.
    expect(new Set(keys).size).toBe(2);
  });

  it('dispatches AFTER the transaction commits (#271) - a rolled-back comment leaves no enrollment', async () => {
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let dispatchedBeforeCommit = false;
    mockDispatch.mockImplementation(() => {
      if (!committed) dispatchedBeforeCommit = true;
    });

    await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin')).send({ body: 'hi' });

    expect(dispatchedBeforeCommit).toBe(false);
  });

  it('dispatches nothing when the note write itself fails', async () => {
    mockPrisma.note.create.mockRejectedValue(new Error('constraint'));

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('admin'))
      .send({ body: 'hi' });

    expect(res.status).toBe(500);
    expect(dispatchesOf('TASK_COMMENT_ADDED')).toHaveLength(0);
    // The bell must not fire for a comment that never happened either - both live after the
    // same commit, which is what keeps the trigger from disagreeing with the record.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.commented')).toBe(false);
  });

  it('fires the bell and the automation from the SAME handler, bell first', async () => {
    await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin')).send({ body: 'hi' });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(mockEmit.mock.calls.some((c: any[]) => c[0].verb === 'task.commented')).toBe(true);
    expect(dispatchesOf('TASK_COMMENT_ADDED')).toHaveLength(1);
    expect(mockEmit.mock.invocationCallOrder[0]).toBeLessThan(mockDispatch.mock.invocationCallOrder[0]);
  });

  it('carries no eventPayload recipient - a comment is about the task, not about one person', async () => {
    await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin')).send({ body: 'hi' });

    // `assigned_user` is deliberately not offered on this trigger (catalog.ts), so nothing
    // downstream reads an event recipient here.
    expect(dispatchesOf('TASK_COMMENT_ADDED')[0].eventPayload).toBeUndefined();
  });
});

// ── Spec B slice 4: the task is destroyed, and the event has to outlive it ────

describe('DELETE /api/tasks/:id - TASK_DELETED dispatch', () => {
  /** Ann and Bob assigned, Fay watching, the admin the creator - and all of it about to vanish. */
  const withRoster = () =>
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ created_by: ACTOR, assignee_ids: [DANA, ELI], watcher_ids: [FAY] }),
    );

  beforeEach(() => {
    withRoster();
    mockPrisma.note.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.task.deleteMany.mockResolvedValue({ count: 1 });
    stubTaskRowLocks();
  });

  it('dispatches TASK_DELETED with the org, the task and the acting user', async () => {
    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    const events = dispatchesOf('TASK_DELETED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ organizationId: ALPHA_ORG_ID, actorId: ACTOR });
    // The TITLE, and it matters more here than anywhere else: the enrollment's entity_label is
    // the only place the identity survives outside the payload.
    expect(events[0].entity).toEqual({ type: 'task', id: TASK_ID, label: TITLE });
  });

  /**
   * The heart of the slice. The row is hard-deleted, so by the time the engine runs a step
   * there is nothing to read - the identity has to be PERSISTED on the enrollment, and it is
   * persisted through the same event_payload channel `event.reason` already travels on.
   */
  it('carries the identity as merge fields, restricted to what the snapshot can honestly answer', async () => {
    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(dispatchesOf('TASK_DELETED')[0].eventPayload.mergeFields).toEqual({
      'task.number': 'T00042',
      'task.title': TITLE,
    });
  });

  it('carries the pre-delete roster so the audience resolves from the snapshot, not a dead row', async () => {
    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(dispatchesOf('TASK_DELETED')[0].eventPayload.taskSnapshot).toEqual({
      assigneeIds: [DANA, ELI],
      watcherIds: [FAY],
      creatorId: ACTOR,
    });
  });

  it('carries no occurrence key - a task is deleted exactly once', async () => {
    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));
    expect(dispatchesOf('TASK_DELETED')[0].occurrenceKey).toBeUndefined();
  });

  /**
   * The snapshot has to be taken from the row already in hand, BEFORE the transaction opens.
   * A dispatch that re-read the task would find nothing and send an email about nothing.
   */
  it('dispatches AFTER the transaction commits, off a single pre-transaction read (#271)', async () => {
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let dispatchedBeforeCommit = false;
    mockDispatch.mockImplementation(() => {
      if (!committed) dispatchedBeforeCommit = true;
    });

    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(dispatchedBeforeCommit).toBe(false);
    expect(mockPrisma.task.findFirst).toHaveBeenCalledTimes(1);
  });

  it('dispatches nothing when the delete itself fails', async () => {
    mockPrisma.task.deleteMany.mockRejectedValue(new Error('constraint'));

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(500);
    expect(dispatchesOf('TASK_DELETED')).toHaveLength(0);
  });

  /**
   * The bell verb this slice reuses the snapshot of is UNCHANGED - same roster, same label -
   * so the two halves cannot drift into disagreeing about who was on the task.
   */
  it('still emits the existing task.deleted bell verb with the same snapshot roster', async () => {
    await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bell = mockEmit.mock.calls.map((c: any[]) => c[0]).find((e) => e.verb === 'task.deleted');
    expect(bell).toBeDefined();
    expect(bell.entity).toEqual({ assignee_ids: [DANA, ELI], watcher_ids: [FAY] });
    expect(bell.object).toEqual({ type: 'TASK', id: TASK_ID, label: TITLE });
    expect(bell.data).toEqual({ task_number: 'T00042' });
    expect(mockEmit.mock.invocationCallOrder[0]).toBeLessThan(mockDispatch.mock.invocationCallOrder[0]);
  });
});

// ── "Task is done" (visits-and-task-categories slice 14) ─────────────────────

describe('PATCH /api/tasks/:id - TASK_COMPLETED dispatch', () => {
  const withStatus = (status: string) =>
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ status }));

  const complete = () =>
    request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'DONE' });

  beforeEach(() => {
    mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
  });

  it('a move into DONE dispatches TASK_COMPLETED exactly once, with the org, the task and the acting user', async () => {
    withStatus('IN_PROGRESS');

    const res = await complete();

    expect(res.status).toBe(200);
    const events = dispatchesOf('TASK_COMPLETED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'TASK_COMPLETED',
      organizationId: ALPHA_ORG_ID,
      // Rule 0's carrier: the person who marked it done is dropped from every audience.
      actorId: ACTOR,
    });
    expect(events[0].entity).toEqual({ type: 'task', id: TASK_ID, label: TITLE });
  });

  it('keys the occurrence on the SAME instant the write stamped as completed_at', async () => {
    withStatus('TODO');

    await complete();

    const written = mockPrisma.task.update.mock.calls[0][0].data.completed_at as Date;
    expect(written).toBeInstanceOf(Date);
    const ev = dispatchesOf('TASK_COMPLETED')[0];
    expect(ev.occurrenceKey).toBe(written.toISOString());
    // A miss is silent: buildDedupeKey throws inside createEnrollment's catch and nothing enrols.
    expect(() => buildDedupeKey(ev.type, ev.entity.id, ev.occurrenceKey)).not.toThrow();
  });

  it('carries who finished it and when, in the org timezone, as merge fields', async () => {
    withStatus('TODO');
    mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/Los_Angeles' });

    await complete();

    const written = mockPrisma.task.update.mock.calls[0][0].data.completed_at as Date;
    const expectedAt = written.toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
    });
    expect(dispatchesOf('TASK_COMPLETED')[0].eventPayload.mergeFields).toEqual({
      'task.completed_by': 'Test Admin',
      'task.completed_at': expectedAt,
    });
  });

  it('fires again after a reopen and a second completion, on a DISTINCT dedupe key', async () => {
    withStatus('IN_PROGRESS');
    await complete();

    withStatus('DONE');
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'IN_PROGRESS' });

    withStatus('IN_PROGRESS');
    // A clock that has moved on, as it has in life between two completions.
    await new Promise((r) => setTimeout(r, 5));
    await complete();

    const events = dispatchesOf('TASK_COMPLETED');
    expect(events).toHaveLength(2);
    const keys = events.map((e) => buildDedupeKey(e.type, e.entity.id, e.occurrenceKey));
    // The (workflow_id, dedupe_key) unique constraint is what would swallow the second finish.
    expect(new Set(keys).size).toBe(2);
  });

  it('re-sending DONE on a task that is already done dispatches nothing - it is not a transition', async () => {
    withStatus('DONE');
    const res = await complete();
    expect(res.status).toBe(200);
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(0);
  });

  it('an update that does not touch status dispatches nothing', async () => {
    withStatus('IN_PROGRESS');
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ title: 'Renamed', priority: 'HIGH' });
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(0);
  });

  it('a status change into anything other than DONE dispatches nothing - reopening included', async () => {
    for (const [from, to] of [['TODO', 'IN_PROGRESS'], ['IN_PROGRESS', 'BLOCKED'], ['DONE', 'TODO'], ['TODO', 'CANCELLED']]) {
      withStatus(from);
      await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: to });
    }
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(0);
  });

  it('a cancelled task marked done DOES dispatch - DONE is reached from any other status', async () => {
    withStatus('CANCELLED');
    await complete();
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(1);
  });

  it('dispatches AFTER the transaction commits (#271)', async () => {
    withStatus('TODO');
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let dispatchedBeforeCommit = false;
    mockDispatch.mockImplementation(() => {
      if (!committed) dispatchedBeforeCommit = true;
    });

    await complete();

    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(1);
    expect(dispatchedBeforeCommit).toBe(false);
  });

  it('dispatches nothing when the write itself fails', async () => {
    withStatus('TODO');
    mockPrisma.task.update.mockRejectedValue(new Error('constraint'));

    const res = await complete();

    expect(res.status).toBe(500);
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(0);
  });

  /**
   * notify.email mutes the ADDED notices only (the assign dialog's "email them" box). A finish is
   * the notice nobody thinks to ask for and everybody needs - the same reason the controller keeps
   * the task.completed bell verb unconditional - so the toggle does not reach it.
   */
  it('notify.email:false does not suppress it - the toggle governs the added-person notices only', async () => {
    withStatus('TODO');
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'DONE', notify: { email: false } });
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(1);
  });

  it('leaves the bell\'s task.completed verb exactly as it was (ADR 0005)', async () => {
    withStatus('TODO');
    await complete();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bell = mockEmit.mock.calls.map((c: any[]) => c[0]).filter((e) => e.verb === 'task.completed');
    expect(bell).toHaveLength(1);
  });
});

// ── "Task is cancelled" (visits-and-task-categories slice 15) ────────────────

describe('PATCH /api/tasks/:id - TASK_CANCELLED dispatch', () => {
  const withStatus = (status: string) =>
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ status }));

  const cancel = () =>
    request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'CANCELLED' });

  beforeEach(() => {
    mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
  });

  it('a move into CANCELLED dispatches TASK_CANCELLED exactly once, with the org, the task and the acting user', async () => {
    withStatus('IN_PROGRESS');

    const res = await cancel();

    expect(res.status).toBe(200);
    const events = dispatchesOf('TASK_CANCELLED');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'TASK_CANCELLED',
      organizationId: ALPHA_ORG_ID,
      // Rule 0's carrier: the person who cancelled it is dropped from every audience.
      actorId: ACTOR,
    });
    expect(events[0].entity).toEqual({ type: 'task', id: TASK_ID, label: TITLE });
  });

  /**
   * A cancel clears completed_at and there is no cancelled_at column, so the transition moment
   * lives ONLY in the event: the occurrence key and the cancelled-at merge field are the same
   * instant, minted by this request.
   */
  it('keys the occurrence on the moment of the cancel, and the cancelled-at field names that same moment', async () => {
    withStatus('TODO');
    const before = Date.now();

    await cancel();

    const after = Date.now();
    // Nothing on the row carries the moment: the write clears completed_at, as it always has.
    expect(mockPrisma.task.update.mock.calls[0][0].data.completed_at).toBeNull();
    const ev = dispatchesOf('TASK_CANCELLED')[0];
    const at = new Date(ev.occurrenceKey);
    expect(ev.occurrenceKey).toBe(at.toISOString());
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(after);
    expect(ev.eventPayload.mergeFields['task.cancelled_at']).toBe(at.toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York',
    }));
    // A miss is silent: buildDedupeKey throws inside createEnrollment's catch and nothing enrols.
    expect(() => buildDedupeKey(ev.type, ev.entity.id, ev.occurrenceKey)).not.toThrow();
  });

  it('carries who cancelled it and when, in the org timezone - and no cancellation reason, which a task does not record', async () => {
    withStatus('TODO');
    mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/Los_Angeles' });

    await cancel();

    const ev = dispatchesOf('TASK_CANCELLED')[0];
    const expectedAt = new Date(ev.occurrenceKey).toLocaleString('en-US', {
      year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Los_Angeles',
    });
    expect(ev.eventPayload.mergeFields).toEqual({
      'task.cancelled_by': 'Test Admin',
      'task.cancelled_at': expectedAt,
    });
  });

  it('fires again after a reopen and a second cancel, on a DISTINCT dedupe key', async () => {
    withStatus('IN_PROGRESS');
    await cancel();

    withStatus('CANCELLED');
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'TODO' });

    withStatus('TODO');
    // A clock that has moved on, as it has in life between two cancels.
    await new Promise((r) => setTimeout(r, 5));
    await cancel();

    const events = dispatchesOf('TASK_CANCELLED');
    expect(events).toHaveLength(2);
    const keys = events.map((e) => buildDedupeKey(e.type, e.entity.id, e.occurrenceKey));
    // The (workflow_id, dedupe_key) unique constraint is what would swallow the second cancel.
    expect(new Set(keys).size).toBe(2);
  });

  it('re-sending CANCELLED on a task that is already cancelled dispatches nothing - it is not a transition', async () => {
    withStatus('CANCELLED');
    const res = await cancel();
    expect(res.status).toBe(200);
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(0);
  });

  it('an update that does not touch status dispatches nothing', async () => {
    withStatus('IN_PROGRESS');
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ title: 'Renamed', priority: 'HIGH' });
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(0);
  });

  it('a status change into anything other than CANCELLED dispatches nothing - DONE and reopening included', async () => {
    for (const [from, to] of [['TODO', 'IN_PROGRESS'], ['IN_PROGRESS', 'BLOCKED'], ['CANCELLED', 'TODO'], ['TODO', 'DONE']]) {
      withStatus(from);
      await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: to });
    }
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(0);
  });

  it('a done task that is cancelled DOES dispatch "Task is cancelled", and not "Task is done"', async () => {
    withStatus('DONE');
    await cancel();
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(1);
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(0);
  });

  it('dispatches AFTER the transaction commits (#271)', async () => {
    withStatus('TODO');
    let committed = false;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      const out = await fn(prisma);
      committed = true;
      return out;
    });
    let dispatchedBeforeCommit = false;
    mockDispatch.mockImplementation(() => {
      if (!committed) dispatchedBeforeCommit = true;
    });

    await cancel();

    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(1);
    expect(dispatchedBeforeCommit).toBe(false);
  });

  it('dispatches nothing when the write itself fails', async () => {
    withStatus('TODO');
    mockPrisma.task.update.mockRejectedValue(new Error('constraint'));

    const res = await cancel();

    expect(res.status).toBe(500);
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(0);
  });

  it('notify.email:false does not suppress it - the toggle governs the added-person notices only', async () => {
    withStatus('TODO');
    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'CANCELLED', notify: { email: false } });
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(1);
  });

  it('leaves the bell\'s task.cancelled verb exactly as it was (ADR 0005)', async () => {
    withStatus('TODO');
    await cancel();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bell = mockEmit.mock.calls.map((c: any[]) => c[0]).filter((e) => e.verb === 'task.cancelled');
    expect(bell).toHaveLength(1);
  });
});

// ── Concurrent completion: the status move is a compare-and-set (slice 14 verifier finding) ──

/**
 * A double-click, or two people finishing the same task at once. Both requests read the task
 * BEFORE either writes, so both see TODO. Simulated at the transaction boundary: the pre-write
 * read serves the stale snapshot every request saw, while writes inside the transaction run
 * against ONE live row with compare-and-set semantics - which is what Postgres gives a
 * conditional UPDATE. Before the fix, both requests believed they moved the task and each
 * minted its own occurrence, so every recipient got the notice twice.
 */
describe('PATCH /api/tasks/:id - two requests racing to finish the same task', () => {
  let live: ReturnType<typeof taskRow>;
  let inTx = false;

  beforeEach(() => {
    live = taskRow({ status: 'TODO' });
    const stale = { ...live };
    mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York' });
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      inTx = true;
      try { return await fn(prisma); } finally { inTx = false; }
    });
    // Outside the transaction: what each request read before anyone wrote. Inside: the live row.
    mockPrisma.task.findFirst.mockImplementation(async () => (inTx ? { ...live } : { ...stale }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.task.updateMany.mockImplementation(async ({ where, data }: any) => {
      if (where.id !== live.id || (where.status !== undefined && where.status !== live.status)) return { count: 0 };
      live = { ...live, ...data };
      return { count: 1 };
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockPrisma.task.update.mockImplementation(async ({ data }: any) => {
      live = { ...live, ...data };
      return { ...live };
    });
  });

  const patch = (body: Record<string, unknown>) =>
    request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send(body);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bell = (verb: string) => mockEmit.mock.calls.map((c: any[]) => c[0]).filter((e) => e.verb === verb);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activities = (type: string) => mockPrisma.timelineEvent.create.mock.calls.filter((c: any[]) => c[0].data.event_type === type);

  it('two concurrent moves to DONE dispatch "Task is done" exactly once', async () => {
    const first = await patch({ status: 'DONE' });
    const second = await patch({ status: 'DONE' });

    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(1);
    // The bell's completion notice is on the same path and must not double either.
    expect(bell('task.completed')).toHaveLength(1);
    expect(activities('COMPLETED')).toHaveLength(1);
    // The loser is not an error: what it asked for is true. It answers with the task as it is.
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.task.status).toBe('DONE');
  });

  it('the loser still applies the rest of its edit', async () => {
    await patch({ status: 'DONE' });
    const second = await patch({ status: 'DONE', title: 'Renamed while finishing' });

    expect(second.status).toBe(200);
    expect(second.body.task).toMatchObject({ status: 'DONE', title: 'Renamed while finishing' });
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(1);
  });

  it('a request that lost the race to a DIFFERENT status gets a 409 and writes nothing', async () => {
    await patch({ status: 'DONE' });
    const cancel = await patch({ status: 'CANCELLED', title: 'Should not land' });

    expect(cancel.status).toBe(409);
    expect(cancel.body).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(live).toMatchObject({ status: 'DONE', title: TITLE });
    expect(bell('task.cancelled')).toHaveLength(0);
    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(1);
  });

  it('a reopen and a second finish still fire again - the guard stops duplicates, not occurrences', async () => {
    await patch({ status: 'DONE' });
    mockPrisma.task.findFirst.mockImplementation(async () => ({ ...live }));
    await patch({ status: 'IN_PROGRESS' });
    await new Promise((r) => setTimeout(r, 5));
    await patch({ status: 'DONE' });

    expect(dispatchesOf('TASK_COMPLETED')).toHaveLength(2);
  });

  // ── Slice 15: "Task is cancelled" is on the same compare-and-set ──────────────

  it('two concurrent cancels dispatch "Task is cancelled" exactly once', async () => {
    const first = await patch({ status: 'CANCELLED' });
    const second = await patch({ status: 'CANCELLED' });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(1);
    expect(bell('task.cancelled')).toHaveLength(1);
  });

  /**
   * Done and cancelled racing: one person ticks the task off while another cancels it. Both read
   * TODO. Exactly ONE of the two triggers may fire - the one whose move landed - and the loser is
   * refused (409), so nobody is told the work both finished and will not happen.
   */
  it.each([
    ['DONE', 'CANCELLED', 'TASK_COMPLETED', 'TASK_CANCELLED'],
    ['CANCELLED', 'DONE', 'TASK_CANCELLED', 'TASK_COMPLETED'],
  ])('%s racing %s: only the winner\'s trigger fires, and the loser gets a 409', async (winner, loser, fired, silent) => {
    const won = await patch({ status: winner });
    const lost = await patch({ status: loser });

    expect(won.status).toBe(200);
    expect(lost.status).toBe(409);
    expect(lost.body).toMatchObject({ code: 'STATE_CONFLICT' });
    expect(live.status).toBe(winner);
    expect(dispatchesOf(fired)).toHaveLength(1);
    expect(dispatchesOf(silent)).toHaveLength(0);
  });

  it('a reopen and a second cancel still fire again - the guard stops duplicates, not occurrences', async () => {
    await patch({ status: 'CANCELLED' });
    mockPrisma.task.findFirst.mockImplementation(async () => ({ ...live }));
    await patch({ status: 'TODO' });
    await new Promise((r) => setTimeout(r, 5));
    await patch({ status: 'CANCELLED' });

    expect(dispatchesOf('TASK_CANCELLED')).toHaveLength(2);
  });
});
