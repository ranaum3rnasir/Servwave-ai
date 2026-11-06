/* =============================================================================
   Booking a walkthrough carries its notes. The book request takes optional notes, written on the walkthrough it
   CREATES (timed, or "To be scheduled" when the new-lead request names performers and no time), "Book Another Visit"
   stores the notes its route takes, and a reschedule of an existing walkthrough - on either door - leaves the stored
   notes exactly as they were, even if notes ride in the body. Booking stays gated by Book walkthroughs. Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset.
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
vi.unmock('../lib/numbering');

import { switchFixture } from './permission-switches-fixture';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

type SwitchValue = boolean | string | string[];
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);
const HOUR = 3_600_000;
const startAt = (days: number) => new Date(Date.now() + days * 24 * HOUR - (Date.now() % HOUR)).toISOString();

suite('booking a walkthrough carries its notes (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  async function personWith(org: string, values: Record<string, SwitchValue>) {
    const key = `book-notes-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key,
      values: { ...ALL_OFF, view_leads: true, leads_scope: 'all', ...values }, actorId: null, reason: 'manual',
    });
    return fx.addUser(org, `bn${sequence}`, 'DISPATCHER', { customRoleId: role.id });
  }
  const booker = (org: string, extra: Record<string, SwitchValue> = {}) =>
    personWith(org, { book_walkthroughs: true, edit_leads: true, create_leads: true, can_be_on_crew: true, ...extra });

  const visitsOf = (leadId: string) =>
    db.visit.findMany({ where: { lead_id: leadId, purpose: 'WALKTHROUGH' }, orderBy: { visit_seq: 'asc' }, select: { id: true, notes: true, scheduled_at: true, status: true } });
  const TYPED = 'Customer says the gate code is on the side door';
  const ORIGINAL = 'Original notes from the first booking';

  // Every way in: timed book, unscheduled book, extra visit, reschedule via both routes.
  type Way = { name: string; run: (api: Awaited<ReturnType<typeof fx.signedInAs>>, ctx: { org: string; customer: string; me: string }) => Promise<{ leadId: string; expected: Array<string | null> }> };
  const ways: Way[] = [
    {
      name: 'timed booking on a lead with no walkthrough',
      run: async (api, { org, customer }) => {
        const lead = await fx.addLead(org, customer);
        const res = await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(3), performer_ids: [], notes: TYPED });
        expect(res.status).toBe(200);
        return { leadId: lead.id, expected: [TYPED] };
      },
    },
    {
      name: '"To be scheduled" booking (performers, no time)',
      run: async (api, { customer, me }) => {
        const res = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door', walkthrough_performer_ids: [me], walkthrough_notes: TYPED });
        expect(res.status).toBe(201);
        return { leadId: res.body.lead.id, expected: [TYPED] };
      },
    },
    {
      name: 'timed booking made with the new-lead request',
      run: async (api, { customer, me }) => {
        const res = await api.post('/api/leads', { customer_id: customer, service_request: 'Fix the door', scheduled_start: startAt(4), walkthrough_performer_ids: [me], walkthrough_notes: TYPED });
        expect(res.status).toBe(201);
        return { leadId: res.body.lead.id, expected: [TYPED] };
      },
    },
    {
      name: 'Book Another Visit',
      run: async (api, { org, customer, me }) => {
        const lead = await fx.addLead(org, customer, { walkthroughCrew: [me] });
        const first = await visitsOf(lead.id);
        await db.visit.update({ where: { id: first[0]!.id }, data: { notes: ORIGINAL } });
        const res = await api.post(`/api/leads/${lead.id}/visits`, { scheduled_at: startAt(5), assignee_ids: [me], notes: TYPED });
        expect(res.status).toBe(201);
        return { leadId: lead.id, expected: [ORIGINAL, TYPED] };
      },
    },
    {
      name: 'reschedule via POST /walkthrough/schedule, notes in the body',
      run: async (api, { org, customer, me }) => {
        const lead = await fx.addLead(org, customer, { walkthroughCrew: [me] });
        const [v] = await visitsOf(lead.id);
        await db.visit.update({ where: { id: v!.id }, data: { notes: ORIGINAL } });
        const res = await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(6), performer_ids: [me], notes: 'Replacement' });
        expect(res.status).toBe(200);
        return { leadId: lead.id, expected: [ORIGINAL] };
      },
    },
    {
      name: 'reschedule via PATCH /visits/:visitId, notes in the body',
      run: async (api, { org, customer, me }) => {
        const lead = await fx.addLead(org, customer, { walkthroughCrew: [me] });
        const [v] = await visitsOf(lead.id);
        await db.visit.update({ where: { id: v!.id }, data: { notes: ORIGINAL } });
        const res = await api.patch(`/api/leads/${lead.id}/visits/${v!.id}`, { walkthrough_scheduled_at: startAt(7), performer_ids: [me], notes: '' });
        expect(res.status).toBe(200);
        return { leadId: lead.id, expected: [ORIGINAL] };
      },
    },
  ];

  it.each(ways)('$name leaves the right notes on the right walkthrough', async ({ run }) => {
    const { org, customer } = await fx.newOrg();
    const me = await booker(org);
    const api = await fx.signedInAs(me);
    const { leadId, expected } = await run(api, { org, customer, me: me.id });
    expect((await visitsOf(leadId)).map((v) => v.notes)).toEqual(expected);
  });

  it('gives a booking with no notes a walkthrough with no notes', async () => {
    const { org, customer } = await fx.newOrg();
    const api = await fx.signedInAs(await booker(org));
    const lead = await fx.addLead(org, customer);
    expect((await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(3), performer_ids: [] })).status).toBe(200);
    expect((await visitsOf(lead.id)).map((v) => v.notes)).toEqual([null]);
  });

  it('refuses notes longer than the walkthrough notes limit', async () => {
    const { org, customer } = await fx.newOrg();
    const api = await fx.signedInAs(await booker(org));
    const lead = await fx.addLead(org, customer);
    const res = await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(3), performer_ids: [], notes: 'x'.repeat(200_000) });
    expect(res.status).toBe(400);
    expect(await visitsOf(lead.id)).toHaveLength(0);
  });

  it('refuses without Book walkthroughs, as today, and writes no notes', async () => {
    const { org, customer } = await fx.newOrg();
    const api = await fx.signedInAs(await personWith(org, { edit_leads: true, add_notes: true }));
    const lead = await fx.addLead(org, customer);
    const res = await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(3), performer_ids: [], notes: TYPED });
    const extra = await api.post(`/api/leads/${lead.id}/visits`, { scheduled_at: startAt(3), assignee_ids: [], notes: TYPED });
    expect([res.status, extra.status]).toEqual([403, 403]);
    expect(await visitsOf(lead.id)).toHaveLength(0);
  });

  it('refuses notes typed on a new lead without Book walkthroughs, creates nothing, and still creates the lead without notes', async () => {
    const { org, customer } = await fx.newOrg();
    // Create leads on, Book walkthroughs off (and Perform walkthroughs is not a switch they hold).
    const me = await personWith(org, { create_leads: true, edit_leads: true, can_be_on_crew: true, book_walkthroughs: false });
    const api = await fx.signedInAs(me);
    const count = () => db.lead.count({ where: { customer_id: customer } });
    const visitCount = () => db.visit.count({ where: { lead: { customer_id: customer } } });
    const before = [await count(), await visitCount()];
    const base = { customer_id: customer, service_request: 'Fix the door' };
    const bodies = [
      { ...base, scheduled_start: startAt(3), walkthrough_performer_ids: [me.id], walkthrough_notes: TYPED },
      { ...base, walkthrough_performer_ids: [me.id], walkthrough_notes: TYPED },
      { ...base, walkthrough_notes: TYPED },
    ];
    for (const body of bodies) {
      const res = await api.post('/api/leads', body);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('You do not have permission to add walkthrough notes.');
    }
    expect([await count(), await visitCount()]).toEqual(before);
    // Blank notes count as absent; the same person still books as today.
    const blank = await api.post('/api/leads', { ...base, scheduled_start: startAt(3), walkthrough_performer_ids: [me.id], walkthrough_notes: '   ' });
    expect(blank.status).toBe(201);
    const plain = await api.post('/api/leads', { ...base, walkthrough_performer_ids: [me.id] });
    expect(plain.status).toBe(201);
    expect((await visitsOf(blank.body.lead.id)).map((v) => v.notes)).toEqual([null]);
    expect((await visitsOf(plain.body.lead.id)).map((v) => v.notes)).toEqual([null]);
  });

  it('gives a second-company person and an out-of-reach person the lead\'s usual refusal and writes nothing', async () => {
    const mine = await fx.newOrg();
    const lead = await fx.addLead(mine.org, mine.customer);
    const other = await fx.newOrg();
    const outsider = await fx.signedInAs(await booker(other.org));
    const attachedOnly = await fx.signedInAs(await booker(mine.org, { leads_scope: 'attached' }));
    for (const api of [outsider, attachedOnly]) {
      const res = await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(3), performer_ids: [], notes: TYPED });
      const extra = await api.post(`/api/leads/${lead.id}/visits`, { scheduled_at: startAt(3), assignee_ids: [], notes: TYPED });
      expect([res.status, extra.status]).toEqual([404, 404]);
    }
    expect(await visitsOf(lead.id)).toHaveLength(0);
  });

  it('keeps the typed notes through book -> cancel -> book with notes', async () => {
    const { org, customer } = await fx.newOrg();
    const api = await fx.signedInAs(await booker(org));
    const lead = await fx.addLead(org, customer);
    expect((await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(3), performer_ids: [], notes: ORIGINAL })).status).toBe(200);
    expect((await api.post(`/api/leads/${lead.id}/walkthrough/cancel`, { cancelled_reason: 'Customer changed their mind' })).status).toBe(200);
    expect((await api.post(`/api/leads/${lead.id}/walkthrough/schedule`, { walkthrough_scheduled_at: startAt(4), performer_ids: [], notes: TYPED })).status).toBe(200);
    const visits = await visitsOf(lead.id);
    expect(visits.map((v) => [v.status, v.notes])).toEqual([['CANCELLED', ORIGINAL], ['SCHEDULED', TYPED]]);
  });
});
