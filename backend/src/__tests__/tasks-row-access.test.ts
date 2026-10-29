import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID, stubTaskRowLocks } from './helpers';

// ─── Per-row (own-or-linked) access on /api/tasks* (#245, last open criterion) ────────────
//
// Task grants are SUBJECT-LEVEL (defaultGrants: unconditional read/create/update for
// SALES/DISPATCHER/TECHNICIAN), so canDo() passes for ANY org task. The row policy —
// "own (owner/creator/watcher) or linked-to an entity within the caller's read scope" —
// cannot be expressed in CASL (polymorphic link + nested to-many matcher throws), so it is
// enforced in SQL: canAccessTask/canAccessLinkedEntity run a tenant+scope findFirst on the
// linked entity (the same scopeWhereForReq spine as canAccessRow). ADMIN short-circuits
// with no scope query.

const mockPrisma = prisma as unknown as {
  task: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  taskSubtask: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  note: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  timelineEvent: {
    findMany: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  user: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  lead: { findFirst: ReturnType<typeof vi.fn> };
  estimate: { findFirst: ReturnType<typeof vi.fn> };
  customer: { findFirst: ReturnType<typeof vi.fn>; findMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const JOB_ID = '10000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000009';
const TASK_ID = 'aa000000-0000-0000-0000-000000000001';
const SUBTASK_ID = 'bb000000-0000-0000-0000-000000000002';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000099';

// A task assigned to / created by SOMEONE ELSE, linked to a JOB — the caller is never a principal.
const LINKED_TASK = {
  id: TASK_ID,
  task_number: 'T00001',
  organization_id: ALPHA_ORG_ID,
  title: 'Inspect compressor',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [OTHER_USER_ID] as string[],
  due_at: null,
  linked_entity_type: 'JOB',
  linked_entity_id: JOB_ID,
  tags: [],
  completed_at: null,
  created_by: OTHER_USER_ID,
  created_at: new Date('2026-06-17'),
  updated_at: new Date('2026-06-17'),
  watcher_ids: [] as string[],
  _count: { subtasks: 0 },
};

const UNLINKED_TASK = { ...LINKED_TASK, linked_entity_type: null, linked_entity_id: null };
const CUSTOMER_TASK = { ...LINKED_TASK, linked_entity_type: 'CUSTOMER', linked_entity_id: CUSTOMER_ID };

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();

  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.task.findFirst.mockResolvedValue(LINKED_TASK);
  mockPrisma.task.create.mockResolvedValue(LINKED_TASK);
  mockPrisma.task.update.mockResolvedValue(LINKED_TASK);
  mockPrisma.task.deleteMany.mockResolvedValue({ count: 1 });
  stubTaskRowLocks();
  mockPrisma.taskSubtask.findMany.mockResolvedValue([]);
  mockPrisma.taskSubtask.findFirst.mockResolvedValue({ id: SUBTASK_ID, task_id: TASK_ID, text: 'x', done: false, position: 0 });
  mockPrisma.taskSubtask.create.mockResolvedValue({ id: SUBTASK_ID, task_id: TASK_ID, text: 'x', done: false, position: 0 });
  mockPrisma.taskSubtask.update.mockResolvedValue({ id: SUBTASK_ID, task_id: TASK_ID, text: 'x', done: true, position: 0 });
  mockPrisma.taskSubtask.delete.mockResolvedValue({ id: SUBTASK_ID });
  mockPrisma.note.findMany.mockResolvedValue([]);
  mockPrisma.note.create.mockResolvedValue({
    id: 'note-1', content: 'hi', created_by: TEST_USERS.sales.id, created_at: new Date('2026-06-18'),
    entity_type: 'TASK', entity_id: TASK_ID, organization_id: ALPHA_ORG_ID,
  });
  mockPrisma.note.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.timelineEvent.deleteMany.mockResolvedValue({ count: 0 });
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.job.findMany.mockResolvedValue([]);
  mockPrisma.customer.findMany.mockResolvedValue([]);
  // Linked-entity scope probes default to "not visible" — each test overrides as needed.
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.lead.findFirst.mockResolvedValue(null);
  mockPrisma.estimate.findFirst.mockResolvedValue(null);
  mockPrisma.customer.findFirst.mockResolvedValue(null);
  mockPrisma.$transaction.mockImplementation((fn: (tx: typeof prisma) => unknown) => fn(prisma));
});

// ═══════════════════════════════════════════════════════════════════════
// [1] Non-principal + linked entity OUT of scope → 403 on read
// ═══════════════════════════════════════════════════════════════════════
describe('instance access — non-principal, out-of-scope link', () => {
  it('SALES (not owner/creator/watcher, job out of scope) GET /api/tasks/:id → 403', async () => {
    mockAuthAs('sales');
    // OWN_JOB_VIA_ESTIMATE scope probe misses → not visible.
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
  });

  // [2] Same caller, mutating routes
  it('SALES PATCH /api/tasks/:id → 403 (task never updated)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('sales'))
      .send({ title: 'hijack' });

    expect(res.status).toBe(403);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('SALES DELETE /api/tasks/:id/subtasks/:subtaskId → 403 (subtask never deleted)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/tasks/${TASK_ID}/subtasks/${SUBTASK_ID}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.taskSubtask.delete).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [3] Linked entity IN scope → access even when not a principal
// ═══════════════════════════════════════════════════════════════════════
describe('instance access — linked entity within scope', () => {
  it('TECHNICIAN (not principal) PATCH on a task linked to their assigned job → 200', async () => {
    mockAuthAs('technician');
    // OWN_JOB scope probe hits (technician is an assignee).
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .patch(`/api/tasks/${TASK_ID}`)
      .set(authHeader('technician'))
      .send({ status: 'IN_PROGRESS' });

    expect(res.status).toBe(200);
    expect(mockPrisma.task.update).toHaveBeenCalledTimes(1);
    // The probe is a tenant+scope findFirst on the LINKED entity.
    const probe = mockPrisma.job.findFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(probe.where).toMatchObject({ id: JOB_ID, organization_id: ALPHA_ORG_ID });
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [4] Principals: watcher can comment; the CREATOR is not a principal any more
// ═══════════════════════════════════════════════════════════════════════
describe('instance access — principals', () => {
  it('a watcher (watcher_ids includes user) POST /:id/comments → 201, no entity probe', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue({ ...LINKED_TASK, watcher_ids: [TEST_USERS.sales.id] });

    const res = await request(app)
      .post(`/api/tasks/${TASK_ID}/comments`)
      .set(authHeader('sales'))
      .send({ body: 'watching this' });

    expect(res.status).toBe(201);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  // INVERTED by the multi-assignee change. `created_by` is audit-only now (design §2/§4) and
  // grants nothing, so a creator who has been assigned away from an unlinked task loses it.
  // Unreachable in practice: create force-assigns, so the creator starts on every task they make.
  it('the creator (created_by = user) GET /:id → 403 once assigned away', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue({
      ...UNLINKED_TASK,
      created_by: TEST_USERS.sales.id,
      assignee_ids: [OTHER_USER_ID],
    });

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('an assignee (assignee_ids includes user) GET /:id → 200, no entity probe', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue({
      ...UNLINKED_TASK,
      assignee_ids: [OTHER_USER_ID, TEST_USERS.sales.id],
    });

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  // Design §9 — removal really removes. The row is unlinked, so nothing else can let them back in.
  it('a REMOVED assignee can no longer read the task → 403', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue({
      ...UNLINKED_TASK,
      created_by: TEST_USERS.sales.id,
      assignee_ids: [OTHER_USER_ID],
      watcher_ids: [],
    });

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('sales'));

    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [5] Unlinked task: non-principal → 403; ADMIN → 200 with NO scope query
// ═══════════════════════════════════════════════════════════════════════
describe('instance access — unlinked tasks + admin fast-path', () => {
  it('SALES on an unlinked task they are no principal of → 403', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue(UNLINKED_TASK);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('sales'));

    expect(res.status).toBe(403);
  });

  it('ADMIN on the same task → 200 and no scope probe on any entity', async () => {
    mockAuthAs('admin');
    mockPrisma.task.findFirst.mockResolvedValue(UNLINKED_TASK);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.estimate.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [6] POST /api/tasks — linking is gated by the same entity scope check
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/tasks — linked-entity gate', () => {
  it('SALES linking to a job outside their scope (or nonexistent) → 403, task never created', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('sales'))
      .send({ title: 'sneaky', linked_entity_type: 'JOB', linked_entity_id: JOB_ID });

    expect(res.status).toBe(403);
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
  });

  it('SALES linking to a job within their scope → 201', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .post('/api/tasks')
      .set(authHeader('sales'))
      .send({ title: 'legit', linked_entity_type: 'JOB', linked_entity_id: JOB_ID });

    expect(res.status).toBe(201);
    expect(mockPrisma.task.create).toHaveBeenCalledTimes(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [7] CUSTOMER-linked task: Customer row-scope (#2041 — was subject-level-only)
// ═══════════════════════════════════════════════════════════════════════
describe('CUSTOMER-linked tasks', () => {
  it('TECHNICIAN (no read:Customer grant at all) → 403; the MATCH_NOTHING probe still runs (never matches)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue(CUSTOMER_TASK);
    // #2041 — Customer is now a real ScopeResource, so a missing grant resolves to MATCH_NOTHING
    // (`id: { in: [] }`), a real (if wasted) fragment — unlike the deleted CASL-subject branch's
    // free `null` skip. The mock has to answer it the way real Postgres would: no match.
    mockPrisma.customer.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    const probe = mockPrisma.customer.findFirst.mock.calls[0]?.[0] as { where: Record<string, unknown> } | undefined;
    if (probe) expect(JSON.stringify(probe.where)).toContain('"in":[]');
  });

  it('SALES, the customer associated (created_by_id) and in tenant → 200', async () => {
    mockAuthAs('sales');
    mockPrisma.task.findFirst.mockResolvedValue(CUSTOMER_TASK);
    mockPrisma.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    const probe = mockPrisma.customer.findFirst.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(probe.where).toMatchObject({ id: CUSTOMER_ID, organization_id: ALPHA_ORG_ID });
    // #2041 — the where now ALSO carries SALES's row-scope OR (OWN_CUSTOMER), not just tenancy.
    expect(probe.where.OR).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [8] Entity-filtered list + summary require access to that entity
// ═══════════════════════════════════════════════════════════════════════
describe('GET /api/tasks + /summary with linked_entity params', () => {
  it('non-admin listing tasks of an inaccessible job → 403, tasks never queried', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/tasks?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it('non-admin summary of an inaccessible job → 403', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/tasks/summary?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it('non-admin with the job IN scope lists its tasks (200)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .get(`/api/tasks?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(mockPrisma.task.findMany).toHaveBeenCalledTimes(1);
  });

  it('ADMIN entity-filtered list needs no probe (200)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/tasks?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// [9] Unfiltered non-admin list — assignee OR watcher
// ═══════════════════════════════════════════════════════════════════════
describe('unfiltered non-admin list scope', () => {
  it('where carries OR [{assignee_ids has},{watcher_ids has}] and no created_by arm', async () => {
    mockAuthAs('sales');

    const res = await request(app).get('/api/tasks').set(authHeader('sales'));

    expect(res.status).toBe(200);
    const where = (mockPrisma.task.findMany.mock.calls[0][0] as { where: Record<string, unknown> }).where;
    expect(where.OR).toEqual([
      { assignee_ids: { has: TEST_USERS.sales.id } },
      { watcher_ids: { has: TEST_USERS.sales.id } },
    ]);
  });
});
