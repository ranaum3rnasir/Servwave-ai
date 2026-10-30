/* =============================================================================
   V7-03b - Tags report how many records use them, and refuse a case-different duplicate.

   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Case-insensitive
   uniqueness is enforced in code inside the write transaction (no lower(name) index exists), so
   the race between two simultaneous creates is covered here too. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { PrismaClient } from '@prisma/client';

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

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

suite('tag usage counts and the case-insensitive name rule (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];

  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    if (orgs.length) {
      await db.tagAssignment.deleteMany({ where: { organization_id: { in: orgs } } });
      await db.tag.deleteMany({ where: { organization_id: { in: orgs } } });
    }
    await fx.cleanup();
  });

  async function setup() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    // The auth stub answers for whoever signed in last, so every call goes through this sign-in.
    const as = async () => fx.signedInAs(made.admin);
    return { ...made, as };
  }

  const mkTag = (org: string, name: string) =>
    db.tag.create({ data: { organization_id: org, name, color: '#6B7280' } });
  const assign = (org: string, tagId: string, type: 'CUSTOMER' | 'LEAD' | 'ESTIMATE' | 'JOB' | 'INVOICE', entityId = randomUUID()) =>
    db.tagAssignment.create({ data: { organization_id: org, tag_id: tagId, entity_type: type, entity_id: entityId } });

  describe('GET /api/tags usage_count', () => {
    it('counts assignments across all five record types, 0 for an unused tag, and only this org', async () => {
      const a = await setup();
      const b = await setup();
      const used = await mkTag(a.org, 'Used');
      const unused = await mkTag(a.org, 'Unused');
      for (const type of ['CUSTOMER', 'LEAD', 'ESTIMATE', 'JOB', 'INVOICE'] as const) {
        await assign(a.org, used.id, type);
      }
      await assign(a.org, used.id, 'JOB'); // a second job
      // Another org's tag of the same name carries its own count and must not leak into a's.
      const theirs = await mkTag(b.org, 'Used');
      await assign(b.org, theirs.id, 'JOB');

      const res = await (await a.as()).get('/api/tags');

      expect(res.status).toBe(200);
      const byName = Object.fromEntries(res.body.tags.map((t: { name: string; usage_count: number }) => [t.name, t.usage_count]));
      expect(byName).toEqual({ Used: 6, Unused: 0 });
      expect(res.body.tags.find((t: { id: string }) => t.id === unused.id)).toEqual({
        id: unused.id, name: 'Unused', color: '#6B7280', usage_count: 0,
      });
    });

    it('counts a legacy lead link with no assignment twin, and never counts a twinned one twice', async () => {
      const a = await setup();
      const tag = await mkTag(a.org, 'Legacy');
      const orphanLead = (await fx.addLead(a.org, a.customer)).id;
      const twinLead = (await fx.addLead(a.org, a.customer)).id;
      await db.leadTag.create({ data: { lead_id: orphanLead, tag_id: tag.id } });
      await db.leadTag.create({ data: { lead_id: twinLead, tag_id: tag.id } });
      await assign(a.org, tag.id, 'LEAD', twinLead);

      const res = await (await a.as()).get('/api/tags');

      expect(res.body.tags.find((t: { id: string }) => t.id === tag.id).usage_count).toBe(2);
      await db.leadTag.deleteMany({ where: { tag_id: tag.id } });
    });
  });

  describe('case-insensitive names', () => {
    it('create refuses a name that differs only by case, with the existing text of the 409', async () => {
      const a = await setup();
      await mkTag(a.org, 'VIP');

      const res = await (await a.as()).post('/api/tags', { name: 'vip', color: '#EF4444' });

      expect(res.status).toBe(409);
      expect(res.body.error).toBe('Tag already exists');
      expect(res.body.tag.name).toBe('VIP');
      expect(await db.tag.count({ where: { organization_id: a.org } })).toBe(1);
    });

    it('create allows the same name in another org and a name that only looks like a pattern match', async () => {
      const a = await setup();
      const b = await setup();
      await mkTag(b.org, 'VIP');
      await mkTag(a.org, 'a_b');

      expect((await (await a.as()).post('/api/tags', { name: 'vip', color: '#EF4444' })).status).toBe(201);
      expect((await (await a.as()).post('/api/tags', { name: 'axb', color: '#EF4444' })).status).toBe(201);
    });

    it('two simultaneous creates that differ by case leave exactly one tag', async () => {
      const a = await setup();

      const api = await a.as();
      const results = await Promise.all([
        api.post('/api/tags', { name: 'Rush', color: '#EF4444' }),
        api.post('/api/tags', { name: 'rush', color: '#EF4444' }),
        api.post('/api/tags', { name: 'RUSH', color: '#EF4444' }),
      ]);

      expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
      expect(await db.tag.count({ where: { organization_id: a.org } })).toBe(1);
    });

    it('update refuses a rename that differs only by case from another tag, allows a case change of the same row', async () => {
      const a = await setup();
      const vip = await mkTag(a.org, 'VIP');
      const other = await mkTag(a.org, 'Other');

      const clash = await (await a.as()).patch(`/api/tags/${other.id}`, { name: 'vip' });
      expect(clash.status).toBe(409);
      expect(clash.body.error).toBe('A tag with that name already exists');
      expect((await db.tag.findUniqueOrThrow({ where: { id: other.id } })).name).toBe('Other');

      const own = await (await a.as()).patch(`/api/tags/${vip.id}`, { name: 'Vip' });
      expect(own.status).toBe(200);
      expect(own.body.tag.name).toBe('Vip');
    });

    it('tags that already differ only by case stay as they are, still listed, and can be recoloured', async () => {
      const a = await setup();
      const upper = await mkTag(a.org, 'Gate');
      await mkTag(a.org, 'gate');

      const list = await (await a.as()).get('/api/tags');
      expect(list.body.tags.map((t: { name: string }) => t.name).sort()).toEqual(['Gate', 'gate']);

      const recolour = await (await a.as()).patch(`/api/tags/${upper.id}`, { color: '#22C55E' });
      expect(recolour.status).toBe(200);
      expect(await db.tag.count({ where: { organization_id: a.org } })).toBe(2);
    });
  });

  describe('record-page find-or-create (C-15)', () => {
    it('given "vip" when "VIP" exists, attaches VIP and creates nothing', async () => {
      const a = await setup();
      const vip = await mkTag(a.org, 'VIP');

      const res = await (await a.as()).post(`/api/customers/${a.customer}/tags`, { name: 'vip' });

      expect(res.status).toBe(201);
      expect(res.body.tag).toMatchObject({ id: vip.id, name: 'VIP' });
      expect(await db.tag.count({ where: { organization_id: a.org } })).toBe(1);
      expect(await db.tagAssignment.count({ where: { tag_id: vip.id, entity_id: a.customer } })).toBe(1);
    });

    it('still mints a brand-new name, once', async () => {
      const a = await setup();

      const res = await (await a.as()).post(`/api/customers/${a.customer}/tags`, { name: 'Fresh' });

      expect(res.status).toBe(201);
      expect(await db.tag.count({ where: { organization_id: a.org, name: 'Fresh' } })).toBe(1);
    });

    it('the bulk apply reuses the existing tag the same way', async () => {
      const a = await setup();
      const vip = await mkTag(a.org, 'VIP');

      const res = await (await a.as()).post('/api/customers/bulk-tag', { ids: [a.customer], name: 'VIp' });

      expect(res.status).toBe(200);
      expect(res.body.tag.id).toBe(vip.id);
      expect(res.body.tagged).toEqual([a.customer]);
      expect(await db.tag.count({ where: { organization_id: a.org } })).toBe(1);
    });
  });

  it('lists 150 tags with their counts in one answer', async () => {
    const a = await setup();
    await db.tag.createMany({
      data: Array.from({ length: 150 }, (_, i) => ({ organization_id: a.org, name: `bulk-${String(i).padStart(3, '0')}`, color: '#6B7280' })),
    });
    const first = await db.tag.findFirstOrThrow({ where: { organization_id: a.org, name: 'bulk-000' } });
    await assign(a.org, first.id, 'JOB');

    const res = await (await a.as()).get('/api/tags');

    expect(res.body.tags).toHaveLength(150);
    expect(res.body.tags[0]).toMatchObject({ name: 'bulk-000', usage_count: 1 });
    expect(res.body.tags[1].usage_count).toBe(0);
  });
});
