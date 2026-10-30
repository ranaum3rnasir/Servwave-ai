import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  // A custom role's change and its audit row are one transaction (re-audit N23): the stub runs it on the mocked client.
  (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
});

describe('GET /api/roles - custom roles', () => {
  it('appends the org custom roles after the 4 system roles, type: custom', async () => {
    mockAuthAs('admin');
    // One person in the Admin box and two on the custom role (whose base role is also Admin): three people, each counted once.
    const onRole = { id: 'u-copy', role: 'ADMIN', is_admin: false, custom_role_id: 'cr-1', based_on_role_key: 'office-manager', custom_role: { key: 'office-manager' } };
    (prisma.user.findMany as any).mockResolvedValue([
      { id: 'u-box', role: 'ADMIN', is_admin: true, custom_role_id: null, based_on_role_key: null, custom_role: null },
      onRole,
      { ...onRole, id: 'u-copy-2' },
    ]);
    (prisma.customRole.findMany as any).mockResolvedValue([
      {
        id: 'cr-1',
        key: 'office-manager',
        label: 'Office Manager',
        description: 'Runs the office',
        base_role: 'ADMIN',
      },
    ]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN', 'office-manager']);
    expect(res.body.find((r: any) => r.role === 'ADMIN').userCount).toBe(1);
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
    (prisma.user.findMany as any).mockResolvedValue([]);
    (prisma.customRole.findMany as any).mockResolvedValue([]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']);
  });
});

describe('POST /api/roles - create', () => {
  const createdRow = (over: Record<string, unknown> = {}) => ({
    id: 'cr-new', organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', label: 'Senior Dispatch',
    description: '', base_role: 'DISPATCHER', archived_at: null, ...over,
  });
  /** Run the transaction the switch store opens with a stub that records what it writes. */
  const stubTransaction = () => {
    const upsert = vi.fn().mockResolvedValue({});
    const logRows = vi.fn().mockResolvedValue({ count: 0 });
    // Since ticket 37 the save holds the role (one raw lock statement) and reads its current values inside the transaction,
    // so the stub answers those reads the way the mocked client outside it does.
    (prisma.$transaction as any).mockImplementation((fn: any) =>
      fn({
        $queryRaw: vi.fn().mockResolvedValue([]),
        permissionRoleSwitch: { upsert, findMany: prisma.permissionRoleSwitch.findMany },
        customRole: { findFirst: prisma.customRole.findFirst, create: prisma.customRole.create, delete: prisma.customRole.delete },
        permissionChangeLog: { createMany: logRows },
        auditLog: { create: prisma.auditLog.create },
      }),
    );
    return { upsert, logRows };
  };

  it('creates a role derived from DISPATCHER; it starts from the Dispatcher preset, so nothing is stored for it', async () => {
    mockAuthAs('admin');
    (prisma.customRole.create as any).mockResolvedValue(createdRow());
    const { upsert } = stubTransaction();

    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Senior Dispatch', base_role: 'DISPATCHER' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      id: 'cr-new', role: 'senior-dispatch', label: 'Senior Dispatch', type: 'custom', base_role: 'DISPATCHER', editable: true, userCount: 0, fullAccess: false,
    });
    expect((prisma.customRole.create as any).mock.calls[0][0].data).toMatchObject({
      organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', label: 'Senior Dispatch', base_role: 'DISPATCHER',
    });
    // The role-permission table is no longer a source, so nothing is written to it.
    expect(upsert).not.toHaveBeenCalled();
  });

  it('creates an ADMIN-derived role as an ordinary role (its base is the Admin preset, not the Admin box)', async () => {
    mockAuthAs('admin');
    (prisma.customRole.create as any).mockResolvedValue(createdRow({ key: 'office-manager', label: 'Office Manager', base_role: 'ADMIN' }));

    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Office Manager', base_role: 'ADMIN' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ role: 'office-manager', base_role: 'ADMIN', type: 'custom', fullAccess: false });
  });

  it('copies another role\'s current switch values onto the new role when clone_grants_from is given', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-src', organization_id: ALPHA_ORG_ID, key: 'senior-dispatch', base_role: 'DISPATCHER', archived_at: null, made_from_blank: false,
    });
    (prisma.customRole.create as any).mockResolvedValue(createdRow({ id: 'cr-new', key: 'junior-dispatch', label: 'Junior Dispatch' }));
    // The source role has Delete customers stored on, which the Dispatcher preset leaves off.
    (prisma.permissionRoleSwitch.findMany as any).mockResolvedValue([{ switch_key: 'delete_customers', value: true }]);
    const { upsert } = stubTransaction();

    const res = await request(app)
      .post('/api/roles')
      .set(authHeader('admin'))
      .send({ label: 'Junior Dispatch', base_role: 'DISPATCHER', clone_grants_from: 'senior-dispatch' });

    expect(res.status).toBe(201);
    const stored = new Map(upsert.mock.calls.map(([arg]) => [arg.create.switch_key, arg.create]));
    expect(stored.get('delete_customers')).toMatchObject({ role_key: 'junior-dispatch', organization_id: ALPHA_ORG_ID, value: true });
  });

  it('cloning from literal ADMIN stores the Admin preset on the new role (ADMIN itself has no stored set)', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-new', organization_id: ALPHA_ORG_ID, key: 'shadow-admin', base_role: 'SALES', archived_at: null, made_from_blank: false,
    });
    (prisma.customRole.create as any).mockResolvedValue(createdRow({ id: 'cr-new', key: 'shadow-admin', label: 'Shadow Admin', base_role: 'SALES' }));
    const { upsert } = stubTransaction();

    const res = await request(app)
      .post('/api/roles')
      .set(authHeader('admin'))
      .send({ label: 'Shadow Admin', base_role: 'SALES', clone_grants_from: 'ADMIN' });

    expect(res.status).toBe(201);
    const stored = new Map(upsert.mock.calls.map(([arg]) => [arg.create.switch_key, arg.create.value]));
    expect(stored.get('delete_customers')).toBe(true);
    expect(stored.get('jobs_scope')).toBe('all');
  });

  it('400s a key that collides with a system role name (case-insensitive)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Dispatcher', base_role: 'SALES' });
    expect(res.status).toBe(400);
    expect(prisma.customRole.create).not.toHaveBeenCalled();
  });

  it.each(['Administrator', 'administrator', 'Owner', ' OWNER ', 'Admin', 'Administrator (Owner)'])(
    'refuses %j, a word the Administrator (Owner) role is known by, in the built-in role words',
    async (label) => {
      mockAuthAs('admin');
      const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label, blank: true });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`"${label.trim()}" is the name of a built-in role. Choose another name.`);
      expect(prisma.customRole.create).not.toHaveBeenCalled();
    },
  );

  it('409s a name another role carries, and names the built-in role it collides with in plain words', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findMany as any).mockResolvedValue([{ id: 'cr-9', key: 'old-key', label: 'Night Desk' }]);
    const taken = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'night  desk', base_role: 'SALES' });
    expect(taken.status).toBe(409);
    const builtIn = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Technician', base_role: 'SALES' });
    expect(builtIn.body.error).toMatch(/built-in role/);
    expect(prisma.customRole.create).not.toHaveBeenCalled();
  });

  it('400s an unknown clone_grants_from', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app)
      .post('/api/roles')
      .set(authHeader('admin'))
      .send({ label: 'X', base_role: 'SALES', clone_grants_from: 'nonexistent' });
    expect(res.status).toBe(400);
    expect(prisma.customRole.create).not.toHaveBeenCalled();
  });

  it('409s a duplicate key within the same org', async () => {
    mockAuthAs('admin');
    (prisma.customRole.create as any).mockImplementation(async () => {
      const err = new Error('unique violation') as Error & { code: string };
      err.code = 'P2002';
      throw err;
    });
    const res = await request(app).post('/api/roles').set(authHeader('admin')).send({ label: 'Office Manager', base_role: 'ADMIN' });
    expect(res.status).toBe(409);
  });

  it('403s a caller without Manage roles and permissions', async () => {
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

  describe('the new name runs the same checks as creating a role', () => {
    const office = { id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', label: 'Office Manager', description: '', base_role: 'ADMIN', archived_at: null };
    const ops = { id: 'cr-2', key: 'ops-lead', label: 'Ops Lead' };
    const serveRoles = () => {
      (prisma.customRole.findFirst as any).mockResolvedValue(office);
      (prisma.customRole.findMany as any).mockResolvedValue([{ id: office.id, key: office.key, label: office.label }, ops]);
      (prisma.customRole.update as any).mockImplementation(async ({ data }: any) => ({ ...office, ...data }));
    };
    const rename = (label: string) => request(app).patch('/api/roles/office-manager').set(authHeader('admin')).send({ label });

    it.each(['Technician', 'technician', '  TECHNICIAN  ', 'Dispatcher', 'sales', 'Admin', 'Administrator (Owner)'])(
      'refuses %j, the name of a built-in role, and leaves the label alone',
      async (label) => {
        mockAuthAs('admin');
        serveRoles();
        const res = await rename(label);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/built-in role/);
        expect(prisma.customRole.update).not.toHaveBeenCalled();
      },
    );

    it.each(['Administrator', 'owner', 'Owner'])('refuses %j, a word the Administrator (Owner) role is known by', async (label) => {
      mockAuthAs('admin');
      serveRoles();
      const res = await rename(label);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe(`"${label}" is the name of a built-in role. Choose another name.`);
      expect(prisma.customRole.update).not.toHaveBeenCalled();
    });

    it('lets a role that already carries such a name keep it on a save, and still refuses it to any other role', async () => {
      mockAuthAs('admin');
      serveRoles();
      // An older role named Owner: no migration renames it, and a save that leaves its name alone goes through.
      (prisma.customRole.findFirst as any).mockResolvedValue({ ...office, label: 'Owner' });
      (prisma.customRole.findMany as any).mockResolvedValue([{ id: office.id, key: office.key, label: 'Owner' }, ops]);
      expect((await rename('owner')).status).toBe(200);
      expect((await rename('Administrator')).status).toBe(400);
    });

    it.each(['Ops Lead', 'ops lead', 'OPS   LEAD', 'ops-lead'])('refuses %j, which is another role\'s name, with the same answer as create', async (label) => {
      mockAuthAs('admin');
      serveRoles();
      const res = await rename(label);
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/already exists/);
      expect(prisma.customRole.update).not.toHaveBeenCalled();
    });

    it('refuses a name another role carries after its own rename, though its key is different', async () => {
      mockAuthAs('admin');
      serveRoles();
      (prisma.customRole.findMany as any).mockResolvedValue([{ id: office.id, key: office.key, label: office.label }, { id: 'cr-3', key: 'old-key', label: 'Night Desk' }]);
      expect((await rename('night desk')).status).toBe(409);
    });

    it('refuses a name with no letter or number in it', async () => {
      mockAuthAs('admin');
      serveRoles();
      const res = await rename('???');
      expect(res.status).toBe(400);
      expect(prisma.customRole.update).not.toHaveBeenCalled();
    });

    it('lets a role keep its own name in another case or spacing, and take a free name', async () => {
      mockAuthAs('admin');
      serveRoles();
      expect((await rename('OFFICE   manager')).status).toBe(200);
      expect((await rename('Front Desk')).status).toBe(200);
      expect((prisma.customRole.update as any).mock.calls.map((c: any) => c[0].data.label)).toEqual(['OFFICE   manager', 'Front Desk']);
    });

    it('does not check names when only the description changes', async () => {
      mockAuthAs('admin');
      serveRoles();
      const res = await request(app).patch('/api/roles/office-manager').set(authHeader('admin')).send({ description: 'Runs the office' });
      expect(res.status).toBe(200);
      expect(prisma.customRole.findMany).not.toHaveBeenCalled();
    });
  });

  it('refuses renaming a system role', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).patch('/api/roles/SALES').set(authHeader('admin')).send({ label: 'X' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/i);
    expect(prisma.customRole.update).not.toHaveBeenCalled();
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
    (prisma.user.findMany as any).mockResolvedValue([]);
    (prisma.customRole.update as any).mockResolvedValue({ id: 'cr-1', key: 'office-manager', archived_at: new Date() });

    const res = await request(app).post('/api/roles/office-manager/archive').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect((prisma.customRole.update as any).mock.calls[0][0]).toMatchObject({ where: { id: 'cr-1' } });
  });

  it('counts the people once, in one read, the way the Roles list does: by the role they are based on, active or not', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    // One person holds the role; another was filled from it though their own role column names another one.
    (prisma.user.findMany as any).mockResolvedValue([
      { id: 'u-1', role: 'SALES', custom_role_id: 'cr-1', based_on_role_key: 'office-manager', custom_role: { key: 'office-manager' } },
      { id: 'u-2', role: 'SALES', custom_role_id: null, based_on_role_key: 'office-manager', custom_role: null },
      { id: 'u-3', role: 'SALES', custom_role_id: null, based_on_role_key: null, custom_role: null },
    ]);
    const res = await request(app).post('/api/roles/office-manager/archive').set(authHeader('admin'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Cannot archive: 2 people are still on this role. Move them to another role first.');
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.count).not.toHaveBeenCalled();
    expect(prisma.customRole.update).not.toHaveBeenCalled();
  });

  it('says "1 person" for one', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    (prisma.user.findMany as any).mockResolvedValue([
      { id: 'u-1', role: 'SALES', custom_role_id: 'cr-1', based_on_role_key: null, custom_role: { key: 'office-manager' } },
    ]);
    const res = await request(app).post('/api/roles/office-manager/archive').set(authHeader('admin'));
    expect(res.body.error).toBe('Cannot archive: 1 person is still on this role. Move them to another role first.');
  });

  it('409s archiving a role that still has assigned users, and reports the count', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue({
      id: 'cr-1', organization_id: ALPHA_ORG_ID, key: 'office-manager', base_role: 'ADMIN', archived_at: null,
    });
    const onRole = { role: 'SALES', custom_role_id: 'cr-1', based_on_role_key: 'office-manager', custom_role: { key: 'office-manager' } };
    (prisma.user.findMany as any).mockResolvedValue([{ id: 'u-1', ...onRole }, { id: 'u-2', ...onRole }, { id: 'u-3', ...onRole }]);

    const res = await request(app).post('/api/roles/office-manager/archive').set(authHeader('admin'));

    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/3 people/);
    expect(prisma.customRole.update).not.toHaveBeenCalled();
  });

  it('refuses archiving a system role', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).post('/api/roles/ADMIN/archive').set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/built-in/i);
    expect(prisma.customRole.update).not.toHaveBeenCalled();
  });

  it('404s archiving an unknown key', async () => {
    mockAuthAs('admin');
    (prisma.customRole.findFirst as any).mockResolvedValue(null);
    const res = await request(app).post('/api/roles/nonexistent/archive').set(authHeader('admin'));
    expect(res.status).toBe(404);
  });
});
