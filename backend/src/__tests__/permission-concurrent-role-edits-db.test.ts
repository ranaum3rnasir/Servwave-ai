/* =============================================================================
   Roles & Permissions security, ticket 37 (spec story 69): two Admins editing the same role at once both keep their edit.

   A save read the role's current values before its transaction, then checked the new set against the catalog and wrote it.
   Two saves running together each read the values from before the other: the second checked its change against a role that
   no longer existed, and refused (or allowed) it on that stale picture. Each save now takes the role for itself inside its
   transaction and reads the values there, so it sees what the save before it committed.

   The two requests run truly at once: the first save is held mid-transaction (its write waits on a row this test keeps locked)
   while the second arrives; then the lock is let go. The second save turns on Create jobs, which needs Edit jobs, the switch
   the first save turns on: read against the committed values it is refused, read after the first save it is allowed. The same
   holds for a person's own switches, edited by two Admins at once.
   Real migrated database (TEST_DATABASE_URL); skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import type request from 'supertest';

const { realClient } = vi.hoisted(() => {
  // This one client is both the test's and the app's (the mock below). A case needs several connections at the same time:
  // the holder's open transaction, the first save's transaction waiting on it, the second save (its sign-in reads and its own
  // transaction) and the pg_stat_activity probes. Prisma sizes its default pool from the machine's CPU count, which is 3 on a
  // small CI machine: the saves then wait for a connection instead of for the lock, and the case times out. The suite states
  // the pool it needs, so it runs the same on any machine.
  const POOL = 10;
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(url);
    pooled.searchParams.set('connection_limit', String(POOL));
    return new PrismaClient({ datasources: { db: { url: pooled.toString() } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { supabaseAdmin } from '../lib/supabase';
import { findSwitch } from '../lib/permissions/switches/catalog';
import { slugifyRoleKey } from '../lib/permissions/effectiveRole';

const suite = realClient ? describe : describe.skip;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

suite('concurrent edits of the same role, or the same person, both survive (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  it('reads the catalog the case stands on: Create jobs needs Edit jobs', () => {
    expect(findSwitch('create_jobs')?.requires).toContain('edit_jobs');
    expect(findSwitch('edit_jobs')?.requires).toEqual(['view_jobs']);
  });

  /**
   * Two Admins signed in at once. The fixture's sign-in answers one identity for every token (the last one asked for), so the
   * provider stub here answers each token with its own person, and both requests can be in flight together.
   */
  async function twoAdmins(a: Person, b: Person) {
    const first = await fx.signedInAs(a);
    const second = await fx.signedInAs(b);
    const byToken = new Map([a, b].map((p) => [`switches-${p.id}`, p]));
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockImplementation(async (token: string) => {
      const p = byToken.get(token);
      return p ? { data: { user: { id: p.id, email: p.email } }, error: null } : { data: { user: null }, error: { message: 'invalid' } };
    });
    return { first, second };
  }

  /** The backends waiting on a lock held by `pid`. */
  async function waitingOn(pid: number): Promise<number[]> {
    const rows = await db.$queryRawUnsafe<{ pid: number }[]>(
      `SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))`, pid,
    );
    return rows.map((r) => r.pid);
  }

  async function until<T>(what: string, probe: () => Promise<T | undefined>, ms = 8_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
      const v = await probe();
      if (v !== undefined) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
      await sleep(20);
    }
  }

  /**
   * Runs the first save while `hold` keeps it waiting mid-transaction, sends the second while it waits, and lets go once the
   * second has either answered or is waiting behind the first. Answers both responses.
   */
  async function together(
    hold: (tx: Parameters<Parameters<PrismaClient['$transaction']>[0]>[0]) => Promise<void>,
    first: () => request.Test,
    second: () => request.Test,
  ): Promise<[request.Response, request.Response]> {
    let letGo!: () => void;
    const released = new Promise<void>((r) => { letGo = r; });
    let holderPid!: number;
    const ROLLBACK = new Error('the holder writes nothing');
    const holder = db.$transaction(async (tx) => {
      holderPid = (await tx.$queryRawUnsafe<{ pid: number }[]>('SELECT pg_backend_pid() AS pid'))[0]!.pid;
      await hold(tx);
      await released;
      throw ROLLBACK;
    }, { timeout: 30_000 }).catch((e) => { if (e !== ROLLBACK) throw e; });

    await until('the holder', async () => holderPid);
    const a = first().then((r) => r);
    const firstPid = await until('the first save to wait on the held row', async () => (await waitingOn(holderPid))[0]);
    let secondAnswered = false;
    const b = second().then((r) => { secondAnswered = true; return r; });
    // The second save either answers on its own (it did not wait for the first) or waits behind it.
    await until('the second save to answer or wait', async () => (secondAnswered || (await waitingOn(firstPid)).length > 0 ? true : undefined));
    letGo();
    await holder;
    return Promise.all([a, b]);
  }

  it('two Admins saving different switches of one role: both changes are kept', async () => {
    const { org, admin } = await fx.newOrg();
    const other = await fx.addUser(org, 'ada', 'ADMIN', { isAdmin: true });
    const key = `t37-race-${Math.random().toString(36).slice(2, 8)}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, key, { view_jobs: true, edit_jobs: false, create_jobs: false });
    const { first, second } = await twoAdmins(admin, other);
    const firstPut = first.put;
    const secondPut = second.put;

    const [a, b] = await together(
      (tx) => tx.$queryRawUnsafe(
        `SELECT 1 FROM permission_role_switches WHERE organization_id = $1::uuid AND role_key = $2 AND switch_key = 'edit_jobs' FOR UPDATE`, org, key,
      ).then(() => undefined),
      () => firstPut(`/api/roles/${key}/permissions`, { values: { edit_jobs: true } }),
      () => secondPut(`/api/roles/${key}/permissions`, { values: { create_jobs: true } }),
    );
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const rows = await db.permissionRoleSwitch.findMany({
      where: { organization_id: org, role_key: key, switch_key: { in: ['edit_jobs', 'create_jobs'] } }, select: { switch_key: true, value: true },
    });
    expect(Object.fromEntries(rows.map((r) => [r.switch_key, r.value]))).toEqual({ edit_jobs: true, create_jobs: true });
    // The second save's answer already holds the first save's switch: it read the role after it.
    expect(b.body.values.edit_jobs).toBe(true);
  });

  it('two Admins saving different switches of one person: both changes are kept', async () => {
    const { org, admin } = await fx.newOrg();
    const other = await fx.addUser(org, 'abe', 'ADMIN', { isAdmin: true });
    const key = `t37-crew-${Math.random().toString(36).slice(2, 8)}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, key, { view_jobs: true, edit_jobs: false, create_jobs: false });
    const person = await fx.addUser(org, 'pia', 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
    const { first, second } = await twoAdmins(admin, other);
    const firstPut = first.put;
    const secondPut = second.put;

    const [a, b] = await together(
      // The first save's own row for Edit jobs is written by this test first and held uncommitted: the save's write waits on it.
      (tx) => tx.$executeRawUnsafe(
        `INSERT INTO permission_user_switches (id, organization_id, user_id, switch_key, value, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'edit_jobs', 'true'::jsonb, now())`,
        org, person.id,
      ).then(() => undefined),
      () => firstPut(`/api/users/${person.id}/permissions`, { values: { edit_jobs: true } }),
      () => secondPut(`/api/users/${person.id}/permissions`, { values: { create_jobs: true } }),
    );
    expect(a.status, JSON.stringify(a.body)).toBe(200);
    expect(b.status, JSON.stringify(b.body)).toBe(200);
    const rows = await db.permissionUserSwitch.findMany({ where: { user_id: person.id }, select: { switch_key: true, value: true } });
    expect(Object.fromEntries(rows.map((r) => [r.switch_key, r.value]))).toEqual({ edit_jobs: true, create_jobs: true });
  });

  // Round 2 (ticket 37, F2): Save as role read the person before its transaction and then deleted every value of their own. An
  // Admin's edit of the person committing in between was deleted with them, and the new role was made without it.
  it('an Admin saving a person as a role while another edits that person: the edit is kept', async () => {
    const { org, admin } = await fx.newOrg();
    const other = await fx.addUser(org, 'ace', 'ADMIN', { isAdmin: true });
    const key = `t37-crew-${Math.random().toString(36).slice(2, 8)}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, key, { view_jobs: true, edit_jobs: false, create_jobs: false });
    const person = await fx.addUser(org, 'pat', 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
    const label = `T37 Saved ${Math.random().toString(36).slice(2, 8)}`;
    const { first, second } = await twoAdmins(admin, other);
    const savePost = first.post;
    const editPut = second.put;

    const [saved, edited] = await together(
      // The new role's own row is written by this test first and held uncommitted: the save's first write waits on it.
      (tx) => tx.$executeRawUnsafe(
        `INSERT INTO custom_roles (id, organization_id, key, label, description, base_role, made_from_blank, updated_at)
         VALUES (gen_random_uuid(), $1::uuid, $2, $3, '', 'TECHNICIAN', true, now())`,
        org, slugifyRoleKey(label), label,
      ).then(() => undefined),
      () => savePost(`/api/users/${person.id}/permissions/save-as-role`, { label }),
      () => editPut(`/api/users/${person.id}/permissions`, { values: { edit_jobs: true } }),
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    // The person is on the new role, and still holds Edit jobs: the edit was neither deleted nor left out of the role.
    const stored = await db.user.findUnique({ where: { id: person.id }, select: { based_on_role_key: true } });
    expect(stored?.based_on_role_key).toBe(slugifyRoleKey(label));
    const set = await (await fx.signedInAs(admin)).get(`/api/users/${person.id}/permissions`);
    expect(set.status).toBe(200);
    expect(set.body.values.edit_jobs).toBe(true);
  });
});
