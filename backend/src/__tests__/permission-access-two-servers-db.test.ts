/* =============================================================================
   Roles & Permissions security, ticket 37 (spec story 67, ticket 22's open F5): a change to someone's access is seen by
   every server on its next request.

   Each server keeps the people it signed in, and their switches, in its own memory for up to a minute. A change made on one
   server used to clear only that server's memory, so another server went on letting the person in, or using their old
   switches, until its copy ran out. Both copies are now keyed on a version stamp read from the database on every request, so a
   change made anywhere moves the stamp every server reads.

   Two servers in one test process: the app is loaded twice (vi.resetModules), so each copy has its own sign-in and switch
   memory, as two server processes would, and both use the same real database. The Admin works on server A; the person's
   requests go to server B, which signed them in (and cached their switches) before the change. One row per kind of change:
   a switch of their role, their own switch, a move to another role, the Admin flag taken away, deactivation, revoked sign-in,
   and a change written straight to the database by no route at all.
   Real migrated database (TEST_DATABASE_URL); skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
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
// The mail edge: an Admin change emails the Owner; nothing leaves the test.
vi.mock('../lib/email', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  sendAdminChangeAlertEmail: vi.fn().mockResolvedValue(true),
  sendUserInviteEmail: vi.fn().mockResolvedValue(true),
}));

import { switchFixture, type Person } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

type Mock = ReturnType<typeof vi.fn>;
type Call = request.Test;
interface Server {
  as(person: Person): { get(path: string): Call; put(path: string, body: object): Call; patch(path: string, body: object): Call; post(path: string, body?: object): Call; delete(path: string, body?: object): Call };
  providerAdmin: { listUsers: Mock; deleteUser: Mock; signOut: Mock };
}

/** Everyone the identity provider knows, by the bearer token it gives them: `Bearer t37-<id>`. */
const known = new Map<string, Person>();

/** One copy of the app with its own memory, its sign-in answered by the stubbed identity provider. */
async function loadServer(): Promise<Server> {
  const app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  const { supabaseAdmin } = await import('../lib/supabase.js');
  (supabaseAdmin.auth.getUser as Mock).mockImplementation(async (token: string) => {
    const person = known.get(token.replace(/^t37-/, ''));
    return person
      ? { data: { user: { id: person.id, email: person.email } }, error: null }
      : { data: { user: null }, error: { message: 'invalid token' } };
  });
  const admin = supabaseAdmin.auth.admin as unknown as Server['providerAdmin'];
  admin.deleteUser.mockResolvedValue({ data: null, error: null });
  admin.signOut.mockResolvedValue({ error: null });
  admin.listUsers.mockResolvedValue({ data: { users: [], nextPage: null }, error: null });
  return {
    providerAdmin: admin,
    as(person: Person) {
      known.set(person.id, person);
      const bearer = `Bearer t37-${person.id}`;
      return {
        get: (path) => request(app).get(path).set('Authorization', bearer),
        put: (path, body) => request(app).put(path).set('Authorization', bearer).send(body),
        patch: (path, body) => request(app).patch(path).set('Authorization', bearer).send(body),
        post: (path, body = {}) => request(app).post(path).set('Authorization', bearer).send(body),
        delete: (path, body) => {
          const call = request(app).delete(path).set('Authorization', bearer);
          return body === undefined ? call : call.send(body);
        },
      };
    },
  };
}

