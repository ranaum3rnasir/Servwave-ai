import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/roles - custom roles', () => {
  it('appends the org custom roles after the 4 system roles, type: custom', async () => {
    mockAuthAs('admin');
    (prisma.user.groupBy as any).mockResolvedValue([{ role: 'ADMIN', _count: { _all: 1 } }]);
    (prisma.customRole.findMany as any).mockResolvedValue([
      {
        id: 'cr-1',
        key: 'office-manager',
        label: 'Office Manager',
        description: 'Runs the office',
        base_role: 'ADMIN',
        _count: { users: 2 },
      },
    ]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN', 'office-manager']);
    const custom = res.body.find((r: any) => r.role === 'office-manager');
    expect(custom).toMatchObject({
      // The user-assignment payload (users.custom_role_id) is a UUID FK to custom_roles.id, NOT
      // the key - a picker built off this list needs the real id to assign the role to a user.
      id: 'cr-1',
      label: 'Office Manager',
      description: 'Runs the office',
      base_role: 'ADMIN',
      type: 'custom',
      editable: true,
      fullAccess: false,
      userCount: 2,
    });
    expect((prisma.customRole.findMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      archived_at: null,
    });
  });

  it('excludes archived custom roles', async () => {
    mockAuthAs('admin');
    (prisma.user.groupBy as any).mockResolvedValue([]);
    (prisma.customRole.findMany as any).mockResolvedValue([]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']);
  });
});

