/* =============================================================================
   Spec #2618, Seam A: the contact-recording service moves a New lead to Contacted.

   `recordLeadOutboundContact` (spec #1751 D5) is the one rule that decides whether an outbound
   message counts as "somebody reached out to this lead". As of #2618 a qualifying contact on a
   NEW lead also moves it to CONTACTED, through the single status writer (D6), with a History row
   carrying from / to / actor / channel. The guard ("only from New") lives in the WHERE clause of
   the write, so it is Postgres's behaviour under test here and a mocked client cannot check it.

   What a business owner sees is asserted: the lead's status, its STATUS_CHANGE History rows and
   its contact clock, read back off a real migrated database (TEST_DATABASE_URL). Skips when that
   is unset, like every other *-db suite. Every org this suite creates is removed in afterAll.
   ========================================================================== */

import { describe, it, expect, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { PrismaClient, type LeadStatus } from '@prisma/client';
import { recordLeadOutboundContact, type LeadContactChannel } from '../services/lead-contact.service';
import { logger } from '../lib/logger';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

suite('an outbound contact moves a New lead to Contacted (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  beforeEach(() => {
    (logger.error as unknown as { mockClear: () => void }).mockClear();
  });

  async function fixture(opts: { status?: LeadStatus; contactedAt?: Date | null } = {}) {
    const orgId = randomUUID();
    orgs.push(orgId);
    const tag = orgId.slice(0, 8);
    await prisma.organization.create({
      data: {
        id: orgId, name: `lc2618-${tag}`, email: `lc2618-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const userId = randomUUID();
    await prisma.user.create({
      data: { id: userId, organization_id: orgId, email: `rep-${tag}@example.test`, first_name: 'Rita', last_name: 'Rep', role: 'ADMIN' },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, organization_id: orgId, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Test', last_name: 'Customer' },
    });
    const leadId = randomUUID();
    await prisma.lead.create({
      data: {
        id: leadId, organization_id: orgId, lead_number: 'L00001', customer_id: customerId,
        service_request: 'Door', status: opts.status ?? 'NEW', contacted_at: opts.contactedAt ?? null,
      },
    });
    return { orgId, userId, leadId };
  }

  /** What the business sees: the status, the contact clock, and the status History rows. */
  async function observe(orgId: string, leadId: string) {
    const lead = await prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { status: true, contacted_at: true, contacted_set_by: true },
    });
    const history = await prisma.timelineEvent.findMany({
      where: { organization_id: orgId, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE' },
      select: { metadata: true, created_by: true, description: true, created_at: true },
      orderBy: { created_at: 'asc' },
    });
    return { ...lead, history };
  }

  const AT = new Date('2031-03-04T15:06:07.000Z');

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const organization_id of orgs) {
      await quietly(prisma.timelineEvent.deleteMany({ where: { organization_id } }));
      await quietly(prisma.lead.deleteMany({ where: { organization_id } }));
      await quietly(prisma.customer.deleteMany({ where: { organization_id } }));
      await quietly(prisma.user.deleteMany({ where: { organization_id } }));
      await quietly(prisma.organization.deleteMany({ where: { id: organization_id } }));
    }
    await prisma.$disconnect();
  });

  describe('a human outbound contact on a New lead', () => {
    it.each<[LeadContactChannel, string]>([
      ['text', 'first_outbound_text'],
      ['call', 'first_outbound_call'],
      ['email', 'first_outbound_email'],
    ])('outbound %s: the lead becomes Contacted with exactly one History row naming the channel', async (channel, via) => {
      const f = await fixture();

      await recordLeadOutboundContact({ client: prisma }, {
        leadId: f.leadId, orgId: f.orgId, channel, direction: 'out', automated: false, at: AT, actorId: f.userId,
      });

      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history).toHaveLength(1);
      expect(seen.history[0].metadata).toEqual({ from: 'NEW', to: 'CONTACTED', via });
      expect(seen.history[0].created_by).toBe(f.userId);
      expect(seen.history[0].description).toBe(`Lead moved to Contacted: first outbound ${channel}`);
      // The contact clock is written by the contact, exactly as before, never by the move.
      expect(seen.contacted_at).toEqual(AT);
      expect(seen.contacted_set_by).toBeNull();
    });

    it('inside the caller\'s transaction: the move commits and rolls back with the caller', async () => {
      const kept = await fixture();
      await prisma.$transaction(async (tx) => {
        await recordLeadOutboundContact({ tx }, {
          leadId: kept.leadId, orgId: kept.orgId, channel: 'call', direction: 'out', automated: false, at: AT, actorId: kept.userId,
        });
      });
      const seenKept = await observe(kept.orgId, kept.leadId);
      expect(seenKept.status).toBe('CONTACTED');
      expect(seenKept.history.map((h) => h.metadata)).toEqual([{ from: 'NEW', to: 'CONTACTED', via: 'first_outbound_call' }]);
      expect(seenKept.contacted_at).toEqual(AT);

      const undone = await fixture();
      await expect(prisma.$transaction(async (tx) => {
        await recordLeadOutboundContact({ tx }, {
          leadId: undone.leadId, orgId: undone.orgId, channel: 'call', direction: 'out', automated: false, at: AT, actorId: undone.userId,
        });
        throw new Error('the caller rolls back');
      })).rejects.toThrow('the caller rolls back');
      const seenUndone = await observe(undone.orgId, undone.leadId);
      expect(seenUndone).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    });

    // A call logged by hand weeks after it happened, or a historical import, must date the move at
    // the contact itself, exactly as the one-time update dates it at `contacted_at`. Dated at the
    // moment of recording, "time in Contacted" would start months late.
    it.each<['client' | 'tx']>([['client'], ['tx']])('the History row is dated at the contact, not when it was recorded (%s)', async (path) => {
      const f = await fixture();
      const longAgo = new Date('2024-05-06T07:08:09.000Z');
      const touch = {
        leadId: f.leadId, orgId: f.orgId, channel: 'call' as const, direction: 'out', automated: false, at: longAgo, actorId: f.userId,
      };
      if (path === 'client') await recordLeadOutboundContact({ client: prisma }, touch);
      else await prisma.$transaction((tx) => recordLeadOutboundContact({ tx }, touch));
      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history).toHaveLength(1);
      expect(seen.history[0].created_at).toEqual(longAgo);
    });

    it('no actor known (a phone-system text): the move is recorded as a system move', async () => {
      const f = await fixture();
      await recordLeadOutboundContact({ client: prisma }, {
        leadId: f.leadId, orgId: f.orgId, channel: 'text', direction: 'out', automated: false, at: AT,
      });
      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history).toHaveLength(1);
      expect(seen.history[0].created_by).toBeNull();
    });

    it('a New lead whose contact clock is already set still moves, and the clock keeps its first instant', async () => {
      const earlier = new Date('2030-01-02T03:04:05.000Z');
      const f = await fixture({ contactedAt: earlier });
      await recordLeadOutboundContact({ client: prisma }, {
        leadId: f.leadId, orgId: f.orgId, channel: 'email', direction: 'out', automated: false, at: AT, actorId: f.userId,
      });
      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history.map((h) => h.metadata)).toEqual([{ from: 'NEW', to: 'CONTACTED', via: 'first_outbound_email' }]);
      expect(seen.contacted_at).toEqual(earlier);
    });

    it('a second and third contact add no further History rows', async () => {
      const f = await fixture();
      for (const [channel, at] of [['text', AT], ['call', new Date(AT.getTime() + 60_000)], ['email', new Date(AT.getTime() + 120_000)]] as const) {
        await recordLeadOutboundContact({ client: prisma }, {
          leadId: f.leadId, orgId: f.orgId, channel, direction: 'out', automated: false, at, actorId: f.userId,
        });
      }
      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history.map((h) => h.metadata)).toEqual([{ from: 'NEW', to: 'CONTACTED', via: 'first_outbound_text' }]);
      expect(seen.contacted_at).toEqual(AT);
    });
  });

  describe('contacts that do not count change nothing', () => {
    it.each<[string, { direction: string | null; automated?: boolean | null }]>([
      ['an automated outbound text', { direction: 'out', automated: true }],
      ['an inbound text from the customer', { direction: 'in', automated: false }],
      ['a message of unknown direction', { direction: null, automated: false }],
    ])('%s', async (_label, touch) => {
      const f = await fixture();
      await recordLeadOutboundContact({ client: prisma }, {
        leadId: f.leadId, orgId: f.orgId, channel: 'text', at: AT, actorId: f.userId, ...touch,
      });
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    });
  });

  describe('a lead already past New stays where it is', () => {
    it.each<LeadStatus>([
      'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED',
    ])('%s: status unchanged and no History row; the clock still stamps as before', async (status) => {
      const f = await fixture({ status });
      await recordLeadOutboundContact({ client: prisma }, {
        leadId: f.leadId, orgId: f.orgId, channel: 'call', direction: 'out', automated: false, at: AT, actorId: f.userId,
      });
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status, contacted_at: AT, history: [] });
    });
  });

  it('another company\'s lead is never touched', async () => {
    const mine = await fixture();
    const theirs = await fixture();
    await recordLeadOutboundContact({ client: prisma }, {
      leadId: theirs.leadId, orgId: mine.orgId, channel: 'text', direction: 'out', automated: false, at: AT, actorId: mine.userId,
    });
    expect(await observe(theirs.orgId, theirs.leadId)).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    const anyRowsInMyOrg = await prisma.timelineEvent.count({ where: { organization_id: mine.orgId } });
    expect(anyRowsInMyOrg).toBe(0);
  });

  describe('a failure in the move never fails the send', () => {
    // A History row whose actor is not a user breaks the timeline's foreign key: a real failure
    // raised by the database part-way through, after the clock stamp has already been written.
    it('plain client: resolves, logs at error level, and leaves neither the status nor the clock half-written', async () => {
      const f = await fixture();
      await expect(recordLeadOutboundContact({ client: prisma }, {
        leadId: f.leadId, orgId: f.orgId, channel: 'text', direction: 'out', automated: false, at: AT, actorId: randomUUID(),
      })).resolves.toBe(false);
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    });

    // Spec story 19: the caller's transaction holds the message itself (the hand-logged entry, the
    // phone-system call or text row). A failed status move must not abort it in Postgres, or the
    // message the user sent is rolled back with the bookkeeping.
    it('inside the caller\'s transaction: resolves, logs, and the caller\'s own writes before and after still commit', async () => {
      const f = await fixture();
      let settled: unknown = 'not reached';
      await expect(prisma.$transaction(async (tx) => {
        await tx.lead.update({ where: { id: f.leadId }, data: { service_request: 'Door, written before the contact' } });
        settled = await recordLeadOutboundContact({ tx }, {
          leadId: f.leadId, orgId: f.orgId, channel: 'call', direction: 'out', automated: false, at: AT, actorId: randomUUID(),
        });
        await tx.timelineEvent.create({
          data: {
            organization_id: f.orgId, entity_type: 'LEAD', entity_id: f.leadId, event_type: 'COMMUNICATION_LOGGED',
            description: 'written after the contact', created_by: f.userId,
          },
        });
      })).resolves.toBeUndefined();
      expect(settled).toBe(false);
      expect(logger.error).toHaveBeenCalledTimes(1);
      // The caller's message survives; the contact's own writes are undone together, as with the plain client.
      const lead = await prisma.lead.findUniqueOrThrow({ where: { id: f.leadId }, select: { service_request: true } });
      expect(lead.service_request).toBe('Door, written before the contact');
      const after = await prisma.timelineEvent.count({ where: { organization_id: f.orgId, entity_id: f.leadId, event_type: 'COMMUNICATION_LOGGED' } });
      expect(after).toBe(1);
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    });
  });
});
