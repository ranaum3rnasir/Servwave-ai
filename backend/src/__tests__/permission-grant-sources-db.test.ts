/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.19 - the catalog is the only source of what a person may do.

   The old role-permission and per-person override tables are gone (migration M10): only a person's switches, and
   the fixed reads every signed-in person has, decide access. A custom role copied from Admin is an ordinary switch set; only the built-in Admin with no
   custom role is the Admin box.

   Everything goes through the public interface: the routes, called as people on built-in roles and on custom
   roles holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient, Role } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('the catalog is the only source of access (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values (every other toggle off). */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: Role; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `source-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  describe('only a person\'s switches decide what they may do', () => {
    it('does not hand a grant to a person whose switches do not carry it', async () => {
      const { org, customer } = await fx.newOrg();
      const job = await fx.addJob(org, customer);
      // Reaches every job, but holds no switch that carries the renumber grant.
      const person = await personWith(org, { view_jobs: true, jobs_scope: 'all' });
      const res = await (await person.api()).post(`/api/jobs/${job.id}/number/preview`, { number: 'J-9001' });
      expect(res.status).toBe(403);
    });

    it('lets a person whose switches carry a grant use it', async () => {
      const { org, customer } = await fx.newOrg();
      const job = await fx.addJob(org, customer);
      const dispatcher = await fx.addUser(org, 'dispatcher', 'DISPATCHER');

      const res = await (await fx.signedInAs(dispatcher)).get(`/api/jobs/${job.id}`);
      expect(res.status).toBe(200);
    });

    it('lets a person read the reference data every signed-in person reads', async () => {
      const { org } = await fx.newOrg();
      const technician = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const api = await fx.signedInAs(technician);

      for (const path of ['/api/tags', '/api/task-categories', '/api/notifications']) {
        const res = await api.get(path);
        expect(res.status, path).toBe(200);
      }
    });
  });
  describe('a custom role copied from Admin is an ordinary switch set', () => {
    it('is created holding the Admin preset, and is held to its switches: turn one off and it is refused, where the Admin box is not', async () => {
      const { org, admin } = await fx.newOrg();
      const adminApi = await fx.signedInAs(admin);

      const created = await adminApi.post('/api/roles', { label: 'Office Lead', base_role: 'ADMIN', clone_grants_from: 'ADMIN' });
      expect(created.status).toBe(201);
      const key = created.body.role as string;
      const stored = new Map(
        (await db.permissionRoleSwitch.findMany({ where: { organization_id: org, role_key: key } })).map((r) => [r.switch_key, r.value]),
      );
      // The Admin box has no set of its own; the copy holds the Admin preset's values, one by one.
      expect(stored.get('view_users')).toBe(true);
      expect(stored.get('jobs_scope')).toBe('all');

      const lead = await fx.addUser(org, 'lead', 'ADMIN', { customRoleId: created.body.id });
      expect((await (await fx.signedInAs(lead)).get('/api/users')).status).toBe(200);

      await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { view_users: false }, actorId: null, reason: 'manual' });
      expect((await (await fx.signedInAs(lead)).get('/api/users')).status).toBe(403);
      expect((await adminApi.get('/api/users')).status).toBe(200);
    });

    it('is not the Admin box when it approves overtime: only the Admin box, or a person with the approver flag, may', async () => {
      const { org, admin } = await fx.newOrg();
      const worker = await fx.addUser(org, 'worker', 'TECHNICIAN');
      const role = await fx.addCustomRole(org, 'admin-copy', 'ADMIN');
      const copy = await fx.addUser(org, 'copy', 'ADMIN', { customRoleId: role.id });
      const approver = await fx.addUser(org, 'approver', 'TECHNICIAN');
      await db.user.update({ where: { id: approver.id }, data: { can_approve_clock_overrides: true } });
      const review = { user_id: worker.id, period_key: '2026-W41', state: 'APPROVED' };

      expect((await (await fx.signedInAs(copy)).post('/api/timeclock/ot-reviews', review)).status).toBe(403);
      expect((await (await fx.signedInAs(admin)).post('/api/timeclock/ot-reviews', review)).status).toBe(200);
      expect((await (await fx.signedInAs(approver)).post('/api/timeclock/ot-reviews', review)).status).toBe(200);
    });
  });
});
