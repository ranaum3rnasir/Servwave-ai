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

describe('GET /api/roles', () => {
  it('returns the 4 system roles with user counts; admin labelled Owner', async () => {
    mockAuthAs('admin');
    (prisma.user.groupBy as any).mockResolvedValue([
      { role: 'ADMIN', _count: { _all: 1 } },
      { role: 'SALES', _count: { _all: 3 } },
    ]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN']);
    const admin = res.body.find((r: any) => r.role === 'ADMIN');
    expect(admin).toMatchObject({ label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1 });
    expect(res.body.find((r: any) => r.role === 'SALES').userCount).toBe(3);
  });
});

describe('GET /api/roles/:role/permissions', () => {
  it('assembles SALES view-model from RolePermission rows (org-scoped)', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'read', subject: 'Customer', conditions: null },
      { action: 'read', subject: 'Lead', conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    const res = await request(app).get('/api/roles/SALES/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.matrix.Customer.read).toBe(true);
    expect(res.body.scope.Lead).toBe('Owned');
    expect(res.body.editable).toBe(true);
    expect((prisma.rolePermission.findMany as any).mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      role: 'SALES',
    });
  });
  it('ADMIN returns synthetic full-access, read-only', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/roles/ADMIN/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.matrix.Invoice).toEqual({ read: true, create: true, update: true, delete: true });
    expect(res.body.editable).toBe(false);
  });

  // #2041 AC10 — the persisted grant, read back through the Roles API.
  it('AC10: SALES matrix.Customer is {read,create,update:true, delete:false} and there is NO scope.Customer key (R2)', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'SALES').map(({ action, subject, conditions }) => ({
        action,
        subject,
        conditions: conditions ?? null,
      })),
    );

    const res = await request(app).get('/api/roles/SALES/permissions').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.matrix.Customer).toEqual({ read: true, create: true, update: true, delete: false });
    expect(res.body.scope).not.toHaveProperty('Customer');
  });
});

describe('PUT /api/roles/:role/permissions', () => {
  it('diffs to upserts/deletes, clears cache, 200', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'read', subject: 'Customer', conditions: null },
      { action: 'delete', subject: 'Customer', conditions: null },
    ]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));
    const res = await request(app)
      .put('/api/roles/SALES/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: { Customer: { read: true, create: true, update: false, delete: false } },
        sensitive: { seeFinancials: false, managePayments: false },
        scope: {},
        general: { description: '' },
      });
    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalled();
    expect(upsert).toHaveBeenCalled();
  });
  it('rejects editing ADMIN (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .put('/api/roles/ADMIN/permissions')
      .set(authHeader('admin'))
      .send({ matrix: {}, sensitive: { seeFinancials: false, managePayments: false }, scope: {}, general: { description: '' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/roles/:role/reset', () => {
  it('re-applies DEFAULT_GRANTS for the role, org-scoped', async () => {
    mockAuthAs('admin');
    const deleteMany = vi.fn().mockResolvedValue({ count: 5 });
    const createMany = vi.fn().mockResolvedValue({ count: 42 });
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, createMany } }));
    const res = await request(app).post('/api/roles/SALES/reset').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(createMany).toHaveBeenCalled();
    const createdData = createMany.mock.calls[0][0].data;
    expect(createdData.every((g: any) => g.organization_id === ALPHA_ORG_ID && g.role === 'SALES')).toBe(true);
  });
});

describe('roles isolation', () => {
  it('non-admin (no Role grant) gets 403', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/roles').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});

// ─── Multi-visit S8 (behaviour 4) ─────────────────────────────────────────────────────────────
// SCOPE_CONDITIONS is the EMITTER: every Roles-and-Permissions Save writes these values into
// role_permissions. If it is not repointed in the same PR as the migration, the first admin Save
// after deploy re-writes exactly what the migration just repaired.
describe('S8 - the Roles screen writes the visits path', () => {
  it('persists the visits path when the Job scope chip is set to Owned', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/TECHNICIAN/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: { Job: { read: true, create: false, update: false, delete: false } },
        sensitive: { seeFinancials: false, managePayments: false },
        scope: { Job: 'Owned' },
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    const jobRead = upsert.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.create?.subject === 'Job' && a?.create?.action === 'read');
    expect(jobRead).toBeDefined();
    expect(jobRead.create.conditions).toEqual({
      visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } },
    });
    expect(jobRead.update.conditions).toEqual({
      visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } },
    });
  });

  it('renders the Owned chip for a stored OR-shape condition on the visits path', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      {
        action: 'read',
        subject: 'Job',
        conditions: {
          OR: [
            { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } },
            { created_by_id: '{{userId}}' },
          ],
        },
      },
    ]);
    const res = await request(app).get('/api/roles/TECHNICIAN/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    // Without the alias entry the chip renders "All" - a scope the role does not have.
    expect(res.body.scope.Job).toBe('Owned');
  });

  it('persists the visits path for the Invoice scope chip too', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/TECHNICIAN/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: { Invoice: { read: true, create: false, update: false, delete: false } },
        sensitive: { seeFinancials: false, managePayments: false },
        scope: { Invoice: 'Owned' },
        general: { description: '' },
      });

    expect(res.status).toBe(200);
    const invRead = upsert.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.create?.subject === 'Invoice' && a?.create?.action === 'read');
    expect(invRead.create.conditions).toEqual({
      job: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } },
    });
  });
});

