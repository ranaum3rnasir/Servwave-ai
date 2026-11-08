import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// Multi-visit close-out (Q9). D15 stopped seeding `complete Job` for TECHNICIAN as a per-org
// toggle, but the Roles & Permissions page had NO cell for it - or for its four milestone
// siblings (en_route/arrive/start/reschedule) - anywhere in the view model, so an admin could
// not see or grant any of them from that page (only from the per-user Permissions page). This
// file drives the real GET/PUT handlers to prove:
//   1. GET reflects the org's ACTUAL current grant, whatever role holds it and however it's
//      conditioned (TECHNICIAN's is OWN_JOB-scoped; DISPATCHER's is unconditional - both
//      confirmed on staging, 2026-08-23).
//   2. An absent grant renders the toggle as `false`, never `undefined`/omitted.
//   3. PUT round-trips off→on→off without disturbing unrelated grants.
//   4. THE risk this contract's scope check exists to catch: a Save must never re-stamp an
//      EXISTING grant with the toggle's hardcoded seed condition. DISPATCHER holds these five
//      grants unconditionally; if a Save silently narrowed them to OWN_JOB, DISPATCHER would
//      lose the ability to act on jobs they are not personally assigned to the next time anyone
//      saved that role's page for ANY reason.
// ─────────────────────────────────────────────────────────────────────────────────────────────

const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
});

describe('GET /api/roles/TECHNICIAN/permissions - milestone-verb toggles', () => {
  it('reports completeJobs=true, with the other four off, for an org holding only complete:Job OWN_JOB-scoped', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'complete', subject: 'Job', conditions: OWN_JOB },
    ]);
    const res = await request(app).get('/api/roles/TECHNICIAN/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.toggles.completeJobs).toBe(true);
    expect(res.body.toggles.enRouteJobs).toBe(false);
    expect(res.body.toggles.arriveJobs).toBe(false);
    expect(res.body.toggles.startJobs).toBe(false);
    expect(res.body.toggles.rescheduleJobs).toBe(false);
  });

  it('renders the toggle as false (not omitted) when the org has no complete:Job row at all', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const res = await request(app).get('/api/roles/TECHNICIAN/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.toggles).toHaveProperty('completeJobs', false);
    expect(res.body.toggles).toHaveProperty('enRouteJobs', false);
    expect(res.body.toggles).toHaveProperty('arriveJobs', false);
    expect(res.body.toggles).toHaveProperty('startJobs', false);
    expect(res.body.toggles).toHaveProperty('rescheduleJobs', false);
  });

  it('reports completeJobs=true for DISPATCHER holding it UNCONDITIONALLY (the real staging shape)', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'complete', subject: 'Job', conditions: null },
    ]);
    const res = await request(app).get('/api/roles/DISPATCHER/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.toggles.completeJobs).toBe(true);
  });
});

describe('PUT /api/roles/TECHNICIAN/permissions - milestone-verb toggle round trip', () => {
  const baseBody = (toggles: Record<string, boolean>) => ({
    matrix: {},
    sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, assignOthers: false },
    toggles: {
      dashboard: false, accountSettings: false, notifications: false, modifyDoneJobs: false, cancelJobs: false,
      enRouteJobs: false, arriveJobs: false, startJobs: false, completeJobs: false, rescheduleJobs: false,
      ...toggles,
    },
    scope: {},
    general: { description: '' },
  });

  it('turning completeJobs ON persists complete:Job OWN_JOB-scoped for a role with no existing row', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/TECHNICIAN/permissions')
      .set(authHeader('admin'))
      .send(baseBody({ completeJobs: true }));

    expect(res.status).toBe(200);
    const completeCall = upsert.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.create?.subject === 'Job' && a?.create?.action === 'complete');
    expect(completeCall).toBeDefined();
    expect(completeCall.create.conditions).toEqual(OWN_JOB);
  });

  it('turning completeJobs OFF for an org that currently holds it deletes exactly that grant, nothing else', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'complete', subject: 'Job', conditions: OWN_JOB },
      // `assign Job` is a lifecycle verb outside the editor's managed surface entirely (not a
      // MODULES CRUD cell, not a SENSITIVE bundle, not a TOGGLE) - it must survive ANY Save,
      // same as the "out-of-surface verb grants are PRESERVED, never stripped" guarantee the
      // controller already documents for revise/archive/assign/etc.
      { action: 'assign', subject: 'Job', conditions: null },
    ]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/TECHNICIAN/permissions')
      .set(authHeader('admin'))
      .send(baseBody({ completeJobs: false }));

    expect(res.status).toBe(200);
    expect(deleteMany).toHaveBeenCalled();
    const deletedPairs = deleteMany.mock.calls.flatMap(
      (c: any[]) => (c[0].where.OR ?? []) as { action: string; subject: string }[],
    );
    expect(deletedPairs).toContainEqual({ action: 'complete', subject: 'Job' });
    // Out-of-surface `assign Job` is not managed by this editor at all, so it must survive -
    // only the toggle's own key should be deleted.
    expect(deletedPairs).not.toContainEqual({ action: 'assign', subject: 'Job' });
  });

  // THE regression this contract's scope check exists to catch (see file banner).
  it('does NOT narrow an existing UNCONDITIONAL grant to OWN_JOB when the toggle stays on through a Save', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'complete', subject: 'Job', conditions: null },
      { action: 'en_route', subject: 'Job', conditions: null },
    ]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    // Simulates an admin saving the DISPATCHER page for an unrelated reason (e.g. toggling
    // managePayments) with both milestone toggles left ON, exactly as GET would have reported them.
    const res = await request(app)
      .put('/api/roles/DISPATCHER/permissions')
      .set(authHeader('admin'))
      .send(baseBody({ completeJobs: true, enRouteJobs: true }));

    expect(res.status).toBe(200);
    const byAction = (action: string) =>
      upsert.mock.calls.map((c: any[]) => c[0]).find((a: any) => a?.create?.subject === 'Job' && a?.create?.action === action);

    // A null-conditions row is written as the Prisma.JsonNull sentinel, not the JS literal
    // `null` (see putRolePermissions' upsert call) - assert against that, not toBeNull().
    expect(byAction('complete').create.conditions).toEqual(Prisma.JsonNull);
    expect(byAction('en_route').create.conditions).toEqual(Prisma.JsonNull);
  });

  it('preserves an existing OWN_JOB-scoped grant as-is (not re-stamped) when the toggle stays on', async () => {
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'complete', subject: 'Job', conditions: OWN_JOB },
    ]);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({ rolePermission: { deleteMany, upsert } }));

    const res = await request(app)
      .put('/api/roles/TECHNICIAN/permissions')
      .set(authHeader('admin'))
      .send(baseBody({ completeJobs: true }));

    expect(res.status).toBe(200);
    const completeCall = upsert.mock.calls
      .map((c: any[]) => c[0])
      .find((a: any) => a?.create?.subject === 'Job' && a?.create?.action === 'complete');
    expect(completeCall.create.conditions).toEqual(OWN_JOB);
  });
});
