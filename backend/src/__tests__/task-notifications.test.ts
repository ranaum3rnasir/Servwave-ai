/**
 * task-notifications.test.ts — multi-assignee design §5 + §9
 *
 * The sharpest risk in this feature is that it fails SILENTLY. `emit()` opens with
 * `if (!isKnownVerb(args.verb)) return [];` — an unregistered verb neither throws nor logs,
 * so a suite that asserts on a MOCKED `emit` stays green for ever while not one notification
 * is delivered. Design §9 therefore mandates two guards, and this file is both of them:
 *
 *   1. ROW-LEVEL assertions. `emit` is deliberately NOT mocked. The controller tests drive
 *      the real HTTP route through the real templates + resolveRecipients + filterByAccess +
 *      the DB writes (only prisma is mocked, by setup.ts) and assert on the
 *      `NotificationRecipient` rows that actually reach `createMany`, matched back to their
 *      event row through `notification_id`. An unregistered verb writes no rows and fails here.
 *   2. VERB REGISTRATION. `isKnownVerb()` is true for all five.
 *
 * The five verbs and who they are for (design §5 — the actor is always suppressed):
 *   task.assigned  → the newly added assignees        task.removed  → the person taken off
 *   task.watching  → the newly added watchers         task.deleted  → assignees + watchers
 *   task.completed → the OTHER assignees + watchers
 *
 * Issue 03 adds a SIXTH: `task.cancelled` → the other assignees + watchers. It exists because
 * `task.completed` must not fire for an abandonment (it would say the work finished) and silence
 * is not acceptable either: being dropped from work you were assigned is the same surprise
 * `task.removed` exists to prevent.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, stubTaskRowLocks } from './helpers';
import { renderTemplate, isKnownVerb } from '../services/notifications/templates';
import { resolveRecipients } from '../services/notifications/resolveRecipients';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const TASK_ID = 'aa000000-0000-0000-0000-0000000000f1';
const ACTOR    = TEST_USERS.admin.id;                     // holds assign:Task via `manage all`
const DANA     = 'aaaaaaa1-0000-0000-0000-000000000001';
const SAGIV    = 'aaaaaaa1-0000-0000-0000-000000000002';
const WATCHER  = 'aaaaaaa1-0000-0000-0000-000000000003';

const TITLE = 'Rewire the west panel';

/** Every id the controller probes must resolve to an ACTIVE org member, or create/update 400s. */
const ORG_USERS = [
  { id: ACTOR,   role: 'ADMIN',      first_name: 'Test', last_name: 'Admin',  is_active: true, organization_id: ALPHA_ORG_ID },
  { id: DANA,    role: 'DISPATCHER', first_name: 'Dana', last_name: 'Cohen',  is_active: true, organization_id: ALPHA_ORG_ID },
  { id: SAGIV,   role: 'TECHNICIAN', first_name: 'Sagiv', last_name: 'Levi',  is_active: true, organization_id: ALPHA_ORG_ID },
  { id: WATCHER, role: 'SALES',      first_name: 'Maya', last_name: 'Barnea', is_active: true, organization_id: ALPHA_ORG_ID },
];

const taskRow = (over: Record<string, unknown> = {}) => ({
  id: TASK_ID,
  task_number: 'T00001',
  organization_id: ALPHA_ORG_ID,
  title: TITLE,
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [] as string[],
  watcher_ids: [] as string[],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  completed_at: null,
  created_by: ACTOR,
  created_at: new Date('2026-08-24'),
  updated_at: new Date('2026-08-24'),
  ...over,
});

// ─── Notification-row capture ─────────────────────────────────────────────────
//
// One request can fire several emits (an edit that adds an assignee, adds a watcher AND
// completes the task fires three). `createMany` rows only carry `notification_id`, so the
// verb has to be recovered from the event row it points at — which is also what proves the
// recipient rows are genuinely LINKED to the right event, not merely written.

type NotifRow = { verb: string; [k: string]: unknown };
const notifRows = new Map<string, NotifRow>();

/** The NotificationRecipient rows actually written for one verb, this request. */
function rowsFor(verb: string): Array<Record<string, unknown>> {
  const ids = [...notifRows.entries()].filter(([, n]) => n.verb === verb).map(([id]) => id);
  const written: Array<Record<string, unknown>> = mockPrisma.notificationRecipient.createMany.mock.calls
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    .flatMap((c: any[]) => c[0].data as Array<Record<string, unknown>>);
  return written.filter((r) => ids.includes(r.notification_id as string));
}

const recipientsOf = (verb: string): string[] =>
  rowsFor(verb).map((r) => r.recipient_id as string).sort();

