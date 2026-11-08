/* =============================================================================
   Task categories - a name is unique per organization whatever its letter case,
   even when two admins write at the same moment (slice 09).

   The table's unique index is exact-match only, so "Permit" and "permit" arriving
   together would both pass a plain check-then-insert. The writes serialise on a
   per-organization advisory lock; this suite races real transactions against a real,
   migrated database to prove it. Skips when TEST_DATABASE_URL is unset, the same
   idiom as task-categories-seed-db.test.ts. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient } from '@prisma/client';
import { createTaskCategory, updateTaskCategory } from '../lib/tasks/categoryWrites';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('task category writes (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const created: string[] = [];

  async function makeOrg(): Promise<string> {
    const id = randomUUID();
    created.push(id);
    await prisma.organization.create({
      data: {
        id, name: `vtc09-writes-${id.slice(0, 8)}`, email: `writes-${id.slice(0, 8)}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    return id;
  }

  const namesOf = async (orgId: string) =>
    (await prisma.taskCategory.findMany({ where: { organization_id: orgId }, select: { name: true } }))
      .map((r) => r.name.toLowerCase());

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const id of created) {
      await quietly(prisma.taskCategory.deleteMany({ where: { organization_id: id } }));
      await quietly(prisma.organization.deleteMany({ where: { id } }));
    }
    await prisma.$disconnect();
  });

  it('concurrent creates of one name in different letter cases store exactly one', async () => {
    const org = await makeOrg();
    const spellings = ['Permit', 'permit', 'PERMIT', ' pErMiT ', 'Permit'];

    const results = await Promise.all(
      spellings.map((name) => createTaskCategory(prisma, org, { name, color: '#8B5CF6' })),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.error === 'duplicate')).toHaveLength(spellings.length - 1);
    // Filtered, not the whole list: the assertion is about this one name, whatever else the org holds.
    expect((await namesOf(org)).filter((n) => n === 'permit')).toHaveLength(1);
  });

  it('concurrent renames onto one name in different letter cases apply exactly one', async () => {
    const org = await makeOrg();
    const ids: string[] = [];
    for (const name of ['One', 'Two', 'Three']) {
      const r = await createTaskCategory(prisma, org, { name, color: '#3B82F6' });
      if (!r.ok) throw new Error('setup create failed');
      ids.push(r.category.id);
    }

    const results = await Promise.all(
      ids.map((id, i) => updateTaskCategory(prisma, org, id, { name: ['Callback', 'CALLBACK', 'callback'][i] })),
    );

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await namesOf(org)).filter((n) => n === 'callback')).toHaveLength(1);
  });

  it('each new category goes to the end of the list', async () => {
    const org = await makeOrg();

    const a = await createTaskCategory(prisma, org, { name: 'A', color: '#EF4444' });
    const b = await createTaskCategory(prisma, org, { name: 'B', color: '#EF4444' });

    if (!a.ok || !b.ok) throw new Error('create failed');
    // Relative: the claim is "after the last one", not a particular sort_order value.
    expect(b.category.sort_order).toBeGreaterThan(a.category.sort_order);
  });

  it('a name is compared as text, never as a LIKE pattern: "%" and "_" match only themselves', async () => {
    const org = await makeOrg();
    for (const name of ['Part order', 'Permit']) {
      if (!(await createTaskCategory(prisma, org, { name, color: '#3B82F6' })).ok) throw new Error('setup create failed');
    }

    // Each of these is a pattern that would match an existing name under ILIKE.
    for (const name of ['Part_order', 'P%', '%', 'Per_it', 'Part%', 'Part\\order']) {
      const r = await createTaskCategory(prisma, org, { name, color: '#3B82F6' });
      expect({ name, ok: r.ok }).toEqual({ name, ok: true });
    }
    // And the other way round: an existing pattern-like name does not swallow a plain one.
    expect((await createTaskCategory(prisma, org, { name: 'Pa', color: '#3B82F6' })).ok).toBe(true);
    // A real duplicate in another case is still refused.
    expect(await createTaskCategory(prisma, org, { name: 'part_ORDER', color: '#3B82F6' })).toEqual({ ok: false, error: 'duplicate' });
    expect(await createTaskCategory(prisma, org, { name: 'p%', color: '#3B82F6' })).toEqual({ ok: false, error: 'duplicate' });
  });

  it('a rename is compared as text too', async () => {
    const org = await makeOrg();
    const a = await createTaskCategory(prisma, org, { name: 'Part order', color: '#3B82F6' });
    const b = await createTaskCategory(prisma, org, { name: 'Other', color: '#3B82F6' });
    if (!a.ok || !b.ok) throw new Error('setup create failed');

    expect((await updateTaskCategory(prisma, org, b.category.id, { name: 'Part_order' })).ok).toBe(true);
  });
});
