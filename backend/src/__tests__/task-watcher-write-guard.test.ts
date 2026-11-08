import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS, TEST_ORG } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// Task watcher WRITE GUARD (#1956) — `POST /api/tasks` and `PATCH /api/tasks/:id`.
//
// The rule stated executably, and written BEFORE the guard so a reviewer can read this file to
// decide whether the PRD was built. The picker is not the control; this is.
//
// THE TENANT CLAUSE IS REAL HERE. `user.findMany` below filters on `organization_id` exactly as
// Postgres would, rather than matching on id alone. That distinction is not academic in this
// repo: a cross-tenant case has previously passed against unfixed code because the mock ignored
// the tenant clause, so the cross-org case at the bottom would have been a false green.

const mockPrisma = prisma as any;

const DEPT_SALES = 'dddddddd-0000-0000-0000-00000000000a';
const DEPT_FIELD = 'dddddddd-0000-0000-0000-00000000000b';

const ADMIN = TEST_USERS.admin.id;
const SALES = TEST_USERS.sales.id;

const MATE = '11111111-0000-0000-0000-00000000000a';       // SALES, same department  → INSIDE
const FIELD_TECH = '11111111-0000-0000-0000-00000000000b'; // TECHNICIAN, other dept  → OUTSIDE
const OTHER_ADMIN = '11111111-0000-0000-0000-00000000000c';// ADMIN, other dept       → INSIDE
const FIELD_TECH_2 = '11111111-0000-0000-0000-00000000000e'; // TECHNICIAN, other dept  → OUTSIDE
const FOREIGN = '11111111-0000-0000-0000-00000000000d';    // another tenant entirely → REFUSED

const DIRECTORY = [
  { id: ADMIN, role: 'ADMIN', department_id: null, organization_id: ALPHA_ORG_ID, is_active: true },
  { id: SALES, role: 'SALES', department_id: DEPT_SALES, organization_id: ALPHA_ORG_ID, is_active: true },
  { id: MATE, role: 'SALES', department_id: DEPT_SALES, organization_id: ALPHA_ORG_ID, is_active: true },
  { id: FIELD_TECH, role: 'TECHNICIAN', department_id: DEPT_FIELD, organization_id: ALPHA_ORG_ID, is_active: true },
  { id: OTHER_ADMIN, role: 'ADMIN', department_id: DEPT_FIELD, organization_id: ALPHA_ORG_ID, is_active: true },
  { id: FIELD_TECH_2, role: 'TECHNICIAN', department_id: DEPT_FIELD, organization_id: ALPHA_ORG_ID, is_active: true },
  { id: FOREIGN, role: 'SALES', department_id: DEPT_SALES, organization_id: ORG_B_ID, is_active: true },
];

const TASK_ID = 'aa000000-0000-0000-0000-000000000001';

const taskFixture = (watcher_ids: string[] = []) => ({
  id: TASK_ID,
  task_number: 'T00001',
  organization_id: ALPHA_ORG_ID,
  title: 'Inspect compressor',
  description: '',
  status: 'TODO',
  priority: 'MEDIUM',
  assignee_ids: [SALES],
  due_at: null,
  linked_entity_type: null,
  linked_entity_id: null,
  tags: [],
  completed_at: null,
  created_by: SALES,
  created_at: new Date('2026-06-17'),
  updated_at: new Date('2026-06-17'),
  watcher_ids,
  _count: { subtasks: 0 },
});

/** Act as a TEST_USER carrying a real department, which is what the pool rule reads. */
function actingAs(key: keyof typeof TEST_USERS, departmentId: string | null) {
  mockAuthAs(key);
  mockPrisma.user.findUnique.mockImplementation((args: { where: { id: string } }) => {
    const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
    if (!match) return Promise.resolve(null);
    return Promise.resolve({
      ...match,
      department_id: match.id === TEST_USERS[key].id ? departmentId : null,
      organization: TEST_ORG,
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();
  mockPrisma.rolePermission.findMany.mockImplementation((a: any) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === a.where.role)));

  // THE REAL TENANT CLAUSE. Both `allActiveOrgMembers` and `watchersOutsidePool` come through
  // here; each gets exactly the rows Postgres would give it for the where it actually sent.
  mockPrisma.user.findMany.mockImplementation((args: any) => {
    const w = args.where ?? {};
    return Promise.resolve(
      DIRECTORY.filter((u) => {
        if (w.id?.in && !w.id.in.includes(u.id)) return false;
        if (w.organization_id && u.organization_id !== w.organization_id) return false;
        if (w.is_active !== undefined && u.is_active !== w.is_active) return false;
        return true;
      }),
    );
  });

  mockPrisma.task.findFirst.mockResolvedValue(taskFixture());
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.task.create.mockImplementation((args: any) => Promise.resolve({ ...taskFixture(), ...args.data }));
  mockPrisma.task.update.mockImplementation((args: any) => Promise.resolve({ ...taskFixture(), ...args.data }));
  mockPrisma.$transaction.mockImplementation((fn: any) => fn(prisma));
  mockPrisma.taskSubtask.findMany.mockResolvedValue([]);
  mockPrisma.note.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.job.findMany.mockResolvedValue([]);
});

const createWith = (watchers: string[]) =>
  request(app).post('/api/tasks').set(authHeader('sales')).send({
    title: 'Follow up',
    assignee_ids: [SALES],
    watcher_ids: watchers,
  });

const patchWith = (body: Record<string, unknown>) =>
  request(app).patch(`/api/tasks/${TASK_ID}`).set(authHeader('sales')).send(body);

describe('POST /api/tasks — watchers must fall inside the actor\'s pool', () => {
  it('REFUSES a watcher outside the pool with 403', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await createWith([FIELD_TECH]);
    expect(res.status).toBe(403);
    // A clear refusal, not a silent drop: the watcher must not be missing from a 201.
    expect(res.body.error).toMatch(/watcher/i);
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
  });

  it('ACCEPTS a colleague from the actor\'s own department', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await createWith([MATE]);
    expect(res.status).toBe(201);
    expect(mockPrisma.task.create.mock.calls[0][0].data.watcher_ids).toEqual([MATE]);
  });

  it('ACCEPTS an admin from any department — escalation without a permission change', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await createWith([OTHER_ADMIN]);
    expect(res.status).toBe(201);
  });

  it('ACCEPTS the actor watching their own task', async () => {
    actingAs('sales', DEPT_SALES);
    expect((await createWith([SALES])).status).toBe(201);
  });

  it('a departmentless actor may still add an admin', async () => {
    actingAs('sales', null);
    expect((await createWith([ADMIN])).status).toBe(201);
  });

  it('a departmentless actor may NOT add a stranger — a null department is not a department', async () => {
    // MATE shares no department with this actor, because this actor has none. The regression
    // guarded: emitting `department_id: null` as a clause instead of omitting it, which would
    // quietly group every department-less user together.
    actingAs('sales', null);
    expect((await createWith([MATE])).status).toBe(403);
  });

  it('REFUSES the whole create when ONE of several watchers is outside the pool', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await createWith([MATE, FIELD_TECH]);
    expect(res.status).toBe(403);
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
  });

  it('an ADMIN may watch-add anyone in the organization', async () => {
    actingAs('admin', null);
    const res = await request(app).post('/api/tasks').set(authHeader('admin')).send({
      title: 'Anything',
      watcher_ids: [FIELD_TECH],
    });
    expect(res.status).toBe(201);
  });

  it('an empty watcher list is permitted', async () => {
    actingAs('sales', DEPT_SALES);
    expect((await createWith([])).status).toBe(201);
  });
});

