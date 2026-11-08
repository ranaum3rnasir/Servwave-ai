import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID } from './helpers';

// ─── Linked-entity label redaction (#01) ──────────────────────────────────────────────────
//
// A task's `linked_entity_label` used to be resolved scoped ONLY by organization, so being a
// task's assignee or watcher was enough to read the job number + job type, the lead or estimate
// number, or the customer's name of an entity the reader cannot open. Multi-assign made that
// state routine to reach: handing someone a task is now an ordinary action.
//
// The fix resolves labels through the SAME scope fragment `canAccessLinkedEntity` uses
// (`entityAccessScope`), inside the label query itself - so redaction is one query per entity
// type for a whole list, not a probe per row. Out of scope → a neutral placeholder, never a
// blank: the task must still read as attached to something.

const mockPrisma = prisma as unknown as {
  task: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  taskSubtask: { findMany: ReturnType<typeof vi.fn> };
  note: { findMany: ReturnType<typeof vi.fn> };
  timelineEvent: { findMany: ReturnType<typeof vi.fn> };
  user: { findMany: ReturnType<typeof vi.fn> };
  job: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  lead: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  estimate: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  customer: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
};

const JOB_ID = '10000000-0000-0000-0000-000000000001';
const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000009';
const TASK_ID = 'aa000000-0000-0000-0000-000000000001';
const OTHER_USER_ID = '00000000-0000-0000-0000-000000000099';

const JOB_ROW = { id: JOB_ID, job_number: 'J00934', job_type: 'Access Control' };
const JOB_LABEL = 'J00934 · Access Control';

const TASK = {
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
  tags: [] as string[],
  completed_at: null,
  created_by: OTHER_USER_ID,
  created_at: new Date('2026-06-17'),
  updated_at: new Date('2026-06-17'),
  watcher_ids: [] as string[],
  _count: { subtasks: 0 },
};

/** The label query selects the number; the row-access probe selects only `id`. */
const isLabelQuery = (args: { select?: Record<string, unknown> }) => !!args.select?.job_number;

/** Job rows visible to the caller. `[]` = the linked job is outside their read scope. */
function jobsInScope(rows: typeof JOB_ROW[]) {
  mockPrisma.job.findMany.mockImplementation((args: { select?: Record<string, unknown> }) =>
    Promise.resolve(isLabelQuery(args) ? rows : rows.map((r) => ({ id: r.id }))),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();

  mockPrisma.task.findMany.mockResolvedValue([TASK]);
  mockPrisma.task.findFirst.mockResolvedValue(TASK);
  mockPrisma.taskSubtask.findMany.mockResolvedValue([]);
  mockPrisma.note.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.customer.findFirst.mockResolvedValue(null);
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.lead.findFirst.mockResolvedValue(null);
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.estimate.findFirst.mockResolvedValue(null);
  jobsInScope([]);
});