suite('a change to someone\'s access reaches every server on its next request (real database, two servers)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let A: Server;
  let B: Server;

  beforeAll(async () => {
    A = await loadServer();
    vi.resetModules();
    B = await loadServer();
  }, 180_000);
  afterAll(() => fx.cleanup());

  interface Case {
    change: string;
    /** The person: a Technician on a role made from blank that holds View customers, or an Admin when `admin`. */
    admin?: boolean;
    /** What the person asks server B for, before and after. */
    probe: string;
    before: number;
    after: number;
    /** The change, made by the company's Owner on server A (or straight in the database). */
    make(ctx: { org: string; owner: Person; person: Person; roleKey: string }): Promise<void>;
  }

  const CASES: Case[] = [
    {
      change: 'a switch of their role is turned off',
      probe: '/api/customers', before: 200, after: 403,
      async make({ owner, roleKey }) {
        const res = await A.as(owner).put(`/api/roles/${roleKey}/permissions`, { values: { view_customers: false } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      },
    },
    {
      change: 'their own switch is turned off',
      probe: '/api/customers', before: 200, after: 403,
      async make({ owner, person }) {
        const res = await A.as(owner).put(`/api/users/${person.id}/permissions`, { values: { view_customers: false } });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      },
    },
    {
      change: 'they are moved to another role',
      probe: '/api/customers', before: 200, after: 403,
      async make({ org, owner, person }) {
        const other = await fx.addCustomRole(org, `t37-other-${person.id.slice(0, 6)}`, 'TECHNICIAN', { madeFromBlank: true });
        const res = await A.as(owner).patch(`/api/users/${person.id}`, { custom_role_id: other.id });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      },
    },
    {
      change: 'the Admin flag is taken away',
      admin: true,
      probe: '/api/roles', before: 200, after: 403,
      async make({ owner, person }) {
        const res = await A.as(owner).patch(`/api/users/${person.id}`, { is_admin: false });
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      },
    },
    {
      change: 'they are deactivated',
      probe: '/api/customers', before: 200, after: 403,
      async make({ owner, person }) {
        const res = await A.as(owner).delete(`/api/users/${person.id}`, {});
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      },
    },
    {
      change: 'their sign-in is revoked',
      probe: '/api/customers', before: 200, after: 401,
      async make({ owner, person }) {
        A.providerAdmin.listUsers.mockResolvedValueOnce({ data: { users: [{ id: person.id, email: person.email }], nextPage: null }, error: null });
        const res = await A.as(owner).post(`/api/users/${person.id}/revoke-login`);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
      },
    },
    {
      change: 'their role is changed straight in the database, by no route',
      probe: '/api/customers', before: 200, after: 403,
      async make({ org, roleKey }) {
        await db.permissionRoleSwitch.updateMany({ where: { organization_id: org, role_key: roleKey, switch_key: 'view_customers' }, data: { value: false } });
      },
    },
  ];

  it.each(CASES)('$change: server B sees it on the very next request', async (c) => {
    const { org, admin: owner } = await fx.newOrg();
    const roleKey = `t37-${Math.random().toString(36).slice(2, 8)}`;
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, roleKey, { view_customers: true });
    const person = await fx.addUser(org, 'tess', 'TECHNICIAN', { customRoleId: role.id, isAdmin: c.admin ?? false });

    // Server B signs the person in and uses their switches, and so holds both in memory.
    expect((await B.as(person).get(c.probe)).status).toBe(c.before);
    expect((await B.as(person).get(c.probe)).status).toBe(c.before);

    await c.make({ org, owner, person, roleKey });

    const next = await B.as(person).get(c.probe);
    expect(next.status, JSON.stringify(next.body)).toBe(c.after);
  });

  it('keeps serving from memory while nothing changed (the stamp matches): no fresh sign-in with the provider', async () => {
    const { org } = await fx.newOrg();
    const roleKey = `t37-${Math.random().toString(36).slice(2, 8)}`;
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, roleKey, { view_customers: true });
    const person = await fx.addUser(org, 'stan', 'TECHNICIAN', { customRoleId: role.id });
    const { supabaseAdmin } = await import('../lib/supabase.js');
    const getUser = supabaseAdmin.auth.getUser as Mock;
    expect((await B.as(person).get('/api/customers')).status).toBe(200);
    const calls = getUser.mock.calls.length;
    expect((await B.as(person).get('/api/customers')).status).toBe(200);
    expect((await B.as(person).get('/api/customers')).status).toBe(200);
    expect(getUser.mock.calls.length).toBe(calls);
  });
});
