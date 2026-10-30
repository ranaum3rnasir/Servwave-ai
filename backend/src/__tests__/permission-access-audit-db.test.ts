/* =============================================================================
   Roles & Permissions, ticket 25 (finding M6, decision D2): access changes are recorded.

   Making or removing an Admin, a change of a person's role, and an Owner change each write ONE audit row: who did it (actor),
   to whom (the person), and what they held before and after. The row is written in the same database transaction as the
   change, so a change whose record can't be written does not happen. There is no screen for the history yet (D2: record now,
   show later), so the record is read where it is kept: audit_logs.

   Every change goes through the real routes, called as the company's Owner. Only the auth provider is replaced. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide email mock leaves out the invitation and the Owner's alert; neither sends from here (permission-admin-change-email-db
// covers the alert).
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
  sendAdminChangeAlertEmail: vi.fn().mockResolvedValue(true),
}));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

/** The record's actions for a person's access, and for the company's Owner. */
const ACCESS_ACTIONS = ['user.admin_granted', 'user.admin_removed', 'user.role_changed'];

suite('access changes are recorded (real database, real routes)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    const { env } = await import('../config/env.js');
    // A new person gets a mailbox address, so this environment has a mailbox domain.
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
    await import('../app.js');
    // A switch that makes the database refuse an audit row for one company: the record's write fails, nothing else does.
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION test_t25_refuse_audit_row() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test: the audit write fails'; END $$`);
  }, 600_000);
  afterAll(() => fx.cleanup());

  /** The access rows written about this person, oldest first. */
  const accessRows = (org: string, target: string) =>
    db.auditLog.findMany({
      where: { org_id: org, resource_id: target, action: { in: ACCESS_ACTIONS } },
      orderBy: { created_at: 'asc' },
      select: { actor_id: true, actor_email: true, action: true, resource_type: true, resource_id: true, metadata: true },
    });

  const held = (role: string, isAdmin: boolean, customRoleId: string | null = null) => ({ role, custom_role_id: customRoleId, is_admin: isAdmin });

  /** While this runs, the database refuses every audit row for the company. */
  async function whileAuditWritesFail<T>(org: string, run: () => Promise<T>): Promise<T> {
    const name = `test_t25_refuse_${org.replace(/-/g, '')}`;
    await db.$executeRawUnsafe(
      `CREATE TRIGGER ${name} BEFORE INSERT ON audit_logs FOR EACH ROW WHEN (NEW.org_id = '${org}'::uuid) EXECUTE FUNCTION test_t25_refuse_audit_row()`,
    );
    try {
      return await run();
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS ${name} ON audit_logs`);
    }
  }

  const flagOf = async (owner: Person, id: string) => (await (await fx.signedInAs(owner)).get(`/api/users/${id}`)).body.user as { is_admin: boolean; role: string; custom_role_id: string | null };

  describe('making or removing an Admin', () => {
    it('the Admin switch on writes one row: actor, person, before and after', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const seller = await fx.addUser(org, 'seller', 'SALES');
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${seller.id}`, { is_admin: true })).status).toBe(200);

      expect(await accessRows(org, seller.id)).toEqual([{
        actor_id: owner.id, actor_email: owner.email, action: 'user.admin_granted', resource_type: 'User', resource_id: seller.id,
        metadata: { before: held('SALES', false), after: held('SALES', true) },
      }]);
    });

    it('the Admin switch off writes one row', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const seller = await fx.addUser(org, 'seller', 'SALES', { isAdmin: true });
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${seller.id}`, { is_admin: false })).status).toBe(200);

      expect(await accessRows(org, seller.id)).toEqual([{
        actor_id: owner.id, actor_email: owner.email, action: 'user.admin_removed', resource_type: 'User', resource_id: seller.id,
        metadata: { before: held('SALES', true), after: held('SALES', false) },
      }]);
    });

    it('moving a person onto the Administrator role, and off it again, writes one row each', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const seller = await fx.addUser(org, 'seller', 'SALES');
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${seller.id}`, { role: 'ADMIN' })).status).toBe(200);
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${seller.id}`, { role: 'TECHNICIAN' })).status).toBe(200);

      expect((await accessRows(org, seller.id)).map((r) => [r.action, r.actor_id, r.metadata])).toEqual([
        ['user.admin_granted', owner.id, { before: held('SALES', false), after: held('ADMIN', true) }],
        ['user.admin_removed', owner.id, { before: held('ADMIN', true), after: held('TECHNICIAN', false) }],
      ]);
    });

    it('creating a person as an Admin writes one row with nothing before', async () => {
      const { org, tag, admin: owner } = await fx.newOrg();
      const id = randomUUID();
      (supabaseAdmin.auth.admin.createUser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ data: { user: { id } }, error: null });
      const res = await (await fx.signedInAs(owner)).post('/api/users', {
        email: `made-${tag}@example.test`, password: 'a-long-password', first_name: 'Made', last_name: 'Admin', role: 'SALES', is_admin: true,
      });
      expect(res.status).toBe(201);

      expect((await accessRows(org, id)).map((r) => [r.action, r.actor_id, r.metadata])).toEqual([
        ['user.admin_granted', owner.id, { before: null, after: held('SALES', true) }],
      ]);
    });
  });

  describe('a change of role', () => {
    it('moving a person onto a custom role writes one row', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const role = await fx.addCustomRole(org, `crew-${org.slice(0, 6)}`, 'TECHNICIAN');
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${tech.id}`, { role: 'TECHNICIAN', custom_role_id: role.id })).status).toBe(200);

      expect((await accessRows(org, tech.id)).map((r) => [r.action, r.actor_id, r.metadata])).toEqual([
        ['user.role_changed', owner.id, { before: held('TECHNICIAN', false), after: held('TECHNICIAN', false, role.id) }],
      ]);
    });

    it('inviting a person writes one row with the role they start on', async () => {
      const { org, tag, admin: owner } = await fx.newOrg();
      const res = await (await fx.signedInAs(owner)).post('/api/users/invite', {
        email: `invited-${tag}@example.test`, first_name: 'Invited', last_name: 'Tech', role: 'TECHNICIAN',
      });
      expect(res.status).toBe(201);
      const id = res.body.user.id as string;

      expect((await accessRows(org, id)).map((r) => [r.action, r.actor_id, r.metadata])).toEqual([
        ['user.role_changed', owner.id, { before: null, after: held('TECHNICIAN', false) }],
      ]);
    });

    it('saving a person\'s switches as a new role moves them onto it, and writes one row', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const res = await (await fx.signedInAs(owner)).post(`/api/users/${tech.id}/permissions/save-as-role`, { label: `Saved ${org.slice(0, 6)}` });
      expect(res.status).toBe(201);
      const roleId = (await db.customRole.findFirstOrThrow({ where: { organization_id: org, label: `Saved ${org.slice(0, 6)}` } })).id;

      expect((await accessRows(org, tech.id)).map((r) => [r.action, r.actor_id, r.metadata])).toEqual([
        ['user.role_changed', owner.id, { before: held('TECHNICIAN', false), after: held('TECHNICIAN', false, roleId) }],
      ]);
    });

    it('an edit that changes no access (a name, or the role the person already holds) writes none', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${tech.id}`, { first_name: 'Renamed' })).status).toBe(200);
      expect((await (await fx.signedInAs(owner)).patch(`/api/users/${tech.id}`, { role: 'TECHNICIAN' })).status).toBe(200);

      expect(await accessRows(org, tech.id)).toEqual([]);
    });
  });

  describe('a change with no record does not happen', () => {
    it('the Admin switch: the audit write fails, the person is not made an Admin', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const seller = await fx.addUser(org, 'seller', 'SALES');
      const res = await whileAuditWritesFail(org, async () => (await fx.signedInAs(owner)).patch(`/api/users/${seller.id}`, { is_admin: true }));

      expect(res.status).toBe(500);
      expect((await flagOf(owner, seller.id)).is_admin).toBe(false);
    });

    it('taking Admin away: the audit write fails, the person stays an Admin', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const other = await fx.addUser(org, 'other', 'SALES', { isAdmin: true });
      const res = await whileAuditWritesFail(org, async () => (await fx.signedInAs(owner)).patch(`/api/users/${other.id}`, { is_admin: false }));

      expect(res.status).toBe(500);
      expect((await flagOf(owner, other.id)).is_admin).toBe(true);
    });

    it('a change of role: the audit write fails, the person keeps their role', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const role = await fx.addCustomRole(org, `crew-${org.slice(0, 6)}`, 'TECHNICIAN');
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const res = await whileAuditWritesFail(org, async () =>
        (await fx.signedInAs(owner)).patch(`/api/users/${tech.id}`, { role: 'TECHNICIAN', custom_role_id: role.id }));

      expect(res.status).toBe(500);
      expect((await flagOf(owner, tech.id)).custom_role_id).toBeNull();
    });

    it('an invite: the audit write fails, the person is not added', async () => {
      const { org, tag, admin: owner } = await fx.newOrg();
      const email = `invited-${tag}@example.test`;
      const res = await whileAuditWritesFail(org, async () =>
        (await fx.signedInAs(owner)).post('/api/users/invite', { email, first_name: 'Invited', last_name: 'Admin', role: 'SALES', is_admin: true }));

      expect(res.status).toBe(500);
      const people = (await (await fx.signedInAs(owner)).get('/api/users')).body.users as Array<{ email: string }>;
      expect(people.map((p) => p.email)).not.toContain(email);
    });

    it('save as role: the audit write fails, the person stays on their role and no role is made', async () => {
      const { org, admin: owner } = await fx.newOrg();
      const tech = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const label = `Saved ${org.slice(0, 6)}`;
      const res = await whileAuditWritesFail(org, async () =>
        (await fx.signedInAs(owner)).post(`/api/users/${tech.id}/permissions/save-as-role`, { label }));

      expect(res.status).toBe(500);
      expect((await flagOf(owner, tech.id)).custom_role_id).toBeNull();
      const roles = (await (await fx.signedInAs(owner)).get('/api/roles')).body as Array<{ label: string }>;
      expect(roles.map((r) => r.label)).not.toContain(label);
    });
  });

  describe('an Owner change', () => {
    it('a new company\'s first Owner is recorded in the same write, and the company\'s purge keeps the record', async () => {
      const url = new URL(process.env.TEST_DATABASE_URL!);
      const { env } = await import('../config/env.js');
      Object.assign(env, { DATABASE_URL: process.env.TEST_DATABASE_URL, E2E_ALLOWED_DB_HOSTS: url.hostname, E2E_ALLOWED_DB_REF: url.pathname.slice(1) });
      const authAdmin = supabaseAdmin.auth.admin as unknown as { createUser: ReturnType<typeof vi.fn>; deleteUser: ReturnType<typeof vi.fn> };
      authAdmin.createUser.mockResolvedValueOnce({ data: { user: { id: randomUUID() } }, error: null });
      authAdmin.deleteUser.mockResolvedValue({ data: null, error: null });
      const { provisionTestOrg, teardownTestOrg } = await import('../lib/e2e-org.js');

      const made = await provisionTestOrg();
      const ownerRows = () => db.auditLog.findMany({
        where: { org_id: made.organizationId, action: 'owner.assigned' },
        select: { actor_id: true, action: true, resource_type: true, resource_id: true, metadata: true },
      });
      const expected = [{
        actor_id: null, action: 'owner.assigned', resource_type: 'User', resource_id: made.adminUserId,
        metadata: { before: { owner_user_id: null }, after: { owner_user_id: made.adminUserId }, by: 'new company' },
      }];
      expect(await ownerRows()).toEqual(expected);

      await teardownTestOrg(made.organizationId, { authSweep: 'org' });
      expect(await db.organization.count({ where: { id: made.organizationId } })).toBe(0);
      expect(await ownerRows()).toEqual(expected);
    }, 120_000);
  });
});
