/* =============================================================================
   Roles & Permissions, pre-PR review fixes (verifier V2, finding F2): a person's email is never handed to themselves.

   Deactivating a person (the Deactivate action, or the user update that sets them inactive) and moving a deactivated
   person's mailbox take `handover_to`: "main", or the id of an active person who is not the leaver. The leaver's own id was
   refused only when written exactly as stored: in capitals the check let it through, and the mailbox ended up "handed" to the
   deactivated leaver, read by nobody. Every spelling of the leaver's own id must be refused (400, the hand-over words), with
   the person and their mailbox left exactly as they were.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { HANDOVER_TARGET_REFUSED } from '../lib/mailbox/handover';

/** The leaver's own id, written every way the database would still read as them. */
const SPELLINGS: Record<string, (id: string) => string> = {
  'upper case': (id) => id.toUpperCase(),
  'mixed case': (id) => id.replace(/[a-f]/, (c) => c.toUpperCase()),
  'in braces': (id) => `{${id}}`,
  'no dashes': (id) => id.replace(/-/g, ''),
  'urn form': (id) => `urn:uuid:${id}`,
};

const suite = realClient ? describe : describe.skip;

suite("a person's email is never handed to themselves, however their id is written (real database)", () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let org = '';
  let owner: Person;
  beforeAll(async () => {
    const o = await fx.newOrg();
    org = o.org;
    owner = o.admin;
  }, 120_000);

  let n = 0;
  async function leaver(active: boolean) {
    const p = await fx.addUser(org, `leaver${++n}`, 'TECHNICIAN');
    await fx.addUserMailbox(org, p);
    if (!active) await db.user.update({ where: { id: p.id }, data: { is_active: false, has_login: false } });
    return p;
  }
  const stateOf = async (id: string) => JSON.stringify({
    user: await db.user.findUniqueOrThrow({ where: { id }, select: { is_active: true, has_login: true } }),
    mailboxes: await db.mailbox.findMany({ where: { user_id: id }, select: { id: true, status: true, holder_user_id: true }, orderBy: { id: 'asc' } }),
  });

  const DOORS: { name: string; active: boolean; call: (p: Person, handoverTo: string) => Promise<{ status: number; body: unknown }> }[] = [
    { name: 'DELETE /api/users/:id (deactivate)', active: true, call: async (p, h) => (await fx.signedInAs(owner)).delete(`/api/users/${p.id}`, { handover_to: h }) },
    { name: 'PATCH /api/users/:id (set inactive)', active: true, call: async (p, h) => (await fx.signedInAs(owner)).patch(`/api/users/${p.id}`, { is_active: false, handover_to: h }) },
    { name: 'PUT /api/users/:id/mailbox-handover', active: false, call: async (p, h) => (await fx.signedInAs(owner)).put(`/api/users/${p.id}/mailbox-handover`, { handover_to: h }) },
  ];

  for (const door of DOORS) {
    it(`${door.name}: the leaver's own id in every spelling is refused, and nothing changes`, async () => {
      const wrong: string[] = [];
      for (const [name, spell] of Object.entries(SPELLINGS)) {
        const p = await leaver(door.active);
        const before = await stateOf(p.id);
        const res = await door.call(p, spell(p.id));
        if (res.status !== 400 || JSON.stringify(res.body) !== JSON.stringify({ error: HANDOVER_TARGET_REFUSED })) {
          wrong.push(`[${name}]: ${res.status} ${JSON.stringify(res.body)}`);
        }
        if ((await stateOf(p.id)) !== before) wrong.push(`[${name}]: the person or their mailbox changed`);
      }
      expect(wrong).toEqual([]);
    });
  }

  it("still hands the mailbox to another active person named by id", async () => {
    const p = await leaver(true);
    const heir = await fx.addUser(org, `heir${++n}`, 'TECHNICIAN');
    const res = await (await fx.signedInAs(owner)).delete(`/api/users/${p.id}`, { handover_to: heir.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const boxes = await db.mailbox.findMany({ where: { user_id: p.id }, select: { status: true, holder_user_id: true } });
    expect(boxes).toEqual([{ status: 'handed', holder_user_id: heir.id }]);
  });
});
