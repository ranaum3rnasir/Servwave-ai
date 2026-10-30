/* =============================================================================
   V7-03 - the endpoint suite both Lists-page lists share (job types, lead/customer sources).
   Not a test file: job-types-db.test.ts and lead-sources-db.test.ts each mock the app's prisma client with the real one
   (vitest hoists that per file), then hand it here with the few facts that differ between the lists.
   ========================================================================== */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { switchFixture } from './permission-switches-fixture';

export interface ListSpec {
  path: string;
  table: 'job_types' | 'lead_sources';
  model: 'jobType' | 'leadSource';
  /** The organization record's JSON column, and the plain-string list the forms read. */
  orgField: 'job_type_options' | 'source_options';
  noun: string;
  hasReorder: boolean;
  /** Put `text` in every record column the rename rewrites (one record per column), for this org. */
  seedCarriers(db: PrismaClient, org: string, adminId: string, customer: string, text: string): Promise<void>;
  /** Every value now stored in those columns for this org, sorted. */
  readCarriers(db: PrismaClient, org: string): Promise<string[]>;
  /** Make `text` used by records so the list reports this many; returns how many. */
  seedUsed(db: PrismaClient, fx: ReturnType<typeof switchFixture>, org: string, customer: string, text: string): Promise<number>;
}

const names = (items: Array<{ name: string }>) => items.map((i) => i.name);

