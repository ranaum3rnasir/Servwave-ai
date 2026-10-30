/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.1 - assets follow Assets scope (P6): Attached the assets the person holds,
   Team the assets held by anyone in their department, All every asset.

   Everything goes through the public interface: the asset routes, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
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

const suite = realClient ? describe : describe.skip;

suite('assets follow Assets scope (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['asset_events', 'assets']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role = 'DISPATCHER',
    departmentId?: string,
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `assets-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { view_stock: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id, departmentId });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function addAsset(org: string, name: string, holder: string | null, status: 'ACTIVE' | 'RETIRED' = 'ACTIVE') {
    const id = randomUUID();
    await db.asset.create({ data: { id, organization_id: org, name, status, assigned_user_id: holder } });
    return id;
  }

  /** An org where the person holds two assets and a colleague holds one; one more is on the shelf. */
  async function orgWithAssets(values: Record<string, boolean | string>, base: Role = 'DISPATCHER') {
    const { org } = await newOrg();
    const me = await personWith(org, values, base);
    const colleague = await fx.addUser(org, `colleague${++sequence}`, 'TECHNICIAN');
    const mine = [await addAsset(org, 'My drill', me.id), await addAsset(org, 'My ladder', me.id)];
    const theirs = await addAsset(org, 'Their saw', colleague.id);
    const shelf = await addAsset(org, 'Shelf lift', null);
    return { org, me, colleague, mine, theirs, shelf };
  }

  const idsOf = (body: { data: { id: string }[] }) => body.data.map((a) => a.id).sort();

  describe('on Assets scope Attached', () => {
    it('lists only the assets the person holds, for any role, and the count and pages agree with the rows', async () => {
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const { me, mine } = await orgWithAssets({ assets_scope: 'attached' }, base);
        const api = await me.api();

        const list = await api.get('/api/inventory/assets');
        expect(list.status, base).toBe(200);
        expect(idsOf(list.body), base).toEqual([...mine].sort());
        expect(list.body.meta.total, base).toBe(2);

        // Pages are cut from the held assets alone, so a short page never hides a held asset behind a colleague's.
        const first = await api.get('/api/inventory/assets?limit=1&page=1');
        const second = await api.get('/api/inventory/assets?limit=1&page=2');
        expect(first.body.meta.total, base).toBe(2);
        expect(first.body.data).toHaveLength(1);
        expect(second.body.data).toHaveLength(1);
        expect(first.body.data[0].id).not.toBe(second.body.data[0].id);
      }
    });

    it('does not let the holder filter or search reach a colleague\'s asset', async () => {
      const { me, colleague } = await orgWithAssets({ assets_scope: 'attached' });
      const api = await me.api();
      const byColleague = await api.get(`/api/inventory/assets?assigned_user_id=${colleague.id}`);
      expect(byColleague.status).toBe(200);
      expect(byColleague.body.data).toEqual([]);
      expect(byColleague.body.meta.total).toBe(0);
      const bySearch = await api.get('/api/inventory/assets?search=saw');
      expect(bySearch.body.data).toEqual([]);
    });

    it('answers "not found" on detail and on events for a colleague\'s asset and for one nobody holds, and opens the person\'s own', async () => {
      const { me, mine, theirs, shelf } = await orgWithAssets({ assets_scope: 'attached' });
      const api = await me.api();
      for (const id of [theirs, shelf]) {
        expect((await api.get(`/api/inventory/assets/${id}`)).status, 'detail').toBe(404);
        expect((await api.get(`/api/inventory/assets/${id}/events`)).status, 'events').toBe(404);
      }
      expect((await api.get(`/api/inventory/assets/${mine[0]}`)).status).toBe(200);
      expect((await api.get(`/api/inventory/assets/${mine[0]}/events`)).status).toBe(200);
    });

    it('hides an asset once it is no longer held (retired or handed on)', async () => {
      const { me, mine } = await orgWithAssets({ assets_scope: 'attached' });
      const api = await me.api();
      await db.asset.update({ where: { id: mine[0]! }, data: { assigned_user_id: null, status: 'RETIRED' } });
      const list = await api.get('/api/inventory/assets');
      expect(idsOf(list.body)).toEqual([mine[1]!]);
      expect((await api.get(`/api/inventory/assets/${mine[0]}`)).status).toBe(404);
    });
  });

  describe('on Assets scope Team', () => {
    it('lists and opens the assets anyone in the department holds, not another department\'s, and nothing without a department (P3)', async () => {
      const { org } = await newOrg();
      const north = await fx.addDepartment(org, 'North');
      const south = await fx.addDepartment(org, 'South');
      const me = await personWith(org, { assets_scope: 'team' }, 'DISPATCHER', north);
      const mate = await fx.addUser(org, `mate${++sequence}`, 'TECHNICIAN', { departmentId: north });
      const stranger = await fx.addUser(org, `stranger${++sequence}`, 'TECHNICIAN', { departmentId: south });
      const mine = await addAsset(org, 'My drill', me.id);
      const mates = await addAsset(org, 'Mate saw', mate.id);
      const strangers = await addAsset(org, 'Stranger saw', stranger.id);
      const shelf = await addAsset(org, 'Shelf lift', null);
      const api = await me.api();

      expect(idsOf((await api.get('/api/inventory/assets')).body)).toEqual([mine, mates].sort());
      expect((await api.get(`/api/inventory/assets/${mates}`)).status).toBe(200);
      for (const id of [strangers, shelf]) expect((await api.get(`/api/inventory/assets/${id}`)).status).toBe(404);

      const loner = await (await personWith(org, { assets_scope: 'team' })).api();
      expect(idsOf((await loner.get('/api/inventory/assets')).body)).toEqual([]);
    });
  });

  describe('on Assets scope All', () => {
    it('lists every asset in the company and opens any of them, for any role', async () => {
      for (const base of ['TECHNICIAN', 'SALES', 'DISPATCHER'] as const) {
        const { me, mine, theirs, shelf } = await orgWithAssets({ assets_scope: 'all' }, base);
        const api = await me.api();
        const list = await api.get('/api/inventory/assets');
        expect(idsOf(list.body), base).toEqual([...mine, theirs, shelf].sort());
        expect(list.body.meta.total, base).toBe(4);
        expect((await api.get(`/api/inventory/assets/${theirs}`)).status, base).toBe(200);
        expect((await api.get(`/api/inventory/assets/${theirs}/events`)).status, base).toBe(200);
      }
    });

    it('never shows another company\'s assets', async () => {
      const a = await orgWithAssets({ assets_scope: 'all' });
      const b = await orgWithAssets({ assets_scope: 'all' });
      const list = await (await a.me.api()).get('/api/inventory/assets');
      expect(idsOf(list.body)).not.toContain(b.theirs);
      expect((await (await a.me.api()).get(`/api/inventory/assets/${b.theirs}`)).status).toBe(404);
    });
  });

  describe('asset writes keep their own stock switches', () => {
    it('refuses add, edit and delete without Create, Edit and Delete stock, and lets each in with its switch', async () => {
      const { org, me: none } = await orgWithAssets({ assets_scope: 'all', create_stock: false, edit_stock: false, delete_stock: false });
      const asset = await addAsset(org, 'Writable', null);
      const readOnly = await none.api();
      expect((await readOnly.post('/api/inventory/assets', { name: 'New' })).status).toBe(403);
      expect((await readOnly.patch(`/api/inventory/assets/${asset}`, { name: 'Renamed' })).status).toBe(403);
      expect((await readOnly.post(`/api/inventory/assets/${asset}/note`, { note: 'Hi' })).status).toBe(403);
      expect((await readOnly.delete(`/api/inventory/assets/${asset}`)).status).toBe(403);

      const creator = await (await personWith(org, { assets_scope: 'all', edit_stock: true, create_stock: true })).api();
      expect((await creator.post('/api/inventory/assets', { name: 'New' })).status).toBe(201);
      const editor = await (await personWith(org, { assets_scope: 'all', edit_stock: true })).api();
      expect((await editor.patch(`/api/inventory/assets/${asset}`, { name: 'Renamed' })).status).toBe(200);
      const deleter = await (await personWith(org, { assets_scope: 'all', delete_stock: true })).api();
      expect((await deleter.delete(`/api/inventory/assets/${asset}`)).status).toBe(200);
    });
  });
});