describe('GET /api/roles/:role/permissions - custom roles', () => {
  it('assembles the view-model for a custom role keyed by its own key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', label: 'Office Manager',
      description: '', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'read', subject: 'Customer', conditions: null },
    ]);
    const res = await request(app).get('/api/roles/office-manager/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.matrix.Customer.read).toBe(true);
    expect(res.body.editable).toBe(true);
    expect((prisma.rolePermission.findMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      role: 'office-manager',
    });
  });

  it('404s for an unknown custom key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).get('/api/roles/nonexistent/permissions').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

describe('PUT /api/roles/:role/permissions - custom roles', () => {
  it('an ADMIN-derived custom role IS editable - only the literal ADMIN key is frozen', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));
    const res = await request(app)
      .put('/api/roles/office-manager/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: { Customer: { read: true, create: false, update: false, delete: false } },
        sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
        scope: {},
        general: { description: '' },
      });
    expect(res.status).toBe(200);
    expect(upsert).toHaveBeenCalled();
  });

  it('404s a PUT for an unknown custom key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app)
      .put('/api/roles/nonexistent/permissions')
      .set(authHeader('admin'))
      .send({ matrix: {}, sensitive: { seeFinancials: false, managePayments: false, viewReports: false }, scope: {}, general: { description: '' } });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/roles/:role/reset - custom roles', () => {
  it('resets an ADMIN-derived custom role to the full grant set (not empty)', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const createMany = vi.fn().mockResolvedValue({ count: 40 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, createMany } }));
    const res = await request(app).post('/api/roles/office-manager/reset').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const created = createMany.mock.calls[0][0].data;
    expect(created.length).toBeGreaterThan(20);
    expect(created.every((g: any) => g.role === 'office-manager' && g.organization_id === ALPHA_ORG_ID)).toBe(true);
  });

  it("resets a DISPATCHER-derived custom role to DISPATCHER's DEFAULT_GRANTS", async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-2', organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', base_role: 'DISPATCHER', archived_at: null,
    });
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const createMany = vi.fn().mockResolvedValue({ count: 0 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, createMany } }));
    const res = await request(app).post('/api/roles/senior-dispatch/reset').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const created = createMany.mock.calls[0][0].data;
    const dispatcherDefaults = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER');
    expect(created.length).toBe(dispatcherDefaults.length);
    expect(created.every((g: any) => g.role === 'senior-dispatch')).toBe(true);
  });

  it('404s reset for an unknown custom key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).post('/api/roles/nonexistent/reset').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

describe('POST /api/roles - create', () => {
  it('creates a role derived from DISPATCHER, seeded with DISPATCHER defaults', async () => {
    mockAuthAs('admin');
    const createdRow = {
      id: 'cr-new', organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', label: 'Senior Dispatch',
      description: '', base_role: 'DISPATCHER', archived_at: null,
    };
    const customRoleCreate = vi.fn().mockResolvedValue(createdRow);
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ customRole: { create: customRoleCreate }, rolePermission: { createMany } }));

    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Senior Dispatch', base_role: 'DISPATCHER' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'cr-new', role: 'senior-dispatch', label: 'Senior Dispatch', type: 'custom', base_role: 'DISPATCHER', editable: true, userCount: 0, fullAccess: false,
    });
    expect(customRoleCreate.mock.calls[0][0].data).toMatchObject({
      organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', label: 'Senior Dispatch', base_role: 'DISPATCHER',
    });
    const seeded = createMany.mock.calls[0][0].data;
    const dispatcherDefaults = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER');
    expect(seeded.length).toBe(dispatcherDefaults.length);
    expect(seeded.every((g: any) => g.role === 'senior-dispatch')).toBe(true);
  });

  it('creates an ADMIN-derived role seeded with the full grant set (so an admin subtracts, not adds)', async () => {
    mockAuthAs('admin');
    const createdRow = {
      id: 'cr-new', organization_id: ALPHA_ORG_ID, key: 'office-manager', label: 'Office Manager',
      description: '', base_role: 'ADMIN', archived_at: null,
    };
    const customRoleCreate = vi.fn().mockResolvedValue(createdRow);
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ customRole: { create: customRoleCreate }, rolePermission: { createMany } }));

    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Office Manager', base_role: 'ADMIN' });

    expect(res.status).toBe(201);
    const seeded = createMany.mock.calls[0][0].data;
    expect(seeded.length).toBeGreaterThan(20);
    expect(seeded.every((g: any) => g.role === 'office-manager')).toBe(true);
  });

  it('clones the grant set from an existing role when clone_grants_from is given', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-src', organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', base_role: 'DISPATCHER', archived_at: null,
    });
    (prisma.rolePermission.findMany as any).mockResolvedValue([{ action: 'read', subject: 'Customer', conditions: null }]);
    const customRoleCreate = vi.fn().mockResolvedValue({
      id: 'cr-new', organization_id: ALPHA_ORG_ID, key: 'junior-dispatch', label: 'Junior Dispatch', description: '', base_role: 'DISPATCHER', archived_at: null,
    });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ customRole: { create: customRoleCreate }, rolePermission: { createMany } }));

    const res = await request(app)
      .post('/api/roles')
      .set(authHeader('admin'))
      .send({ label: 'Junior Dispatch', base_role: 'DISPATCHER', clone_grants_from: 'senior-dispatch' });

    expect(res.status).toBe(201);
    const seeded = createMany.mock.calls[0][0].data;
    // The source's rows verbatim, plus the baseline no editor can grant (read TaskCategory - see
    // 'custom roles always read task categories' below).
    expect(seeded).toHaveLength(2);
    expect(seeded[0]).toMatchObject({ role: 'junior-dispatch', action: 'read', subject: 'Customer' });
    expect(seeded[1]).toMatchObject({ role: 'junior-dispatch', action: 'read', subject: 'TaskCategory' });
  });

  it('cloning from literal ADMIN seeds the full grant set (ADMIN itself has no persisted rows)', async () => {
    mockAuthAs('admin');
    const customRoleCreate = vi.fn().mockResolvedValue({
      id: 'cr-new', organization_id: ALPHA_ORG_ID, key: 'shadow-admin', label: 'Shadow Admin', description: '', base_role: 'SALES', archived_at: null,
    });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ customRole: { create: customRoleCreate }, rolePermission: { createMany } }));

    const res = await request(app)
      .post('/api/roles')
      .set(authHeader('admin'))
      .send({ label: 'Shadow Admin', base_role: 'SALES', clone_grants_from: 'ADMIN' });

    expect(res.status).toBe(201);
    const seeded = createMany.mock.calls[0][0].data;
    expect(seeded.length).toBeGreaterThan(20);
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('400s a key that collides with a system role name (case-insensitive)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Dispatcher', base_role: 'SALES' });
    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('400s an unknown clone_grants_from', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/roles')
      .set(authHeader('admin'))
      .send({ label: 'X', base_role: 'SALES', clone_grants_from: 'nonexistent' });
    expect(res.status).toBe(400);
  });

  it('409s a duplicate key within the same org', async () => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation(async () => {
      const err = new Error('unique violation') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    });
    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Office Manager', base_role: 'ADMIN' });
    expect(res.status).toBe(409);
  });

  it('403s a non-admin caller', async () => {
    mockAuthAs('sales');
    const res = await request(app).post('/api/roles').set(authHeader('sales')).send({ label: 'X', base_role: 'SALES' });
    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/roles/:role - rename/describe', () => {
  it('renames and re-describes a custom role; key and base_role are untouched', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', label: 'Office Manager', description: '', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.customRole.update as any).mockResolvedValue({
      id: 'cr-1', key: 'office-manager', label: 'Ops Lead', description: 'Runs ops', base_role: 'ADMIN', archived_at: null,
    });

    const res = await request(app).patch('/api/roles/office-manager').set(authHeader('admin')).send({ label: 'Ops Lead', description: 'Runs ops' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ role: 'office-manager', label: 'Ops Lead', description: 'Runs ops' });
    expect((prisma.customRole.update as any).mock.calls[0][0]).toMatchObject({
      where: { id: 'cr-1' },
      data: { label: 'Ops Lead', description: 'Runs ops' },
    });
  });

  it('404s renaming a system role', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).patch('/api/roles/SALES').set(authHeader('admin')).send({ label: 'X' });
    expect(res.status).toBe(404);
  });

  it('404s renaming an unknown key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).patch('/api/roles/nonexistent').set(authHeader('admin')).send({ label: 'X' });
    expect(res.status).toBe(404);
  });
});