// ══════════════════════════════════════════════════════════════════════
// 1. No entity access → the placeholder, on both read paths
// ══════════════════════════════════════════════════════════════════════
describe('reader without access to the linked entity', () => {
  it('an ASSIGNEE gets the placeholder, not the job number, on GET /api/tasks', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue([{ ...TASK, assignee_ids: [TEST_USERS.technician.id] }]);
    jobsInScope([]); // the job is not one of theirs

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBe('Restricted job');
    expect(res.body.tasks[0].linked_entity_redacted).toBe(true);
    // Redact, do NOT omit - the link itself still travels, so the card still renders as attached.
    expect(res.body.tasks[0].linked_entity_type).toBe('JOB');
    expect(res.body.tasks[0].linked_entity_id).toBe(JOB_ID);
    expect(JSON.stringify(res.body)).not.toContain('J00934');
    expect(JSON.stringify(res.body)).not.toContain('Access Control');
  });

  it('a WATCHER gets the placeholder on GET /api/tasks/:id', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK, watcher_ids: [TEST_USERS.technician.id] });
    jobsInScope([]);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.task.linked_entity_label).toBe('Restricted job');
    expect(res.body.task.linked_entity_redacted).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain('J00934');
  });

  // TECHNICIAN holds no `read Customer` grant at all, so this fails closed. #2041 — Customer is
  // now a real ScopeResource; the missing grant resolves to MATCH_NOTHING (`id:{in:[]}}`), a
  // real (if wasted) fragment that still issues one batched query per type — unlike the deleted
  // CASL-subject branch's free `null` skip — and that query correctly returns nothing.
  it('a customer link redacts to the customer placeholder (MATCH_NOTHING query returns nothing)', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue([{
      ...TASK,
      assignee_ids: [TEST_USERS.technician.id],
      linked_entity_type: 'CUSTOMER',
      linked_entity_id: CUSTOMER_ID,
    }]);
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBe('Restricted customer');
    expect(res.body.tasks[0].linked_entity_redacted).toBe(true);
    if (mockPrisma.customer.findMany.mock.calls.length) {
      expect(JSON.stringify(mockPrisma.customer.findMany.mock.calls[0][0].where)).toContain('"in":[]');
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 2. WITH access → the label is exactly what it was before
// ══════════════════════════════════════════════════════════════════════
describe('reader who can access the linked entity', () => {
  it('sees the full label unchanged', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue([{ ...TASK, assignee_ids: [TEST_USERS.technician.id] }]);
    jobsInScope([JOB_ROW]); // the job IS within their read scope

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBe(JOB_LABEL);
    expect(res.body.tasks[0].linked_entity_redacted).toBe(false);
  });

  it('the label query carries the caller read scope, not just the tenant', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue([{ ...TASK, assignee_ids: [TEST_USERS.technician.id] }]);
    jobsInScope([JOB_ROW]);

    await request(app).get('/api/tasks').set(authHeader('technician'));

    const call = mockPrisma.job.findMany.mock.calls.find((c) => isLabelQuery(c[0]))![0];
    expect(call.where).toMatchObject({ id: { in: [JOB_ID] }, organization_id: ALPHA_ORG_ID });
    // TECHNICIAN's `read Job` grant is conditional, so the fragment must add more than the tenant.
    expect(Object.keys(call.where).length).toBeGreaterThan(2);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 3. ADMIN is unaffected
// ══════════════════════════════════════════════════════════════════════
describe('ADMIN', () => {
  it('sees the full label and an unscoped (tenant-only) label query', async () => {
    mockAuthAs('admin');
    jobsInScope([JOB_ROW]);

    const res = await request(app).get('/api/tasks').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBe(JOB_LABEL);
    expect(res.body.tasks[0].linked_entity_redacted).toBe(false);
    const call = mockPrisma.job.findMany.mock.calls.find((c) => isLabelQuery(c[0]))![0];
    expect(call.where).toEqual({ id: { in: [JOB_ID] }, organization_id: ALPHA_ORG_ID });
  });

  // An unrestricted scope cannot mean "hidden", so a dangling link must stay null, not become
  // the placeholder - otherwise a deleted job would read to an admin as one they may not open.
  it('a link to a row that is gone stays null and is NOT reported as redacted', async () => {
    mockAuthAs('admin');
    jobsInScope([]);

    const res = await request(app).get('/api/tasks').set(authHeader('admin'));

    expect(res.body.tasks[0].linked_entity_label).toBeNull();
    expect(res.body.tasks[0].linked_entity_redacted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 4. Batching - the acceptance criterion the list path exists to protect
// ══════════════════════════════════════════════════════════════════════
describe('batching', () => {
  it('resolves N tasks across N jobs with ONE job query, not one per task', async () => {
    mockAuthAs('technician');
    const ids = Array.from({ length: 25 }, (_, i) => `10000000-0000-0000-0000-0000000${String(i).padStart(5, '0')}`);
    mockPrisma.task.findMany.mockResolvedValue(
      ids.map((jobId, i) => ({
        ...TASK,
        id: `aa000000-0000-0000-0000-0000000${String(i).padStart(5, '0')}`,
        assignee_ids: [TEST_USERS.technician.id],
        linked_entity_id: jobId,
      })),
    );
    // Only the first job is in scope; the other 24 must all come back redacted.
    jobsInScope([{ ...JOB_ROW, id: ids[0] }]);

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.findMany.mock.calls[0][0].where.id.in).toHaveLength(25);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(res.body.tasks[0].linked_entity_label).toBe(JOB_LABEL);
    expect(res.body.tasks.filter((t: { linked_entity_redacted: boolean }) => t.linked_entity_redacted)).toHaveLength(24);
  });

  it('de-duplicates: many tasks on ONE job still send one id', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => ({
        ...TASK,
        id: `aa000000-0000-0000-0000-0000000${String(i).padStart(5, '0')}`,
        assignee_ids: [TEST_USERS.technician.id],
      })),
    );
    jobsInScope([JOB_ROW]);

    await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(mockPrisma.job.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.findMany.mock.calls[0][0].where.id.in).toEqual([JOB_ID]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 5. The entity-page tasks tab is untouched
// ══════════════════════════════════════════════════════════════════════
describe('tasks tab on an entity page', () => {
  it('nothing redacts: reaching the tab already proved access to the entity', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // the tab's own #245 gate
    jobsInScope([JOB_ROW]);

    const res = await request(app)
      .get(`/api/tasks?linked_entity_type=JOB&linked_entity_id=${JOB_ID}`)
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBe(JOB_LABEL);
    expect(res.body.tasks[0].linked_entity_redacted).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 6. QA additions - the shapes section 4 does not cover
// ══════════════════════════════════════════════════════════════════════
describe('batching across MIXED entity types', () => {
  it('issues at most ONE query per type and no per-row probe', async () => {
    mockAuthAs('technician');
    const me = TEST_USERS.technician.id;
    mockPrisma.task.findMany.mockResolvedValue([
      { ...TASK, id: 'aa000000-0000-0000-0000-00000000000a', assignee_ids: [me] },
      { ...TASK, id: 'aa000000-0000-0000-0000-00000000000b', assignee_ids: [me],
        linked_entity_type: 'LEAD',     linked_entity_id: '20000000-0000-0000-0000-000000000001' },
      { ...TASK, id: 'aa000000-0000-0000-0000-00000000000c', assignee_ids: [me],
        linked_entity_type: 'ESTIMATE', linked_entity_id: '30000000-0000-0000-0000-000000000001' },
      { ...TASK, id: 'aa000000-0000-0000-0000-00000000000d', assignee_ids: [me],
        linked_entity_type: 'CUSTOMER', linked_entity_id: CUSTOMER_ID },
      // A second JOB task on the SAME job: it must not add a query or a second id.
      { ...TASK, id: 'aa000000-0000-0000-0000-00000000000e', assignee_ids: [me] },
    ]);
    jobsInScope([JOB_ROW]);
    mockPrisma.customer.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.job.findMany.mock.calls[0][0].where.id.in).toEqual([JOB_ID]);
    expect(mockPrisma.lead.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.estimate.findMany).toHaveBeenCalledTimes(1);
    // #2041 — TECHNICIAN holds no `read Customer` at all, so that type resolves to MATCH_NOTHING
    // (a real, if wasted, fragment now that Customer is a ScopeResource) — still batched to AT
    // MOST ONE query for the whole page, never a per-row probe, which is what this test actually
    // guards.
    expect(mockPrisma.customer.findMany.mock.calls.length).toBeLessThanOrEqual(1);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.estimate.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.customer.findFirst).not.toHaveBeenCalled();

    const byId = Object.fromEntries(
      res.body.tasks.map((t: { id: string; linked_entity_label: string | null; linked_entity_redacted: boolean }) =>
        [t.id, [t.linked_entity_label, t.linked_entity_redacted]]),
    );
    expect(byId['aa000000-0000-0000-0000-00000000000a']).toEqual([JOB_LABEL, false]);
    expect(byId['aa000000-0000-0000-0000-00000000000e']).toEqual([JOB_LABEL, false]);
    expect(byId['aa000000-0000-0000-0000-00000000000b']).toEqual(['Restricted lead', true]);
    expect(byId['aa000000-0000-0000-0000-00000000000c']).toEqual(['Restricted estimate', true]);
    expect(byId['aa000000-0000-0000-0000-00000000000d']).toEqual(['Restricted customer', true]);
  });

  it('a page of UNLINKED tasks issues no entity query at all', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue([
      { ...TASK, assignee_ids: [TEST_USERS.technician.id], linked_entity_type: null, linked_entity_id: null },
    ]);

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBeNull();
    expect(res.body.tasks[0].linked_entity_redacted).toBe(false);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.estimate.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  // `linked_entity_type` is a zod enum on write, but a legacy row can still carry something else.
  // It must fail CLOSED with no query and no crash, not fall through to a bare label.
  it('an unknown linked_entity_type fails closed with the generic placeholder and no query', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findMany.mockResolvedValue([
      { ...TASK, assignee_ids: [TEST_USERS.technician.id], linked_entity_type: 'INVOICE' },
    ]);

    const res = await request(app).get('/api/tasks').set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.tasks[0].linked_entity_label).toBe('Restricted record');
    expect(res.body.tasks[0].linked_entity_redacted).toBe(true);
    expect(mockPrisma.job.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 7. QA additions - canAccessLinkedEntity did not narrow
// ══════════════════════════════════════════════════════════════════════
describe('canAccessLinkedEntity after the entityAccessScope extraction', () => {
  // The linked-entity fallthrough in canAccessTask is what keeps a technician reading a task on
  // a job they are on but are neither assignee nor watcher of. If the probe narrowed, they 403.
  it('a technician who is NEITHER assignee nor watcher still reads a task on a job they can open', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK, assignee_ids: [OTHER_USER_ID], watcher_ids: [] });
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID }); // the job IS within their scope
    jobsInScope([JOB_ROW]);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(mockPrisma.job.findFirst).toHaveBeenCalled();
    expect(res.body.task.linked_entity_label).toBe(JOB_LABEL);
    expect(res.body.task.linked_entity_redacted).toBe(false);
  });

  it('and is denied when the job is outside their scope', async () => {
    mockAuthAs('technician');
    mockPrisma.task.findFirst.mockResolvedValue({ ...TASK, assignee_ids: [OTHER_USER_ID], watcher_ids: [] });
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/tasks/${TASK_ID}`).set(authHeader('technician'));

    expect(res.status).toBe(403);
  });

  // Unknown type + CUSTOMER-without-the-grant must both refuse WITHOUT a query.
  it('POST /api/tasks refuses an unknown link type with no probe', async () => {
    mockAuthAs('technician');
    const res = await request(app).post('/api/tasks').set(authHeader('technician')).send({
      title: 'x', linked_entity_type: 'INVOICE', linked_entity_id: JOB_ID,
    });
    expect(res.status).toBe(400); // rejected by the zod enum before the probe
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('POST /api/tasks refuses a CUSTOMER link for a role with no read Customer (MATCH_NOTHING probe never matches)', async () => {
    mockAuthAs('technician');
    // #2041 — Customer is now a real ScopeResource; the missing grant resolves to MATCH_NOTHING
    // (a real, if wasted, fragment), so the probe DOES run — unlike the deleted CASL-subject
    // branch's free `null` skip — and Postgres (mocked here as `null`) correctly finds nothing.
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    const res = await request(app).post('/api/tasks').set(authHeader('technician')).send({
      title: 'x', linked_entity_type: 'CUSTOMER', linked_entity_id: CUSTOMER_ID,
    });
    expect(res.status).toBe(403);
  });
});