/** The Notification EVENT row written for one verb. */
function eventFor(verb: string): NotifRow {
  const found = [...notifRows.values()].find((n) => n.verb === verb);
  if (!found) throw new Error(`no notification event row was written for ${verb}`);
  return found;
}

beforeEach(() => {
  vi.clearAllMocks();
  notifRows.clear();
  mockAuthAs('admin');

  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
  mockPrisma.user.findMany.mockResolvedValue(ORG_USERS);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.timelineEvent.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.note.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.task.deleteMany.mockResolvedValue({ count: 1 });
  stubTaskRowLocks();

  // The real emit() runs against these.
  mockPrisma.notification.findFirst.mockResolvedValue(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mockPrisma.notification.create.mockImplementation(({ data }: any) => {
    const id = `notif-${notifRows.size + 1}`;
    notifRows.set(id, data as NotifRow);
    return Promise.resolve({ id });
  });
  mockPrisma.notificationRecipient.createMany.mockResolvedValue({ count: 0 });
});

// ══════════════════════════════════════════════════════════════════════════════
// §9 guard 2 — verb registration. Without this, everything below is theatre.
// ══════════════════════════════════════════════════════════════════════════════

const TASK_VERBS = [
  'task.assigned', 'task.watching', 'task.completed', 'task.cancelled', 'task.removed', 'task.deleted',
  // Spec B slice 3. The seventh, and the one most at risk of the silent failure this whole
  // file exists to catch: nothing about a comment endpoint that forgets to emit looks broken.
  'task.commented',
] as const;

describe('templates: the seven task verbs are REGISTERED', () => {
  it.each(TASK_VERBS)('isKnownVerb(%s) is true', (verb) => {
    // emit() returns [] on an unknown verb without throwing or logging, so a false here
    // would mean the whole feature no-ops in production with a green suite.
    expect(isKnownVerb(verb)).toBe(true);
  });

  it.each(TASK_VERBS)('%s renders as a TASK feed item that needs no action', (verb) => {
    const t = renderTemplate(verb, { object_label: TITLE, task_number: 'T00001' });
    expect(t).toMatchObject({
      category: 'TASK',
      object_type: 'TASK',
      priority: 'FEED',
      needs_action: false,
      action_type: null,
    });
    expect(t.title).toContain(TITLE);
  });

  it('task.deleted carries the snapshot in its body — its object is already gone', () => {
    const t = renderTemplate('task.deleted', { object_label: TITLE, task_number: 'T00001' });
    expect(t.title).toContain(TITLE);
    expect(t.body).toContain('T00001');
  });

  it('task.cancelled does not read as a completion', () => {
    const t = renderTemplate('task.cancelled', { object_label: TITLE, task_number: 'T00001' });
    expect(t.title).toContain('cancelled');
    expect(t.title).not.toContain('completed');
  });

  it('task.due_soon / task.overdue stay DEFERRED — they need a cron that does not exist', () => {
    expect(isKnownVerb('task.due_soon')).toBe(false);
    expect(isKnownVerb('task.overdue')).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveRecipients — the routing matrix, pure
// ══════════════════════════════════════════════════════════════════════════════

const ROLE_HOLDERS = { ADMIN: [ACTOR], DISPATCHER: [DANA], SALES: [WATCHER], TECHNICIAN: [SAGIV] };
const resolve = (verb: string, entity: Record<string, unknown>, actorId: string | null = ACTOR) =>
  resolveRecipients({ verb, organizationId: ALPHA_ORG_ID, actorId, entity, roleHolders: ROLE_HOLDERS })
    .map((r) => r.userId).sort();

describe('resolveRecipients — task routing', () => {
  it('task.assigned goes to the newly ADDED assignees only', () => {
    expect(resolve('task.assigned', { added_assignee_ids: [DANA, SAGIV], assignee_ids: [WATCHER] }))
      .toEqual([DANA, SAGIV].sort());
  });

  it('task.watching goes to the newly ADDED watchers only', () => {
    expect(resolve('task.watching', { added_watcher_ids: [WATCHER] })).toEqual([WATCHER]);
  });

  it('task.completed goes to the OTHER assignees + the watchers, never the completer', () => {
    // The "never the completer" half is dedupe()'s actor drop, not a special case — which is
    // exactly why the caller can hand over the whole roster including the actor.
    expect(resolve('task.completed', { assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }))
      .toEqual([DANA, WATCHER].sort());
  });

  it('task.cancelled goes to the OTHER assignees + the watchers, never the canceller', () => {
    expect(resolve('task.cancelled', { assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }))
      .toEqual([DANA, WATCHER].sort());
  });

  it('task.removed goes to the removed person only', () => {
    expect(resolve('task.removed', { removed_ids: [SAGIV], assignee_ids: [DANA] })).toEqual([SAGIV]);
  });

  // Spec B slice 3. Same routing as task.completed, and deliberately so: a comment is
  // addressed to the people carrying the work and the people following it.
  it('task.commented goes to assignees + watchers, never the commenter', () => {
    expect(resolve('task.commented', { assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }))
      .toEqual([DANA, WATCHER].sort());
  });

  it('task.commented notifies the whole task when the commenter is not on it', () => {
    // The commenter has access to the task without being named on it (an admin, say).
    // Nobody on the task is the actor, so nobody is dropped.
    expect(resolve('task.commented', { assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] }))
      .toEqual([DANA, SAGIV, WATCHER].sort());
  });

  it('task.deleted goes to assignees + watchers', () => {
    expect(resolve('task.deleted', { assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] }))
      .toEqual([DANA, SAGIV, WATCHER].sort());
  });

  it('resolves nobody when the actor is the only person on the task', () => {
    expect(resolve('task.completed', { assignee_ids: [ACTOR], watcher_ids: [] })).toEqual([]);
  });

  it('nothing is FEED by accident and nothing needs action', () => {
    const specs = resolveRecipients({
      verb: 'task.assigned', organizationId: ALPHA_ORG_ID, actorId: null,
      entity: { added_assignee_ids: [DANA, SAGIV] }, roleHolders: ROLE_HOLDERS,
    });
    expect(specs.every((s) => s.priority === 'FEED' && s.needs_action === false)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// §9 guard 1 — ROW-LEVEL, through the real controller and the real emit()
// ══════════════════════════════════════════════════════════════════════════════

describe('POST /api/tasks — notification ROWS', () => {
  it('writes recipient rows for exactly the two assignees and the one watcher', async () => {
    mockPrisma.task.create.mockResolvedValue(
      taskRow({ assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).post('/api/tasks').set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] });

    expect(res.status).toBe(201);
    expect(recipientsOf('task.assigned')).toEqual([DANA, SAGIV].sort());
    expect(recipientsOf('task.watching')).toEqual([WATCHER]);

    // Every row is a FEED item with no pending action (design §5).
    expect(rowsFor('task.assigned').every((r) => r.priority === 'FEED' && r.needs_action === false)).toBe(true);

    // The event row points at the task and is labelled with its TITLE, not its number.
    expect(eventFor('task.assigned')).toMatchObject({
      category: 'TASK', object_type: 'TASK', object_id: TASK_ID, object_label: TITLE,
      priority: 'FEED', needs_action: false, action_type: null,
    });
  });

  it('never notifies the actor about their own action', async () => {
    mockPrisma.task.create.mockResolvedValue(taskRow({ assignee_ids: [ACTOR, DANA] }));

    const res = await request(app).post('/api/tasks').set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [ACTOR, DANA] });

    expect(res.status).toBe(201);
    expect(recipientsOf('task.assigned')).toEqual([DANA]);
    expect(rowsFor('task.assigned').map((r) => r.recipient_id)).not.toContain(ACTOR);
  });

  it('a solo self-assigned to-do notifies nobody at all', async () => {
    mockPrisma.task.create.mockResolvedValue(taskRow({ assignee_ids: [ACTOR] }));

    const res = await request(app).post('/api/tasks').set(authHeader('admin'))
      .send({ title: TITLE });

    expect(res.status).toBe(201);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/tasks/:id — notification ROWS', () => {
  it('an ADDED assignee is notified; the one already on the task is not', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [DANA] }));
    mockPrisma.task.update.mockResolvedValue(taskRow({ assignee_ids: [DANA, SAGIV] }));

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ assignee_ids: [DANA, SAGIV] });

    expect(res.status).toBe(200);
    expect(recipientsOf('task.assigned')).toEqual([SAGIV]);
    // Re-sending a name that was already there must not re-announce it.
    expect(recipientsOf('task.assigned')).not.toContain(DANA);
  });

  it('re-sending the SAME roster notifies nobody (membership diff, not a reference compare)', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [DANA], watcher_ids: [WATCHER] }));
    mockPrisma.task.update.mockResolvedValue(taskRow({ assignee_ids: [DANA], watcher_ids: [WATCHER] }));

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ title: 'retitled', assignee_ids: [DANA], watcher_ids: [WATCHER] });

    expect(res.status).toBe(200);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('task.removed goes to the removed person ONLY', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [DANA, SAGIV] }));
    mockPrisma.task.update.mockResolvedValue(taskRow({ assignee_ids: [DANA] }));

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ assignee_ids: [DANA] });

    expect(res.status).toBe(200);
    expect(recipientsOf('task.removed')).toEqual([SAGIV]);
    expect(notifRows.size).toBe(1);   // no spurious task.assigned for the survivor
  });

  it('a dropped WATCHER is a removal too — both lists feed one task.removed', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] }));
    mockPrisma.task.update.mockResolvedValue(taskRow({ assignee_ids: [DANA], watcher_ids: [] }));

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ assignee_ids: [DANA], watcher_ids: [] });

    expect(res.status).toBe(200);
    expect(recipientsOf('task.removed')).toEqual([SAGIV, WATCHER].sort());
  });

  it('task.completed reaches the other assignees and the watchers, but not the completer', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'TODO', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );
    mockPrisma.task.update.mockResolvedValue(
      taskRow({ status: 'DONE', completed_at: new Date(), assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ status: 'DONE' });

    expect(res.status).toBe(200);
    expect(recipientsOf('task.completed')).toEqual([DANA, WATCHER].sort());
    expect(recipientsOf('task.completed')).not.toContain(ACTOR);
  });

  it('re-saving a task that is ALREADY done announces nothing (a flip, not a state)', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'DONE', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );
    mockPrisma.task.update.mockResolvedValue(
      taskRow({ status: 'DONE', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ status: 'DONE' });

    expect(res.status).toBe(200);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  // ── Issue 03: cancellation ──────────────────────────────────────────────────
  it('task.cancelled reaches the other assignees and the watchers, but not the canceller', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'IN_PROGRESS', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );
    mockPrisma.task.update.mockResolvedValue(
      taskRow({ status: 'CANCELLED', completed_at: null, assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(200);
    // ROW-level, not a mocked emit: an unregistered verb writes nothing and fails right here.
    expect(recipientsOf('task.cancelled')).toEqual([DANA, WATCHER].sort());
    expect(recipientsOf('task.cancelled')).not.toContain(ACTOR);
    expect(rowsFor('task.cancelled').every((r) => r.priority === 'FEED' && r.needs_action === false)).toBe(true);
    expect(eventFor('task.cancelled')).toMatchObject({
      category: 'TASK', object_type: 'TASK', object_id: TASK_ID, object_label: TITLE,
    });
  });

  it('task.completed does NOT fire on a cancellation', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'TODO', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );
    mockPrisma.task.update.mockResolvedValue(
      taskRow({ status: 'CANCELLED', completed_at: null, assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );

    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin')).send({ status: 'CANCELLED' });

    // The pin: exactly one event, and it is not the completion one. Telling DANA the task was
    // completed when it was abandoned is the lie this whole status exists to end.
    expect([...notifRows.values()].map((n) => n.verb)).toEqual(['task.cancelled']);
    expect(recipientsOf('task.completed')).toEqual([]);
  });

  it('re-saving a task that is ALREADY cancelled announces nothing (a flip, not a state)', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'CANCELLED', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );
    mockPrisma.task.update.mockResolvedValue(
      taskRow({ status: 'CANCELLED', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ status: 'CANCELLED' });

    expect(res.status).toBe(200);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('REOPENING a cancelled task announces nothing; no verb fires on the way back', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ status: 'CANCELLED', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );
    mockPrisma.task.update.mockResolvedValue(
      taskRow({ status: 'TODO', assignee_ids: [ACTOR, DANA], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ status: 'TODO' });

    expect(res.status).toBe(200);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });

  it('emits POST-COMMIT — the row is written before any notification is (#271)', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [DANA] }));
    mockPrisma.task.update.mockResolvedValue(taskRow({ assignee_ids: [DANA, SAGIV] }));

    await request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('admin'))
      .send({ assignee_ids: [DANA, SAGIV] });

    expect(mockPrisma.task.update.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.notification.create.mock.invocationCallOrder[0]);
  });
});

