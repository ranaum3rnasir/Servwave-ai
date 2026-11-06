/* =============================================================================
   The lead's Notes tab - the `add_note` entry of the lead's per-record action list. The list is the answer the page
   draws "Add note" from; POST /api/leads/:id/notes is the door. This suite asserts they agree, through the routes, as
   people on custom roles whose switch values are the ones under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

type SwitchValue = boolean | string | string[];
/** Every switch in the catalog off, so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);
const OPENING = { view_leads: true, leads_scope: 'all' };

suite('adding a note to a lead, and the lead\'s add_note action (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const orgs: string[] = [];
  afterAll(async () => {
    for (const org of orgs) await db.$executeRawUnsafe(`DELETE FROM notes WHERE organization_id = '${org}'`).catch(() => undefined);
    await fx.cleanup();
  });

  let sequence = 0;
  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }
  async function personWith(org: string, values: Record<string, SwitchValue>) {
    const key = `lead-add-note-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...OPENING, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `lan${sequence}`, 'DISPATCHER', { customRoleId: role.id });
  }

  const actionsOf = async (api: Awaited<ReturnType<typeof fx.signedInAs>>, leadId: string) =>
    (await api.get(`/api/leads/${leadId}`)).body.lead.actions as string[];

  // Every way a note is added: the action list, and the one POST route. Both must say the same thing.
  const cases: Array<[string, boolean, Record<string, SwitchValue>]> = [
    ['Add notes alone', true, { add_notes: true }],
    ['Edit leads alone', true, { edit_leads: true }],
    ['Add notes and Edit leads', true, { add_notes: true, edit_leads: true }],
    ['neither', false, {}],
  ];

  it.each(cases)('with %s: add_note in the list is %s and the route agrees', async (_name, allowed, values) => {
    const { org, customer } = await newOrg();
    const lead = await fx.addLead(org, customer);
    const api = await fx.signedInAs(await personWith(org, values));

    expect((await actionsOf(api, lead.id)).includes('add_note')).toBe(allowed);

    const res = await api.post(`/api/leads/${lead.id}/notes`, { content: 'Customer prefers mornings' });
    expect(res.status).toBe(allowed ? 201 : 403);
    expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: lead.id } })).toBe(allowed ? 1 : 0);
    if (allowed) {
      const listed = (await api.get(`/api/leads/${lead.id}/notes`)).body.notes as Array<{ content: string; creator: { id: string } }>;
      expect(listed.map((n) => n.content)).toEqual(['Customer prefers mornings']);
    }
  });

  it('gives a person who cannot open the lead no add_note, no notes, and the lead\'s usual refusal', async () => {
    const { org, customer, admin } = await newOrg();
    const lead = await fx.addLead(org, customer);
    await db.note.create({ data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, content: 'secret', created_by: admin.id } });
    const api = await fx.signedInAs(await personWith(org, { add_notes: true, edit_leads: true, leads_scope: 'attached' }));

    const detail = await api.get(`/api/leads/${lead.id}`);
    const list = await api.get(`/api/leads/${lead.id}/notes`);
    const add = await api.post(`/api/leads/${lead.id}/notes`, { content: 'sneaky' });

    // The lead's usual refusal for a lead out of reach: not found, as if it did not exist.
    expect([detail.status, list.status, add.status]).toEqual([404, 404, 404]);
    for (const res of [detail, list, add]) {
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
    expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: lead.id } })).toBe(1);
  });

  it('gives a person in a second company the lead\'s not-found answer and no notes', async () => {
    const mine = await newOrg();
    const lead = await fx.addLead(mine.org, mine.customer);
    await db.note.create({ data: { organization_id: mine.org, entity_type: 'LEAD', entity_id: lead.id, content: 'secret', created_by: mine.admin.id } });
    const other = await newOrg();
    const api = await fx.signedInAs(await personWith(other.org, { add_notes: true, edit_leads: true, leads_scope: 'all' }));

    const detail = await api.get(`/api/leads/${lead.id}`);
    const list = await api.get(`/api/leads/${lead.id}/notes`);
    const add = await api.post(`/api/leads/${lead.id}/notes`, { content: 'sneaky' });

    for (const res of [detail, list, add]) {
      expect(res.status).toBe(404);
      expect(JSON.stringify(res.body)).not.toContain('secret');
    }
    expect(await db.note.count({ where: { entity_type: 'LEAD', entity_id: lead.id } })).toBe(1);
  });
});
