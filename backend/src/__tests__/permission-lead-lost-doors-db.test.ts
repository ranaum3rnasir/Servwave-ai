/* =============================================================================
   Roles & Permissions, PRD 5, slice S05.16 - a status change to Lost does what Mark lost does, under Mark leads lost.

   Two doors close a lead as Lost: POST /api/leads/:id/mark-lost and the lead update (PATCH /api/leads/:id with a status of
   Lost). Both ask for a typed reason, both are gated by Mark leads lost (the update door also needs Change lead status by
   hand for the status to move at all), and both do the same things: record the reason and the lost date, cancel the lead's
   live walkthroughs, archive its open estimates and void its unpaid deposit invoices. Each case below is run through both
   doors, and the update door's outcome is compared with the Mark lost door's on an identical lead.

   Everything goes through the lead routes, called as people on custom roles (never a built-in role name) holding the
   switch values under test. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it
   creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog on (a choice at its widest option, a list empty). */
const ALL_ON: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [
    s.key,
    s.kind === 'choice' ? (s.choices!.includes('all') ? 'all' : s.choices![s.choices!.length - 1]!) : s.kind === 'list' ? [] : true,
  ]),
);

const REASON = 'Went with another company';

suite('closing a lead as Lost through the lead update and through Mark lost (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role holding these switch values on top of the Technician preset. */
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person> {
    const key = `lead-lost-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    return fx.addUser(org, `llo${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }

  /**
   * A Walkthrough Scheduled lead the person owns, holding a live walkthrough, a sent estimate and that estimate's unpaid
   * deposit invoice: everything closing the lead has to deal with.
   */
  async function setup(values: Record<string, SwitchValue> = ALL_ON) {
    const { org, tag, admin, customer } = await fx.newOrg();
    const me = await personWith(org, values);
    const lead = await fx.addLead(org, customer, { owner: me.id, walkthroughCrew: [] });
    await db.lead.update({ where: { id: lead.id }, data: { status: 'WALKTHROUGH_SCHEDULED' } });
    const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
    await db.estimate.update({ where: { id: estimate.id }, data: { status: 'SENT' } });
    const deposit = await fx.addInvoice(org, customer, { estimateId: estimate.id, createdBy: admin.id });
    await db.invoice.update({ where: { id: deposit.id }, data: { kind: 'DEPOSIT', status: 'SENT' } });
    // The sign-in is shared by the whole file, so each call signs in again: a case that builds two leads calls both as their own person.
    const api = () => fx.signedInAs(me);
    return { org, tag, customer, me, lead, estimate, deposit, api };
  }

  type Fixture = Awaited<ReturnType<typeof setup>>;

  /** The two doors, called the way the screen calls them. */
  const DOORS: Record<string, (f: Fixture, body?: { lost_reason?: string }) => Promise<{ status: number; body: Record<string, any> }>> = {
    'Mark lost': async (f, body = { lost_reason: REASON }) => (await f.api()).post(`/api/leads/${f.lead.id}/mark-lost`, body),
    'the lead update': async (f, body = { lost_reason: REASON }) => (await f.api()).patch(`/api/leads/${f.lead.id}`, { status: 'LOST', ...body }),
  };

  /** Everything a close can change, read back from the database. */
  async function outcome(f: Fixture) {
    const lead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    const visits = await db.visit.findMany({ where: { lead_id: f.lead.id }, select: { status: true, cancelled_reason: true } });
    const estimate = await db.estimate.findUniqueOrThrow({ where: { id: f.estimate.id } });
    const deposit = await db.invoice.findUniqueOrThrow({ where: { id: f.deposit.id } });
    const history = await db.timelineEvent.findMany({ where: { entity_type: 'LEAD', entity_id: f.lead.id }, orderBy: { created_at: 'asc' } });
    return {
      status: lead.status,
      lostReason: lead.lost_reason,
      hasLostDate: lead.lost_at !== null,
      visits,
      estimateStatus: estimate.status,
      estimateReason: estimate.cancelled_reason,
      depositStatus: deposit.status,
      history: history.map((e) => e.description),
    };
  }

  for (const [door, close] of Object.entries(DOORS)) {
    describe(`through ${door}`, () => {
      it('records the reason and the lost date, cancels the walkthrough, archives the open estimate and voids the unpaid deposit', async () => {
        const f = await setup();

        const res = await close(f);

        expect(res.status).toBe(200);
        expect(res.body.lead.status).toBe('LOST');
        expect(await outcome(f)).toMatchObject({
          status: 'LOST',
          lostReason: REASON,
          hasLostDate: true,
          visits: [{ status: 'CANCELLED', cancelled_reason: 'Lead marked as lost' }],
          estimateStatus: 'ARCHIVED',
          estimateReason: 'Lead marked as lost',
          depositStatus: 'VOIDED',
        });
      });

      it('is refused without Mark leads lost, for a role with Change lead status by hand on, and writes nothing', async () => {
        expect(ALL_ON.change_lead_status_by_hand).toBe(true);
        const f = await setup({ ...ALL_ON, mark_leads_lost: false });
        const before = await outcome(f);

        const res = await close(f);

        expect(res.status).toBe(403);
        expect(await outcome(f)).toEqual(before);
        expect(before).toMatchObject({ status: 'WALKTHROUGH_SCHEDULED', lostReason: null, hasLostDate: false, estimateStatus: 'SENT', depositStatus: 'SENT' });
      });
    });
  }

  describe('a move to Lost with no reason', () => {
    it('is refused on the lead update with "Please give a reason." and writes nothing', async () => {
      const f = await setup();
      const before = await outcome(f);

      for (const body of [{}, { lost_reason: '' }, { lost_reason: '   ' }]) {
        const res = await DOORS['the lead update']!(f, body);
        expect(res.status).toBe(400);
        expect(res.body.error).toBe('Please give a reason.');
      }

      expect(await outcome(f)).toEqual(before);
    });

    it('is refused on Mark lost too', async () => {
      const f = await setup();
      const before = await outcome(f);

      const res = await DOORS['Mark lost']!(f, {});

      expect(res.status).toBe(400);
      expect(await outcome(f)).toEqual(before);
    });
  });

  it("the lead update leaves the lead exactly as Mark lost does (same fields, same walkthrough, estimate, deposit and History)", async () => {
    const viaMarkLost = await setup();
    const viaUpdate = await setup();

    expect((await DOORS['Mark lost']!(viaMarkLost)).status).toBe(200);
    expect((await DOORS['the lead update']!(viaUpdate)).status).toBe(200);

    expect(await outcome(viaUpdate)).toEqual(await outcome(viaMarkLost));
  });

  it('the lead update saves the other fields of the request as well', async () => {
    const f = await setup();

    const res = await (await f.api()).patch(`/api/leads/${f.lead.id}`, { status: 'LOST', lost_reason: REASON, notes: 'Called back twice' });

    expect(res.status).toBe(200);
    const lead = await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } });
    expect(lead).toMatchObject({ status: 'LOST', lost_reason: REASON, notes: 'Called back twice' });
  });

  it('the lead update takes a reason only with a move to Lost', async () => {
    const f = await setup();

    const res = await (await f.api()).patch(`/api/leads/${f.lead.id}`, { status: 'ESTIMATED', lost_reason: REASON });

    expect(res.status).toBe(400);
    expect((await db.lead.findUniqueOrThrow({ where: { id: f.lead.id } })).status).toBe('WALKTHROUGH_SCHEDULED');
  });

  it('a lead already Lost is refused a second close on the lead update, as Mark lost refuses it', async () => {
    const f = await setup();
    expect((await DOORS['the lead update']!(f)).status).toBe(200);
    const closed = await outcome(f);

    const again = await DOORS['the lead update']!(f, { lost_reason: 'Something else' });

    expect(again.status).toBe(400);
    expect(await outcome(f)).toEqual(closed);
  });

  describe('an automation reminder anchored to the lead', () => {
    it('stops with "Lead was marked as lost" once the lead is closed through the lead update', async () => {
      const { loadExecutionBundle } = await import('../services/automations/context.js');
      const { terminalStaleReason } = await import('../services/automations/terminalStale.js');
      const f = await setup();
      const stateOf = async () => {
        const loaded = await loadExecutionBundle({ entityType: 'lead', entityId: f.lead.id, organizationId: f.org, dedupeKey: `lead-lost-${f.tag}` });
        return loaded!.state;
      };
      const reason = async () => terminalStaleReason('LEAD_DATE_ANCHORED', undefined, await stateOf(), new Date(), 'after');

      expect(await reason()).not.toBe('Lead was marked as lost');
      expect((await DOORS['the lead update']!(f)).status).toBe(200);

      expect(await reason()).toBe('Lead was marked as lost');
    });
  });
});