// ── Spec B slice 3: commenting on a task ─────────────────────────────────────
//
// The comment endpoint wrote a note and a timeline entry and told nobody. These are
// ROW-LEVEL, through the real route and the real emit(): an unregistered verb, a missing
// recipient case or a forgotten emit all write nothing and fail right here.

const NOTE_ID = 'bb000000-0000-0000-0000-0000000000c1';

const noteRow = (over: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  entity_type: 'TASK',
  entity_id: TASK_ID,
  content: 'Which panel is it behind?',
  created_by: ACTOR,
  organization_id: ALPHA_ORG_ID,
  created_at: new Date('2026-08-28T15:00:00.000Z'),
  ...over,
});

describe('POST /api/tasks/:id/comments - notification ROWS', () => {
  it('writes recipient rows for every assignee and watcher, and none for the commenter', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [ACTOR, DANA, SAGIV], watcher_ids: [WATCHER] }),
    );
    mockPrisma.note.create.mockResolvedValue(noteRow());

    const res = await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin'))
      .send({ body: 'Which panel is it behind?' });

    expect(res.status).toBe(201);
    expect(recipientsOf('task.commented')).toEqual([DANA, SAGIV, WATCHER].sort());
    expect(recipientsOf('task.commented')).not.toContain(ACTOR);
    expect(rowsFor('task.commented').every((r) => r.priority === 'FEED' && r.needs_action === false)).toBe(true);
    // Clicking it opens THIS task: the event carries the task id, and the frontend routes
    // every TASK-object notification by object id (NotificationItem.tsx).
    expect(eventFor('task.commented')).toMatchObject({
      category: 'TASK', object_type: 'TASK', object_id: TASK_ID, object_label: TITLE,
      priority: 'FEED', needs_action: false, action_type: null,
    });
  });

  it('a comment by someone NOT on the task still reaches the assignees and watchers', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] }),
    );
    mockPrisma.note.create.mockResolvedValue(noteRow());

    const res = await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin'))
      .send({ body: 'Parts are in.' });

    expect(res.status).toBe(201);
    expect(recipientsOf('task.commented')).toEqual([DANA, SAGIV, WATCHER].sort());
  });

  it('commenting on your own solo task notifies nobody at all', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [ACTOR], watcher_ids: [] }));
    mockPrisma.note.create.mockResolvedValue(noteRow());

    const res = await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin'))
      .send({ body: 'note to self' });

    expect(res.status).toBe(201);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
    expect(mockPrisma.notificationRecipient.createMany).not.toHaveBeenCalled();
  });

  it('emits POST-COMMIT - the note is written before any notification is (#271)', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskRow({ assignee_ids: [DANA], watcher_ids: [] }));
    mockPrisma.note.create.mockResolvedValue(noteRow());

    await request(app).post(`/api/tasks/${TASK_ID}/comments`).set(authHeader('admin'))
      .send({ body: 'on my way' });

    expect(mockPrisma.note.create.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.notification.create.mock.invocationCallOrder[0]);
  });
});

