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
import {
  reconsiderLeadContact,
  recordLeadContactOnLink,
  recordLeadOutboundContact,
  rowWouldRelease,
  type LeadContactChannel,
  type LeadLink,
} from '../services/lead-contact.service';
import { getLeadCommunications } from '../lib/job-communications';
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
      // The communication rows the D7 cases put on a lead, before the leads they point at.
      await quietly(prisma.message.deleteMany({ where: { organization_id } }));
      await quietly(prisma.messageThread.deleteMany({ where: { organization_id } }));
      await quietly(prisma.email.deleteMany({ where: { organization_id } }));
      await quietly(prisma.callSession.deleteMany({ where: { organization_id } }));
      await quietly(prisma.manualCommunicationLog.deleteMany({ where: { organization_id } }));
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
      'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST',
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

  // SPEC-4 §6.1 / §7.4: an existing communication attached to, or moved onto, a lead. The rule is
  // table-tested in lead-contact-on-link.test.ts; this shows what it writes on Postgres.
  describe('linking an existing communication', () => {
    /** A newly linked outbound human communication that went out, of one kind. */
    function link(f: { orgId: string; userId: string; leadId: string }, overrides: Partial<LeadLink> = {}): LeadLink {
      return {
        source: 'text', channel: 'text', orgId: f.orgId,
        leadIdBefore: null, leadIdAfter: f.leadId,
        directionBefore: 'out', directionAfter: 'out',
        automated: false, deliveryStatus: 'sent',
        at: AT, actorId: f.userId,
        ...overrides,
      };
    }

    it.each<[LeadLink['source'], Partial<LeadLink>, string]>([
      ['text', { source: 'text', channel: 'text', deliveryStatus: 'delivered' }, 'first_outbound_text'],
      ['email', { source: 'email', channel: 'email', deliveryStatus: 'SENT' }, 'first_outbound_email'],
      ['call', { source: 'call', channel: 'call', deliveryStatus: undefined }, 'first_outbound_call'],
      ['log', { source: 'log', channel: 'call', directionBefore: 'OUT', directionAfter: 'OUT', deliveryStatus: undefined }, 'first_outbound_call'],
    ])('a linked %s moves a New lead to Contacted with exactly one History row, dated at the contact', async (_source, kind, via) => {
      const f = await fixture();

      await expect(recordLeadContactOnLink({ client: prisma }, link(f, kind))).resolves.toBe(true);

      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history).toHaveLength(1);
      expect(seen.history[0].metadata).toEqual({ from: 'NEW', to: 'CONTACTED', via });
      expect(seen.history[0].created_at).toEqual(AT);
      expect(seen.history[0].created_by).toBe(f.userId);
      expect(seen.contacted_at).toEqual(AT);
    });

    it('a logged entry moved onto the lead AND flipped from inbound to outbound in one save changes nothing', async () => {
      const f = await fixture();
      await recordLeadContactOnLink({ client: prisma }, link(f, { source: 'log', channel: 'call', directionBefore: 'IN', directionAfter: 'OUT' }));
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    });

    it('an edit of an entry already on the lead changes nothing', async () => {
      const f = await fixture();
      await recordLeadContactOnLink({ client: prisma }, link(f, {
        source: 'log', channel: 'call', directionBefore: 'OUT', directionAfter: 'OUT', leadIdBefore: f.leadId,
      }));
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status: 'NEW', contacted_at: null, history: [] });
    });

    it('a lead already Contacted keeps its status and its first contact time, with no History row', async () => {
      const earlier = new Date('2030-01-02T03:04:05.000Z');
      const f = await fixture({ status: 'CONTACTED', contactedAt: earlier });
      await recordLeadContactOnLink({ client: prisma }, link(f));
      expect(await observe(f.orgId, f.leadId)).toMatchObject({ status: 'CONTACTED', contacted_at: earlier, history: [] });
    });

    it('a New lead whose contact clock is already set moves, and the clock keeps its first instant', async () => {
      const earlier = new Date('2030-01-02T03:04:05.000Z');
      const f = await fixture({ contactedAt: earlier });
      await recordLeadContactOnLink({ client: prisma }, link(f));
      const seen = await observe(f.orgId, f.leadId);
      expect(seen.status).toBe('CONTACTED');
      expect(seen.history.map((h) => h.metadata)).toEqual([{ from: 'NEW', to: 'CONTACTED', via: 'first_outbound_text' }]);
      expect(seen.contacted_at).toEqual(earlier);
    });
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

  // ─── D7 (SPEC-4 §6.12.3, §7.4): reconsidering a lead an entry left ─────────────────────────
  //
  // A lead stays Contacted only while an entry that would have released it is still on it. When a
  // person's change takes the last one away, the lead goes back to New: status New, first contact
  // time cleared, a fresh New stay for Spider, one History row credited to that person. Asserted on
  // what the business sees: the lead row and its STATUS_CHANGE History, read back off Postgres.
  describe('reconsidering a lead an entry left', () => {
    const FIRST_TOUCH = new Date('2031-03-01T10:00:00.000Z');
    const NOW = new Date('2031-03-05T12:00:00.000Z');
    const MOVED_BACK = {
      from: 'CONTACTED', to: 'NEW', via: 'no_outbound_contact_left',
    };

    /** A lead in the org that an outbound contact moved to Contacted, the way the release door leaves it. */
    async function contactedByOutbound(
      f: { orgId: string; userId: string },
      opts: { via?: string; contactedSetBy?: string | null; status?: LeadStatus; history?: boolean } = {},
    ) {
      const leadId = randomUUID();
      const customerId = (await prisma.customer.findFirstOrThrow({ where: { organization_id: f.orgId }, select: { id: true } })).id;
      await prisma.lead.create({
        data: {
          id: leadId, organization_id: f.orgId, lead_number: `L-${leadId.slice(0, 8)}`, customer_id: customerId,
          service_request: 'Door', status: opts.status ?? 'CONTACTED', contacted_at: FIRST_TOUCH,
          contacted_set_by: opts.contactedSetBy ?? null,
        },
      });
      if (opts.history !== false) {
        await prisma.timelineEvent.create({
          data: {
            organization_id: f.orgId, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE',
            description: 'Lead moved to Contacted: first outbound call',
            metadata: { from: 'NEW', to: 'CONTACTED', via: opts.via ?? 'first_outbound_call' },
            created_by: f.userId, created_at: FIRST_TOUCH,
          },
        });
      }
      return leadId;
    }

    async function lead(leadId: string) {
      return prisma.lead.findUniqueOrThrow({
        where: { id: leadId },
        select: { status: true, contacted_at: true, returned_to_new_at: true },
      });
    }

    async function movedBackRows(orgId: string, leadId: string) {
      return prisma.timelineEvent.findMany({
        where: { organization_id: orgId, entity_id: leadId, event_type: 'STATUS_CHANGE', description: { startsWith: 'Lead moved back to New' } },
        select: { description: true, metadata: true, created_by: true, created_at: true },
      });
    }

    const reconsider = (f: { orgId: string; userId: string }, leadId: string, now = NOW) =>
      reconsiderLeadContact({ client: prisma }, {
        leadId, orgId: f.orgId, actorId: f.userId, entry: { source: 'text', id: 'entry-1' }, now,
      });

    // One stored row of each table on a lead, with the fields D7 reads.
    async function textOn(orgId: string, leadId: string, row: { direction: string; automated: boolean | null; status: string | null }) {
      const thread = randomUUID();
      await prisma.messageThread.create({ data: { id: thread, organization_id: orgId, campaign_type: 'customer_care' } });
      await prisma.message.create({
        data: { organization_id: orgId, thread_id: thread, body: 'b', ts: FIRST_TOUCH, lead_id: leadId, ...row },
      });
    }
    async function emailOn(orgId: string, leadId: string, row: { direction: string | null; automated: boolean | null; delivery_status: string | null }) {
      await prisma.email.create({
        data: {
          organization_id: orgId, account: 'user', from: { name: null, email: 'office@example.com' }, to: 'c@example.com',
          subject: 's', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(FIRST_TOUCH.getTime()), folder: 'sent', lead_id: leadId,
          direction: row.direction, automated: row.automated,
          delivery_status: row.delivery_status as never,
        },
      });
    }
    async function callOn(orgId: string, leadId: string, direction: string) {
      await prisma.callSession.create({
        data: {
          organization_id: orgId, direction, from_number: '+15550100001', to_number: '+15550100002', status: 'completed',
          answered_by: { kind: 'none' }, started_at: FIRST_TOUCH, lead_id: leadId,
        },
      });
    }
    async function logOn(f: { orgId: string; userId: string }, leadId: string, direction: 'OUT' | 'IN') {
      await prisma.manualCommunicationLog.create({
        data: {
          organization_id: f.orgId, direction, occurred_at: FIRST_TOUCH, performed_by: f.userId, logged_by: f.userId,
          notes: 'n', lead_id: leadId,
        },
      });
    }

    it('a lead an outbound call made Contacted, with nothing left on it, moves back to New with one History row credited to the person', async () => {
      const f = await fixture();
      const leadId = await contactedByOutbound(f);

      await expect(reconsider(f, leadId)).resolves.toBe(true);

      expect(await lead(leadId)).toEqual({ status: 'NEW', contacted_at: null, returned_to_new_at: NOW });
      expect(await movedBackRows(f.orgId, leadId)).toEqual([{
        description: 'Lead moved back to New: no outbound contact left',
        metadata: { ...MOVED_BACK, entry_source: 'text', entry_id: 'entry-1' },
        created_by: f.userId,
        created_at: NOW,
      }]);
    });

    it('a second reconsider of a lead already back in New changes nothing', async () => {
      const f = await fixture();
      const leadId = await contactedByOutbound(f);
      await reconsider(f, leadId);

      await expect(reconsider(f, leadId, new Date(NOW.getTime() + 60_000))).resolves.toBe(false);

      expect(await lead(leadId)).toEqual({ status: 'NEW', contacted_at: null, returned_to_new_at: NOW });
      expect(await movedBackRows(f.orgId, leadId)).toHaveLength(1);
    });

    // THE DRIFT GRID. `HOLDS_LEAD_WHERE` is the release rule written as a query; `rowWouldRelease` is
    // the same rule as a function. One row at a time on the lead, over every direction, provenance
    // and status each table can hold: the lead is kept Contacted exactly when the function says the
    // row would have released it.
    describe('the drift grid: the query keeps a lead exactly when the release rule says the row holds it', () => {
      const AUTOMATED = [true, false, null];

      it('texts', async () => {
        const f = await fixture();
        let held = 0;
        for (const direction of ['out', 'OUT', 'in']) for (const automated of AUTOMATED)
          for (const status of ['sent', 'delivered', 'skipped', 'failed', 'queued', null]) {
            const leadId = await contactedByOutbound(f);
            await textOn(f.orgId, leadId, { direction, automated, status });
            await reconsider(f, leadId);
            const kept = (await lead(leadId)).status === 'CONTACTED';
            const holds = rowWouldRelease('text', { direction, automated, deliveryStatus: status });
            expect({ direction, automated, status, kept }).toEqual({ direction, automated, status, kept: holds });
            if (holds) held += 1;
          }
        expect(held).toBeGreaterThan(0);
      });

      it('emails', async () => {
        const f = await fixture();
        let held = 0;
        for (const direction of ['out', 'OUT', 'in', null]) for (const automated of AUTOMATED)
          for (const status of ['SENT', 'DELIVERED', 'QUEUED', 'DEFERRED', 'BOUNCED', 'FAILED', 'COMPLAINED', null]) {
            const leadId = await contactedByOutbound(f);
            await emailOn(f.orgId, leadId, { direction, automated, delivery_status: status });
            await reconsider(f, leadId);
            const kept = (await lead(leadId)).status === 'CONTACTED';
            const holds = rowWouldRelease('email', { direction, automated, deliveryStatus: status });
            expect({ direction, automated, status, kept }).toEqual({ direction, automated, status, kept: holds });
            if (holds) held += 1;
          }
        expect(held).toBeGreaterThan(0);
      });

      it('calls (no provenance column: every call is a person dialling)', async () => {
        const f = await fixture();
        for (const direction of ['out', 'OUT', 'in']) {
          const leadId = await contactedByOutbound(f);
          await callOn(f.orgId, leadId, direction);
          await reconsider(f, leadId);
          const kept = (await lead(leadId)).status === 'CONTACTED';
          expect({ direction, kept }).toEqual({ direction, kept: rowWouldRelease('call', { direction, automated: false }) });
        }
      });

      it('logged entries', async () => {
        const f = await fixture();
        for (const direction of ['OUT', 'IN'] as const) {
          const leadId = await contactedByOutbound(f);
          await logOn(f, leadId, direction);
          await reconsider(f, leadId);
          const kept = (await lead(leadId)).status === 'CONTACTED';
          expect({ direction, kept }).toEqual({ direction, kept: rowWouldRelease('log', { direction, automated: false }) });
        }
      });
    });

    it('a holding entry on ANOTHER lead of the same customer does not hold this one', async () => {
      const f = await fixture();
      const leadId = await contactedByOutbound(f);
      const sibling = await contactedByOutbound(f);
      await callOn(f.orgId, sibling, 'out');

      await expect(reconsider(f, leadId)).resolves.toBe(true);

      expect((await lead(leadId)).status).toBe('NEW');
      expect((await lead(sibling)).status).toBe('CONTACTED');
    });

    it('an entry of another company does not hold the lead, and another company\'s lead is never touched', async () => {
      const mine = await fixture();
      const theirs = await fixture();
      const leadId = await contactedByOutbound(mine);
      // A row naming my lead but written in another company cannot hold it.
      await logOn({ ...theirs }, leadId, 'OUT').catch(() => undefined);
      const theirLead = await contactedByOutbound(theirs);

      await expect(reconsiderLeadContact({ client: prisma }, {
        leadId: theirLead, orgId: mine.orgId, actorId: mine.userId, entry: { source: 'log', id: 'x' }, now: NOW,
      })).resolves.toBe(false);
      expect(await lead(theirLead)).toEqual({ status: 'CONTACTED', contacted_at: FIRST_TOUCH, returned_to_new_at: null });

      await expect(reconsider(mine, leadId)).resolves.toBe(true);
      expect((await lead(leadId)).status).toBe('NEW');
    });

    describe('what keeps Contacted', () => {
      it.each<LeadStatus>(['NEW', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST'])(
        'a lead at %s keeps its status and first contact time',
        async (status) => {
          const f = await fixture();
          const leadId = await contactedByOutbound(f, { status });
          await expect(reconsider(f, leadId)).resolves.toBe(false);
          expect(await lead(leadId)).toEqual({ status, contacted_at: FIRST_TOUCH, returned_to_new_at: null });
          expect(await movedBackRows(f.orgId, leadId)).toEqual([]);
        },
      );

      it('a contact time set by hand', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f, { contactedSetBy: f.userId });
        await expect(reconsider(f, leadId)).resolves.toBe(false);
        expect(await lead(leadId)).toEqual({ status: 'CONTACTED', contacted_at: FIRST_TOUCH, returned_to_new_at: null });
      });

      it.each(['manual_edit', 'contact_set_by_hand', 'walkthrough_cancelled'])(
        'a newest move into Contacted made by a person (via %s)',
        async (via) => {
          const f = await fixture();
          const leadId = await contactedByOutbound(f, { via });
          await expect(reconsider(f, leadId)).resolves.toBe(false);
          expect((await lead(leadId)).status).toBe('CONTACTED');
        },
      );

      it('an outbound move into Contacted that a later hand move superseded', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f);
        await prisma.timelineEvent.create({
          data: {
            organization_id: f.orgId, entity_type: 'LEAD', entity_id: leadId, event_type: 'STATUS_CHANGE',
            description: 'Lead status changed to Contacted', metadata: { from: 'NEW', to: 'CONTACTED', via: 'manual_edit' },
            created_by: f.userId, created_at: new Date(FIRST_TOUCH.getTime() + 3_600_000),
          },
        });
        await expect(reconsider(f, leadId)).resolves.toBe(false);
        expect((await lead(leadId)).status).toBe('CONTACTED');
      });

      it('a lead with no recorded move into Contacted at all (older data)', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f, { history: false });
        await expect(reconsider(f, leadId)).resolves.toBe(false);
        expect((await lead(leadId)).status).toBe('CONTACTED');
      });
    });

    it('the Communication tab shows nothing new after a move back: exactly the rows still on the lead', async () => {
      const f = await fixture();
      const leadId = await contactedByOutbound(f);
      await logOn(f, leadId, 'IN');
      const before = await getLeadCommunications(prisma, { leadId, organizationId: f.orgId });

      await expect(reconsider(f, leadId)).resolves.toBe(true);

      const after = await getLeadCommunications(prisma, { leadId, organizationId: f.orgId });
      expect(after).toEqual(before);
      expect(after).toHaveLength(1);
    });

    // §6.12.3 concurrency: the lead row lock is what makes the count trustworthy. A new holding entry
    // linked to the lead while the lead is being reconsidered must never leave it New with that
    // entry on it: either the count sees the entry, or the link's stamp waits for the move back and
    // then releases the lead again.
    it('a reconsider racing a new link of a holding entry never leaves the lead New with it on (repeated)', async () => {
      const f = await fixture();
      for (let round = 0; round < 15; round += 1) {
        const leadId = await contactedByOutbound(f);
        const thread = randomUUID();
        await prisma.messageThread.create({ data: { id: thread, organization_id: f.orgId, campaign_type: 'customer_care' } });
        const linkIt = async () => {
          await prisma.message.create({
            data: { organization_id: f.orgId, thread_id: thread, direction: 'out', body: 'b', ts: AT, status: 'sent', automated: false, lead_id: leadId },
          });
          await recordLeadContactOnLink({ client: prisma }, {
            source: 'text', channel: 'text', orgId: f.orgId, leadIdBefore: null, leadIdAfter: leadId,
            directionBefore: 'out', directionAfter: 'out', automated: false, deliveryStatus: 'sent', at: AT, actorId: f.userId,
          });
        };
        await Promise.all([reconsider(f, leadId), linkIt()]);
        const seen = await lead(leadId);
        expect({ round, status: seen.status, clockSet: seen.contacted_at !== null }).toEqual({ round, status: 'CONTACTED', clockSet: true });
      }
    });

    it('two reconsiders of the same lead at once write exactly one History row', async () => {
      const f = await fixture();
      const leadId = await contactedByOutbound(f);
      await Promise.all([reconsider(f, leadId), reconsider(f, leadId)]);
      expect((await lead(leadId)).status).toBe('NEW');
      expect(await movedBackRows(f.orgId, leadId)).toHaveLength(1);
    });

    describe('inside the caller\'s transaction ({ tx })', () => {
      it('rolls back with the caller', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f);
        await expect(prisma.$transaction(async (tx) => {
          await reconsiderLeadContact({ tx }, { leadId, orgId: f.orgId, actorId: f.userId, entry: { source: 'log', id: 'e' }, now: NOW });
          throw new Error('the caller rolls back');
        })).rejects.toThrow('the caller rolls back');
        expect(await lead(leadId)).toEqual({ status: 'CONTACTED', contacted_at: FIRST_TOUCH, returned_to_new_at: null });
        expect(await movedBackRows(f.orgId, leadId)).toEqual([]);
      });

      it('commits with the caller', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f);
        await prisma.$transaction((tx) =>
          reconsiderLeadContact({ tx }, { leadId, orgId: f.orgId, actorId: f.userId, entry: { source: 'log', id: 'e' }, now: NOW }));
        expect(await lead(leadId)).toEqual({ status: 'NEW', contacted_at: null, returned_to_new_at: NOW });
      });

      // A History row whose actor is not a user breaks the timeline's foreign key: a real failure
      // raised by the database after the lead row was already written in the savepoint.
      it('a failure rolls back to its savepoint, is logged with ids only, and the caller\'s own writes still commit', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f);
        let settled: unknown = 'not reached';
        await prisma.$transaction(async (tx) => {
          await tx.lead.update({ where: { id: leadId }, data: { service_request: 'Door, written before' } });
          settled = await reconsiderLeadContact({ tx }, { leadId, orgId: f.orgId, actorId: randomUUID(), entry: { source: 'log', id: 'entry-9' }, now: NOW });
        });
        expect(settled).toBe(false);
        expect(await lead(leadId)).toEqual({ status: 'CONTACTED', contacted_at: FIRST_TOUCH, returned_to_new_at: null });
        expect((await prisma.lead.findUniqueOrThrow({ where: { id: leadId }, select: { service_request: true } })).service_request).toBe('Door, written before');
        expect(logger.error).toHaveBeenCalledTimes(1);
        const logged = JSON.stringify((logger.error as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]);
        expect(logged).toContain(leadId);
        expect(logged).toContain('entry-9');
      });

      it('plain client: a failure resolves false, is logged, and leaves the lead Contacted', async () => {
        const f = await fixture();
        const leadId = await contactedByOutbound(f);
        await expect(reconsiderLeadContact({ client: prisma }, {
          leadId, orgId: f.orgId, actorId: randomUUID(), entry: { source: 'call', id: 'c' }, now: NOW,
        })).resolves.toBe(false);
        expect(logger.error).toHaveBeenCalledTimes(1);
        expect(await lead(leadId)).toEqual({ status: 'CONTACTED', contacted_at: FIRST_TOUCH, returned_to_new_at: null });
      });
    });
  });
});