export function describeListEndpoints(db: PrismaClient, spec: ListSpec) {
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const delegate = () => (db as unknown as Record<string, { findMany(a: object): Promise<Array<{ id: string; name: string; sort_order: number; archived_at: Date | null }>>; count(a: object): Promise<number> }>)[spec.model];
  const orgs: string[] = [];

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    // The new tables hold an ON DELETE RESTRICT org FK, and the fixture's cleanup knows nothing of them.
    const quiet = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quiet(db.$executeRawUnsafe(`DELETE FROM ${spec.table} WHERE organization_id = $1::uuid`, org));
      await quiet(db.$executeRawUnsafe('DELETE FROM service_plan_templates WHERE organization_id = $1::uuid', org));
      await quiet(db.$executeRawUnsafe('DELETE FROM web_form_integrations WHERE organization_id = $1::uuid', org));
    }
    await fx.cleanup();
  });

  /** An org whose list holds exactly `listed` as rows (the JSON column is left at its default), plus a signed-in admin. */
  async function setup(listed: string[] = []) {
    const o = await fx.newOrg();
    orgs.push(o.org);
    if (listed.length) {
      // Through the API, so the org's first write also proves the fill-from-JSON path.
      await db.organization.update({ where: { id: o.org }, data: { [spec.orgField]: [] } });
    }
    const api = await fx.signedInAs(o.admin);
    // One call now pins this token to this person (the auth layer caches the resolved user by token).
    await api.get('/api/organization');
    for (const n of listed) expect((await api.post(spec.path, { name: n })).status).toBe(201);
    return { ...o, api };
  }

  const get = async (api: Awaited<ReturnType<typeof setup>>['api']) => (await api.get(spec.path)).body as {
    items: Array<{ id: string; name: string; sort_order: number; archived: boolean; used_count: number }>;
    counts: { active: number; archived: number };
  };
  const orgList = async (api: Awaited<ReturnType<typeof setup>>['api']) => ((await api.get('/api/organization')).body as Record<string, string[]>)[spec.orgField];

  describe(`${spec.path} (real database)`, () => {
    it('creates a row at the end and answers the list with counts', async () => {
      const { api } = await setup(['First']);
      const res = await api.post(spec.path, { name: '  Second   one ' });
      expect(res.status).toBe(201);
      expect(res.body.item).toMatchObject({ name: 'Second one', archived: false, used_count: 0 });
      const list = await get(api);
      expect(names(list.items)).toEqual(['First', 'Second one']);
      expect(list.items.map((i) => i.sort_order)).toEqual([0, 1]);
      expect(list.counts).toEqual({ active: 2, archived: 0 });
    });

    it('refuses a blank, an over-long and a spaces-only name, and collapses inner whitespace', async () => {
      const { api } = await setup();
      expect((await api.post(spec.path, { name: '' })).status).toBe(400);
      expect((await api.post(spec.path, { name: ' '.repeat(60) })).status).toBe(400);
      const long = await api.post(spec.path, { name: 'x'.repeat(51) });
      expect(long.status).toBe(400);
      expect(JSON.stringify(long.body)).toContain('Use 50 characters or fewer.');
      expect((await api.post(spec.path, { name: 'x'.repeat(50) })).status).toBe(201);
      expect((await api.post(spec.path, { name: 'a  b\t c' })).body.item.name).toBe('a b c');
      expect((await api.post(spec.path, { name: 'q', extra: 1 })).status).toBe(400);
    });

    it('refuses a duplicate that differs only by case, naming the EXISTING row, also against an archived row', async () => {
      const { api } = await setup(['Roof Repair']);
      const dup = await api.post(spec.path, { name: 'roof repair' });
      expect(dup.status).toBe(409);
      expect(dup.body).toMatchObject({ code: 'NAME_EXISTS', name: 'Roof Repair' });
      expect(dup.body.error).toBe(`${spec.noun} “Roof Repair” already exists.`);

      const id = (await get(api)).items[0].id;
      await api.post(`${spec.path}/${id}/archive`);
      const again = await api.post(spec.path, { name: 'ROOF REPAIR' });
      expect(again.status).toBe(409);
      expect(again.body.name).toBe('Roof Repair');
    });

    it('holds 500 rows and refuses the 501st with the cap message', async () => {
      const { org, api } = await setup(['seed']);
      await db.$executeRawUnsafe(
        `INSERT INTO ${spec.table} (id, organization_id, name, sort_order, created_at, updated_at)
         SELECT gen_random_uuid(), $1::uuid, 'Item ' || g, g, now(), now() FROM generate_series(1, 499) g`,
        org,
      );
      expect(await delegate().count({ where: { organization_id: org } })).toBe(500);
      const res = await api.post(spec.path, { name: 'One too many' });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe('This list can hold up to 500 items.');
      expect(await delegate().count({ where: { organization_id: org } })).toBe(500);
    });

    it('renames, and rewrites the stored text on THIS org\'s records only (case-insensitive match, other names untouched)', async () => {
      const mine = await setup(['Roof repair', 'Other thing']);
      const theirs = await setup(['Roof repair']);
      await spec.seedCarriers(db, mine.org, mine.admin.id, mine.customer, 'ROOF repair');
      await spec.seedCarriers(db, theirs.org, theirs.admin.id, theirs.customer, 'Roof repair');
      const bystander = await spec.readCarriers(db, mine.org);
      expect(bystander.length).toBeGreaterThanOrEqual(4);

      const id = (await get(mine.api)).items[0].id;
      const res = await mine.api.patch(`${spec.path}/${id}`, { name: ' Roof repairs ' });
      expect(res.status).toBe(200);
      expect(res.body.item.name).toBe('Roof repairs');

      expect((await spec.readCarriers(db, mine.org)).every((v) => v === 'Roof repairs')).toBe(true);
      expect((await spec.readCarriers(db, theirs.org)).every((v) => v === 'Roof repair')).toBe(true);
      expect(names((await get(mine.api)).items)).toEqual(['Roof repairs', 'Other thing']);
      expect(await orgList(mine.api)).toEqual(['Roof repairs', 'Other thing']);
    });

    it('refuses a rename to another row\'s name, allows a case-only change of the same row, and is a no-op for the same name', async () => {
      const { api } = await setup(['Alpha one', 'Beta two']);
      const [a, b] = (await get(api)).items;
      const clash = await api.patch(`${spec.path}/${b.id}`, { name: 'ALPHA ONE' });
      expect(clash.status).toBe(409);
      expect(clash.body).toMatchObject({ code: 'NAME_EXISTS', name: 'Alpha one' });
      expect((await api.patch(`${spec.path}/${a.id}`, { name: 'ALPHA ONE' })).status).toBe(200);
      expect((await api.patch(`${spec.path}/${a.id}`, { name: 'ALPHA ONE' })).status).toBe(200);
      expect(names((await get(api)).items)).toEqual(['ALPHA ONE', 'Beta two']);
      expect((await api.patch(`${spec.path}/${a.id}`, { name: '' })).status).toBe(400);
    });

    it('archives (hidden from the org record, records untouched), unarchives to the END, and keeps the counts', async () => {
      const { org, customer, admin, api } = await setup(['One', 'Two', 'Three']);
      await spec.seedCarriers(db, org, admin.id, customer, 'Two');
      const before = await spec.readCarriers(db, org);
      const [, two] = (await get(api)).items;

      expect((await api.post(`${spec.path}/${two.id}/archive`)).body.item.archived).toBe(true);
      expect(await orgList(api)).toEqual(['One', 'Three']);
      expect(await spec.readCarriers(db, org)).toEqual(before);
      const listed = await get(api);
      expect(listed.counts).toEqual({ active: 2, archived: 1 });
      // An archived row keeps its sort_order.
      expect(listed.items.find((i) => i.id === two.id)?.sort_order).toBe(1);

      const back = await api.post(`${spec.path}/${two.id}/unarchive`);
      expect(back.body.item.archived).toBe(false);
      expect(await orgList(api)).toEqual(['One', 'Three', 'Two']);
      expect((await get(api)).counts).toEqual({ active: 3, archived: 0 });
    });

    it('reports used_count', async () => {
      const { org, customer, api, admin } = await setup(['Used', 'Idle']);
      const expected = await spec.seedUsed(db, fx, org, customer, 'USED');
      expect(expected).toBeGreaterThan(0);
      void admin;
      const items = (await get(api)).items;
      expect(items.find((i) => i.name === 'Used')?.used_count).toBe(expected);
      expect(items.find((i) => i.name === 'Idle')?.used_count).toBe(0);
    });

    it('deletes a row nothing uses, and refuses one that is in use', async () => {
      const { org, customer, api } = await setup(['Busy', 'Free']);
      await spec.seedUsed(db, fx, org, customer, 'Busy');
      const [busy, free] = (await get(api)).items;
      const refused = await api.delete(`${spec.path}/${busy.id}`);
      expect(refused.status).toBe(409);
      expect(refused.body.error).toContain('in use');
      expect((await api.delete(`${spec.path}/${free.id}`)).status).toBe(204);
      expect(names((await get(api)).items)).toEqual(['Busy']);
      expect((await api.delete(`${spec.path}/${free.id}`)).status).toBe(404);
    });

    it('answers 403 on every route for a role without "update Organization", and 404 for another org\'s id', async () => {
      const mine = await setup(['Mine']);
      const theirs = await setup(['Theirs']);
      const theirId = (await get(theirs.api)).items[0].id;
      const myId = (await get(mine.api)).items[0].id;

      const tech = await fx.addUser(mine.org, 'tech', 'TECHNICIAN');
      const t = await fx.signedInAs(tech);
      const base = spec.path;
      const calls = [
        await t.get(base), await t.post(base, { name: 'x' }), await t.patch(`${base}/${myId}`, { name: 'x' }),
        await t.post(`${base}/${myId}/archive`), await t.post(`${base}/${myId}/unarchive`), await t.delete(`${base}/${myId}`),
        ...(spec.hasReorder ? [await t.post(`${base}/reorder`, { ordered_ids: [myId] })] : []),
      ];
      expect(calls.map((c) => c.status)).toEqual(calls.map(() => 403));

      const a = await fx.signedInAs(mine.admin);
      const foreign = [
        await a.patch(`${base}/${theirId}`, { name: 'Hijack' }), await a.post(`${base}/${theirId}/archive`),
        await a.post(`${base}/${theirId}/unarchive`), await a.delete(`${base}/${theirId}`),
      ];
      expect(foreign.map((c) => c.status)).toEqual(foreign.map(() => 404));
      expect(names((await get(theirs.api)).items)).toEqual(['Theirs']);
      expect((await get(theirs.api)).items[0].archived).toBe(false);
    });

    (spec.hasReorder ? it : it.skip)('reorders the active rows, persists it, and the org record follows', async () => {
      const { api } = await setup(['A', 'B', 'C']);
      const ids = (await get(api)).items.map((i) => i.id);
      const res = await api.post(`${spec.path}/reorder`, { ordered_ids: [ids[2], ids[0], ids[1]] });
      expect(res.status).toBe(204);
      expect(names((await get(api)).items)).toEqual(['C', 'A', 'B']);
      expect(await orgList(api)).toEqual(['C', 'A', 'B']);
    });

    (spec.hasReorder ? it : it.skip)('refuses a reorder with a missing, extra, duplicate, foreign or archived id and writes nothing', async () => {
      const { api } = await setup(['A', 'B', 'C']);
      const other = await setup(['Z']);
      const [a, b, c] = (await get(api)).items.map((i) => i.id);
      const foreignId = (await get(other.api)).items[0].id;
      await api.post(`${spec.path}/${c}/archive`);
      const bad = [
        [a], [a, b, c], [a, b, a], [a, foreignId], [a, randomUUID()], [b, a, foreignId],
      ];
      for (const ordered_ids of bad) {
        expect((await api.post(`${spec.path}/reorder`, { ordered_ids })).status).toBe(400);
      }
      expect((await api.post(`${spec.path}/reorder`, { ordered_ids: [a, 'not-a-uuid'] })).status).toBe(400);
      expect(names((await get(api)).items)).toEqual(['A', 'B', 'C']);
      expect(names((await get(other.api)).items)).toEqual(['Z']);
      expect((await api.post(`${spec.path}/reorder`, { ordered_ids: [b, a] })).status).toBe(204);
      expect(await orgList(api)).toEqual(['B', 'A']);
    });

    (spec.hasReorder ? it.skip : it)('has no reorder route', async () => {
      const { api } = await setup(['A']);
      expect((await api.post(`${spec.path}/reorder`, { ordered_ids: [randomUUID()] })).status).toBe(404);
    });

    it('copes with 150 rows: list, rename, and (job types) one reorder of 150 ids', async () => {
      const { org, api } = await setup(['seed']);
      await db.$executeRawUnsafe(
        `INSERT INTO ${spec.table} (id, organization_id, name, sort_order, created_at, updated_at)
         SELECT gen_random_uuid(), $1::uuid, 'Item ' || g, g, now(), now() FROM generate_series(1, 149) g`,
        org,
      );
      const list = await get(api);
      expect(list.items).toHaveLength(150);
      expect(list.counts.active).toBe(150);
      expect((await api.patch(`${spec.path}/${list.items[149].id}`, { name: 'Renamed 149' })).status).toBe(200);
      if (spec.hasReorder) {
        const reversed = [...list.items].reverse().map((i) => i.id);
        expect((await api.post(`${spec.path}/reorder`, { ordered_ids: reversed })).status).toBe(204);
        expect((await get(api)).items.map((i) => i.id)).toEqual(reversed);
      }
      expect((await orgList(api)).length).toBe(150);
    });

    it('serves the org record from rows (archived absent), falls back to the JSON column with no rows, and the PATCH response agrees', async () => {
      const o = await fx.newOrg();
      orgs.push(o.org);
      await db.organization.update({ where: { id: o.org }, data: { [spec.orgField]: ['Json one', 'Json two'] } });
      const api = await fx.signedInAs(o.admin);

      // No rows yet: the column is returned unchanged and a GET writes nothing.
      expect(await orgList(api)).toEqual(['Json one', 'Json two']);
      expect(await delegate().count({ where: { organization_id: o.org } })).toBe(0);

      // The first read of the list copies the column into rows.
      expect(names((await get(api)).items)).toEqual(['Json one', 'Json two']);
      await api.post(spec.path, { name: 'Added' });
      const patched = await api.patch('/api/organization', { phone: '555-0100' });
      expect(patched.status).toBe(200);
      expect(patched.body[spec.orgField]).toEqual(['Json one', 'Json two', 'Added']);
    });

    it('refuses a list sent to PATCH /api/organization (400) and leaves the rows alone', async () => {
      const { api } = await setup(['One', 'Two', 'Three']);
      const before = await get(api);
      const res = await api.patch('/api/organization', { [spec.orgField]: ['Three', 'One', 'Brand new'] });
      expect(res.status).toBe(400);
      expect(await orgList(api)).toEqual(names(before.items.filter((i) => !i.archived)));
      const after = await get(api);
      expect(after.counts).toEqual(before.counts);
      expect(names(after.items)).toEqual(names(before.items));
    });

    it('fills from the JSON column on the first write, and two simultaneous first writes do not double the list', async () => {
      const o = await fx.newOrg();
      orgs.push(o.org);
      await db.organization.update({ where: { id: o.org }, data: { [spec.orgField]: ['Keep A', 'Keep B'] } });
      const api = await fx.signedInAs(o.admin);
      const results = await Promise.all([api.post(spec.path, { name: 'New X' }), api.post(spec.path, { name: 'New Y' }), api.post(spec.path, { name: 'new x' })]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 201, 409]);
      // Whichever of "New X" / "new x" arrived first won; the other was refused.
      const list = (await get(api)).items.map((i) => i.name.toLowerCase()).sort();
      expect(list).toEqual(['keep a', 'keep b', 'new x', 'new y']);
      expect(await delegate().count({ where: { organization_id: o.org } })).toBe(4);
    });
  });
}
