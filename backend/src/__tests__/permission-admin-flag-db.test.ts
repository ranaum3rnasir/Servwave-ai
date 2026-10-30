/* =============================================================================
   Roles & Permissions alignment, AL-03 (P15): Admin is a flag on the person, never a role name.

   Everything goes through the public interface: the session read, the Users routes, called as the company's Admin, and
   migration M1 run against real rows the way the deploy runs it. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide email mock leaves out the invitation; no mail is sent from here.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

import { switchFixture, type Person } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;
// The migration is two statements; the data move is the DO block (the column is already there in a migrated database).
const MIGRATION_SQL = join(__dirname, '..', '..', 'prisma', 'migrations', '20261028100200_user_is_admin_flag', 'migration.sql');

const backfill = () => {
  const sql = readFileSync(MIGRATION_SQL, 'utf8');
  return sql.slice(sql.indexOf('DO $al_03$'));
};

suite('Admin is a flag on the person (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    // A new person gets a mailbox address, so this environment has a mailbox domain.
    const { env } = await import('../config/env.js');
    Object.assign(env, { MAILBOX_DOMAIN: 'staging.mail.test.com' });
    await import('../app.js');
  }, 600_000);
  afterAll(() => fx.cleanup());

  const manageAll = (rules: Array<{ action: string; subject: string }>) => rules.some((r) => r.action === 'manage' && r.subject === 'all');
  const rulesOf = async (person: Person) => (await (await fx.signedInAs(person)).get('/api/auth/me')).body.abilityRules as Array<{ action: string; subject: string }>;
  const flagOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { is_admin: true } })).is_admin;

  describe('who is an Admin', () => {
    it('is the flag: a person with it on holds full access whatever role they carry, and a person named ADMIN with it off does not', async () => {
      const { org } = await fx.newOrg();
      const flaggedSales = await fx.addUser(org, 'flagged', 'SALES', { isAdmin: true });
      const unflaggedAdminRole = await fx.addUser(org, 'unflagged', 'ADMIN', { isAdmin: false });

      expect(manageAll(await rulesOf(flaggedSales))).toBe(true);
      expect(manageAll(await rulesOf(unflaggedAdminRole))).toBe(false);
    });

    it('tells the screens through the session: is_admin is on the person they read', async () => {
      const { org, admin } = await fx.newOrg();
      const sales = await fx.addUser(org, 'seller', 'SALES');
      expect((await (await fx.signedInAs(admin)).get('/api/auth/me')).body.user.is_admin).toBe(true);
      expect((await (await fx.signedInAs(sales)).get('/api/auth/me')).body.user.is_admin).toBe(false);
    });

    it('lists the flag on the Users page rows', async () => {
      const { org, admin } = await fx.newOrg();
      const sales = await fx.addUser(org, 'seller', 'SALES');
      const rows = (await (await fx.signedInAs(admin)).get('/api/users')).body.users as Array<{ id: string; is_admin: boolean }>;
      expect(rows.find((r) => r.id === admin.id)?.is_admin).toBe(true);
      expect(rows.find((r) => r.id === sales.id)?.is_admin).toBe(false);
    });
  });

  describe('giving and taking it away', () => {
    it('lets an Admin grant it to a person on any role and take it away again, leaving the role alone', async () => {
      const { org, admin } = await fx.newOrg();
      const sales = await fx.addUser(org, 'seller', 'SALES');
      const api = await fx.signedInAs(admin);

      expect((await api.patch(`/api/users/${sales.id}`, { is_admin: true })).status).toBe(200);
      expect(await flagOf(sales.id)).toBe(true);
      expect((await db.user.findUniqueOrThrow({ where: { id: sales.id } })).role).toBe('SALES');
      expect(manageAll(await rulesOf(sales))).toBe(true);

      expect((await api.patch(`/api/users/${sales.id}`, { is_admin: false })).status).toBe(200);
      expect(await flagOf(sales.id)).toBe(false);
      expect(manageAll(await rulesOf(sales))).toBe(false);
    });

    it('makes a person an Admin when the Administrator role is picked, and takes it away when another role is picked', async () => {
      const { org, admin } = await fx.newOrg();
      const sales = await fx.addUser(org, 'seller', 'SALES');
      const api = await fx.signedInAs(admin);

      expect((await api.patch(`/api/users/${sales.id}`, { role: 'ADMIN', custom_role_id: null })).status).toBe(200);
      expect(await flagOf(sales.id)).toBe(true);
      expect((await api.patch(`/api/users/${sales.id}`, { role: 'TECHNICIAN' })).status).toBe(200);
      expect(await flagOf(sales.id)).toBe(false);
    });

    it('leaves the flag alone when an Admin on a built-in role is given another role', async () => {
      const { org, admin } = await fx.newOrg();
      const flagged = await fx.addUser(org, 'flagged', 'SALES', { isAdmin: true });
      expect((await (await fx.signedInAs(admin)).patch(`/api/users/${flagged.id}`, { role: 'DISPATCHER' })).status).toBe(200);
      expect(await flagOf(flagged.id)).toBe(true);
    });

    it('refuses to switch the flag off for someone in the Administrator role, asking for another role', async () => {
      const { org, admin } = await fx.newOrg();
      const second = await fx.addUser(org, 'second', 'ADMIN');
      const res = await (await fx.signedInAs(admin)).patch(`/api/users/${second.id}`, { is_admin: false });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/another role/i);
      expect(await flagOf(second.id)).toBe(true);
    });

    it('refuses to change your own flag', async () => {
      const { org } = await fx.newOrg();
      // An Admin who is not the company's Owner: the Owner is refused before that, with 409 (AL-16).
      const self = await fx.addUser(org, 'second', 'ADMIN');
      const res = await (await fx.signedInAs(self)).patch(`/api/users/${self.id}`, { is_admin: false });
      expect(res.status).toBe(400);
      expect(await flagOf(self.id)).toBe(true);
    });

    it('leaves who is an Admin to Admins: a copy of Admin that holds Manage roles can neither give the flag nor take it away', async () => {
      const { org } = await fx.newOrg();
      // The Admin acted on is not the company's Owner, whom no one removes (409, AL-16).
      const admin = await fx.addUser(org, 'target', 'ADMIN');
      // A copy of Admin has every switch but is not an Admin: it can edit people and manage roles, and still cannot make or unseat an Admin.
      const copy = await fx.addCustomRole(org, 'admin-copy', 'ADMIN', { copyGrants: false });
      const actor = await fx.addUser(org, 'copy', 'ADMIN', { customRoleId: copy.id, basedOnRoleKey: copy.key });
      const colleague = await fx.addUser(org, 'colleague', 'SALES');
      const api = await fx.signedInAs(actor);

      expect((await api.patch(`/api/users/${admin.id}`, { is_admin: false, role: 'SALES' })).status).toBe(403);
      expect(await flagOf(admin.id)).toBe(true);
      expect((await api.patch(`/api/users/${colleague.id}`, { is_admin: true })).status).toBe(403);
      expect(await flagOf(colleague.id)).toBe(false);
      expect((await api.post('/api/users/invite', { first_name: 'New', last_name: 'Admin', email: `x-${org.slice(0, 6)}@example.test`, role: 'SALES', is_admin: true })).status).toBe(403);
      // Nor can it deactivate an Admin.
      expect((await api.delete(`/api/users/${admin.id}`)).status).toBe(403);
    });

    it('lets an Admin take the flag from another Admin while one stays, and refuses to take it from the last', async () => {
      const { org, admin } = await fx.newOrg();
      const second = await fx.addUser(org, 'second', 'SALES', { isAdmin: true });
      const api = await fx.signedInAs(admin);

      expect((await api.patch(`/api/users/${second.id}`, { is_admin: false, role: 'SALES' })).status).toBe(200);
      expect(await flagOf(second.id)).toBe(false);
      // Alone now, the Admin cannot take their own flag away (and nobody else is an Admin to do it).
      expect((await api.patch(`/api/users/${admin.id}`, { is_admin: false, role: 'SALES' })).status).toBeGreaterThanOrEqual(400);
      expect(await flagOf(admin.id)).toBe(true);
    });

    it('leaves the flag alone when a name is edited', async () => {
      const { org, admin } = await fx.newOrg();
      // A row on the Administrator role that carries no flag (made by an older build in the overlap): a name edit must not promote it.
      const odd = await fx.addUser(org, 'odd', 'ADMIN', { isAdmin: false });
      const api = await fx.signedInAs(admin);
      expect((await api.patch(`/api/users/${odd.id}`, { first_name: 'Renamed' })).status).toBe(200);
      expect(await flagOf(odd.id)).toBe(false);
    });

    it('creates an Administrator-role person as an Admin, another role as not, and honours an explicit flag', async () => {
      const { org, admin } = await fx.newOrg();
      const api = await fx.signedInAs(admin);
      const invite = (extra: object) => api.post('/api/users/invite', { first_name: 'New', last_name: 'Person', email: `n-${Math.random().toString(36).slice(2)}-${org.slice(0, 6)}@example.test`, ...extra });

      const asAdmin = await invite({ role: 'ADMIN' });
      expect(asAdmin.status).toBe(201);
      expect(await flagOf(asAdmin.body.user.id)).toBe(true);
      const asSales = await invite({ role: 'SALES' });
      expect(asSales.status).toBe(201);
      expect(await flagOf(asSales.body.user.id)).toBe(false);
      const flaggedSales = await invite({ role: 'SALES', is_admin: true });
      expect(flaggedSales.status).toBe(201);
      expect(await flagOf(flaggedSales.body.user.id)).toBe(true);
      expect((await invite({ role: 'ADMIN', is_admin: false })).status).toBe(400);
    });
  });

  describe('migration M1', () => {
    it('sets the flag for exactly the people who were Admins: role Admin and no custom role', async () => {
      const { org } = await fx.newOrg();
      const copy = await fx.addCustomRole(org, 'admin-copy', 'ADMIN', { copyGrants: false });
      const box = await fx.addUser(org, 'box', 'ADMIN', { isAdmin: false });
      const derived = await fx.addUser(org, 'derived', 'ADMIN', { customRoleId: copy.id, isAdmin: false });
      const sales = await fx.addUser(org, 'seller', 'SALES', { isAdmin: false });

      await db.$executeRawUnsafe(backfill());

      expect(await flagOf(box.id)).toBe(true);
      expect(await flagOf(derived.id)).toBe(false);
      expect(await flagOf(sales.id)).toBe(false);
      // A second run changes nothing.
      await db.$executeRawUnsafe(backfill());
      expect(await flagOf(derived.id)).toBe(false);
    });
  });
});