describe('POST /api/roles/:role/archive', () => {
  it('archives a custom role that has zero assigned users', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.customRole.update as any).mockResolvedValue({ id: 'cr-1', key: 'office-manager', archived_at: new Date() });

    const res = await request(app).post('/api/roles/office-manager/archive').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect((prisma.customRole.update as any).mock.calls[0][0]).toMatchObject({ where: { id: 'cr-1' } });
    expect((prisma.user.count as any).mock.calls[0][0].where).toMatchObject({ custom_role_id: 'cr-1' });
  });

  it('409s archiving a role that still has assigned users, and reports the count', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.user.count as any).mockResolvedValue(3);

    const res = await request(app).post('/api/roles/office-manager/archive').set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/3/);
    expect(prisma.customRole.update).not.toHaveBeenCalled();
  });

  it('404s archiving a system role', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).post('/api/roles/ADMIN/archive').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });

  it('404s archiving an unknown key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).post('/api/roles/nonexistent/archive').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});

// Every role reads the task category list (visits-and-task-categories PRD; SHARED_BASELINE in
// defaultGrants.ts). The Roles editor cannot show or toggle that grant, so a role created or reset
// here must be seeded with it whatever its template - otherwise its users cannot load the list a
// task's category comes from. Create/update/delete stay out of the ADMIN template, the way the
// other admin-managed lists (Tag, AppSetting) are.
describe('custom roles always read task categories', () => {
  const pairs = (rows: any[]) => rows.map((g) => `${g.action}:${g.subject}`);
  const wireCreate = (key: string, base_role: string) => {
    const customRoleCreate = vi.fn().mockResolvedValue({
      id: 'cr-new', organization_id: ALPHA_ORG_ID, key, label: key, description: '', base_role, archived_at: null,
    });
    const createMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ customRole: { create: customRoleCreate }, rolePermission: { createMany } }));
    return createMany;
  };

  it('a role created from the ADMIN template reads task categories, and does not manage them', async () => {
    mockAuthAs('admin');
    const createMany = wireCreate('office-manager', 'ADMIN');

    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Office Manager', base_role: 'ADMIN' });

    expect(res.status).toBe(201);
    const seeded = pairs(createMany.mock.calls[0][0].data);
    expect(seeded).toContain('read:TaskCategory');
    expect(seeded.filter((p) => p.endsWith(':TaskCategory'))).toEqual(['read:TaskCategory']);
  });

  it('a role cloned from literal ADMIN reads task categories', async () => {
    mockAuthAs('admin');
    const createMany = wireCreate('shadow-admin', 'SALES');

    await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Shadow Admin', base_role: 'SALES', clone_grants_from: 'ADMIN' });

    expect(pairs(createMany.mock.calls[0][0].data)).toContain('read:TaskCategory');
  });

  it('a role cloned from a role that predates task categories reads them too, once', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-src', organization_id: ALPHA_ORG_ID, key: 'old-role', base_role: 'DISPATCHER', archived_at: null,
    });
    (prisma.rolePermission.findMany as any).mockResolvedValue([{ action: 'read', subject: 'Customer', conditions: null }]);
    const createMany = wireCreate('new-role', 'DISPATCHER');

    await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'New Role', base_role: 'DISPATCHER', clone_grants_from: 'old-role' });

    expect(pairs(createMany.mock.calls[0][0].data).sort()).toEqual(['read:Customer', 'read:TaskCategory']);
  });

  it('resetting an ADMIN-template role keeps it reading task categories', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 3 });
    const createMany = vi.fn().mockResolvedValue({ count: 40 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, createMany } }));

    const res = await request(app).post('/api/roles/office-manager/reset').set(authHeader('admin'));

    expect(res.status).toBe(200);
    const seeded = pairs(createMany.mock.calls[0][0].data);
    expect(seeded.filter((p) => p === 'read:TaskCategory')).toHaveLength(1);
  });

  it('a Roles editor save does not strip it (the editor never manages it)', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.rolePermission.findMany as any).mockResolvedValue([{ action: 'read', subject: 'TaskCategory', conditions: null }]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/office-manager/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: { Customer: { read: true, create: false, update: false, delete: false } },
        sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
        scope: {},
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    const removed = deleteMany.mock.calls.flatMap((c: any[]) => JSON.stringify(c[0].where));
    expect(removed.join(' ')).not.toContain('TaskCategory');
  });
});