describe('PATCH /api/tasks/:id — the update path is not a way around the rule', () => {
  it('REFUSES adding a watcher outside the pool with 403', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [FIELD_TECH] });
    expect(res.status).toBe(403);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('ACCEPTS adding a watcher inside the pool', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [MATE] });
    expect(res.status).toBe(200);
    expect(mockPrisma.task.update.mock.calls[0][0].data.watcher_ids).toEqual([MATE]);
  });
});

describe('PATCH — only the ADDED watchers are judged', () => {
  it('an unrelated edit SUCCEEDS and KEEPS a watcher who is now outside the editor\'s pool', async () => {
    // The regression this pins: re-validating the whole set would make renaming a task fail,
    // or silently strip a watcher, whenever someone added earlier had moved department.
    mockPrisma.task.findFirst.mockResolvedValue(taskFixture([FIELD_TECH]));
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ title: 'Renamed' });
    expect(res.status).toBe(200);
    const data = mockPrisma.task.update.mock.calls[0][0].data;
    expect(data.title).toBe('Renamed');
    // Untouched: the watcher array is not even part of the write.
    expect(data.watcher_ids).toBeUndefined();
  });

  it('re-sending the SAME set containing an out-of-pool watcher is not an addition, so it succeeds', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskFixture([FIELD_TECH]));
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [FIELD_TECH] });
    expect(res.status).toBe(200);
  });

  it('REMOVING an out-of-pool watcher is permitted', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskFixture([FIELD_TECH]));
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [] });
    expect(res.status).toBe(200);
    expect(mockPrisma.task.update.mock.calls[0][0].data.watcher_ids).toEqual([]);
  });

  // These two are deliberately SEPARATE cases rather than one case making two requests. Driving
  // two sessions from a single `it` meant re-clearing the token cache mid-test and re-arming the
  // mocks by hand, which passed in isolation and failed under a full-suite run. One request per
  // case, each off the shared beforeEach, is the version that cannot drift.

  it('ADDING only admins alongside an existing out-of-pool watcher is permitted', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskFixture([FIELD_TECH]));
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [FIELD_TECH, OTHER_ADMIN, ADMIN] });
    // FIELD_TECH is not an addition, and both real additions are admins — inside the pool.
    expect(res.status).toBe(200);
  });

  it('but ADDING a NEW out-of-pool watcher alongside an existing one is still refused', async () => {
    mockPrisma.task.findFirst.mockResolvedValue(taskFixture([FIELD_TECH]));
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [FIELD_TECH, FIELD_TECH_2] });
    expect(res.status).toBe(403);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });
});

describe('the tenant boundary holds regardless of the watcher rule', () => {
  it('REFUSES a watcher from another organization on create', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await createWith([FOREIGN]);
    // 400, not 403: the membership check answers "is this a real active colleague" and runs
    // first. The two statuses stay distinct on purpose — see the controller.
    expect(res.status).toBe(400);
    expect(mockPrisma.task.create).not.toHaveBeenCalled();
  });

  it('REFUSES a watcher from another organization on update', async () => {
    actingAs('sales', DEPT_SALES);
    const res = await patchWith({ watcher_ids: [FOREIGN] });
    expect(res.status).toBe(400);
    expect(mockPrisma.task.update).not.toHaveBeenCalled();
  });

  it('an ADMIN cannot reach across the tenant boundary either', async () => {
    actingAs('admin', null);
    const res = await request(app).post('/api/tasks').set(authHeader('admin')).send({
      title: 'Anything',
      watcher_ids: [FOREIGN],
    });
    expect(res.status).toBe(400);
  });
});