describe('DELETE /api/tasks/:id — notification ROWS', () => {
  it('notifies every assignee and watcher off a SNAPSHOT taken before the delete', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ created_by: ACTOR, assignee_ids: [DANA, SAGIV], watcher_ids: [WATCHER] }),
    );

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(recipientsOf('task.deleted')).toEqual([DANA, SAGIV, WATCHER].sort());

    // The label and body are the snapshot — nothing re-reads the row, because there is no
    // row: the task delete runs BEFORE the notification is written, and `findFirst` (the only
    // read of the task) ran exactly once, before the transaction.
    expect(eventFor('task.deleted')).toMatchObject({ object_id: TASK_ID, object_label: TITLE });
    expect(eventFor('task.deleted').body).toContain('T00001');
    expect(mockPrisma.task.deleteMany.mock.invocationCallOrder[0])
      .toBeLessThan(mockPrisma.notification.create.mock.invocationCallOrder[0]);
    expect(mockPrisma.task.findFirst).toHaveBeenCalledTimes(1);
  });

  it('deleting a solo self-assigned to-do notifies nobody', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(
      taskRow({ created_by: ACTOR, assignee_ids: [ACTOR], watcher_ids: [] }),
    );

    const res = await request(app).delete(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(204);
    expect(mockPrisma.notification.create).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// Passthrough proof — TASK is deliberately absent from filterByAccess's scope map
// ══════════════════════════════════════════════════════════════════════════════

describe('filterByAccess — TASK recipients are NOT row-scope filtered', () => {
  it('a TECHNICIAN assignee survives to a written row', async () => {
    // SAGIV is a TECHNICIAN with no read grant over anything this task links to. Being named
    // on the task is what grants him visibility (design §4), so the recipient list is already
    // the access decision — a scope filter here would drop the very person the task is for.
    mockPrisma.task.create.mockResolvedValue(taskRow({ assignee_ids: [SAGIV] }));

    const res = await request(app).post('/api/tasks').set(authHeader('admin'))
      .send({ title: TITLE, assignee_ids: [SAGIV] });

    expect(res.status).toBe(201);
    expect(recipientsOf('task.assigned')).toEqual([SAGIV]);
  });
});