// ─── Manual Communication Log — the REVOKE half of the sensitive bundle ───────────────────────
// `putRolePermissions` may only delete a grant whose `action:subject` pair is in MANAGED_KEYS,
// and MANAGED_KEYS is derived from `buildFullGrantSet()` — a synthetic "every cell, every bundle,
// every toggle ON" view model built inside role.controller.ts. A sensitive key that is missing
// from THAT view model is invisible to every other test on the feature: the bundle still emits,
// still assembles, still saves. What breaks is the way back. An existing `log_past Communication`
// row can never enter `toDelete`, so unticking the switch and saving leaves the role holding the
// capability for ever while the checkbox reads off — and the same view model seeds an
// ADMIN-derived custom role in createRole/resetRole, which would then start without it.
//
// Driven through the real PUT handler rather than by re-deriving the key set, for the reason
// catalog.ts records about itself: a test that restates a constant back at itself stays green
// after the gate it claims to guard has gone.
describe('PUT /api/roles/:role/permissions - the log-past capability can be taken away again', () => {
  const HELD = [
    // The baseline verb the matrix governs — click-to-call, texts, email. It must survive.
    { action: 'create', subject: 'Communication', conditions: null },
    // The capability an admin granted through the sensitive bundle, and is now revoking.
    { action: 'log_past', subject: 'Communication', conditions: null },
  ];

  let deleteMany: ReturnType<typeof vi.fn>;
  let upsert: ReturnType<typeof vi.fn>;

  /** Save SALES with its Communication row intact and the log-past switch in the given position. */
  async function save(logPastCommunications: boolean) {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue(HELD);
    deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));
    return request(app)
      .put('/api/roles/SALES/permissions')
      .set(authHeader('admin'))
      .send({
        matrix: { Communication: { read: true, create: true, update: false, delete: false } },
        sensitive: {
          seeFinancials: false, managePayments: false, viewReports: false,
          editRecordIds: false, logPastCommunications,
        },
        toggles: {},
        scope: {},
        general: { description: '' },
      });
  }

  /** Every (action, subject) the transaction was asked to remove, across all deleteMany calls. */
  const deleted = () =>
    deleteMany.mock.calls.flatMap((c: any[]) => (c[0].where.OR ?? []) as { action: string; subject: string }[]);
  /** Every (action, subject) the transaction was asked to write. */
  const upserted = () =>
    upsert.mock.calls.map((c: any[]) => ({
      action: c[0].where.organization_id_role_action_subject.action as string,
      subject: c[0].where.organization_id_role_action_subject.subject as string,
    }));

  it('unticking it deletes the stored log_past row, and does not re-write it on the way out', async () => {
    const res = await save(false);
    expect(res.status).toBe(200);
    expect(deleted()).toContainEqual({ action: 'log_past', subject: 'Communication' });
    // Genuinely gone, not deleted and then re-upserted by the desired-grants pass.
    expect(upserted()).not.toContainEqual({ action: 'log_past', subject: 'Communication' });
    // …and the revoke is targeted, not a wipe of the subject: the baseline verb is untouched.
    expect(deleted()).not.toContainEqual({ action: 'create', subject: 'Communication' });
    expect(upserted()).toContainEqual({ action: 'create', subject: 'Communication' });
  });

  it('leaving it ticked keeps the row — so the delete above is attributable to the switch', async () => {
    const res = await save(true);
    expect(res.status).toBe(200);
    expect(deleted()).not.toContainEqual({ action: 'log_past', subject: 'Communication' });
    expect(upserted()).toContainEqual({ action: 'log_past', subject: 'Communication' });
  });
});
