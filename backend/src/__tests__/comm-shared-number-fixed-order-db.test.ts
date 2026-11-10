/* =============================================================================
   #3015 (parent #3013, decision 1): a shared number picks one customer by a fixed order.

   Wherever ServWave must pick ONE customer for a phone number (an incoming call, a text conversation's default customer), it
   uses a fixed order instead of "any row with this number":
     1. the one lead or job carrying the number as its own;
     2. the customer with the newest open lead or job;
     3. the newest active customer.
   Archived customers come last. Open, in steps 1 and 2 (Ran, 2026-11-05): a lead until it is converted or lost, a job until
   it is done or cancelled. The same data gives the same answer every time, and a number on 47 customers is answered by
   one query. A call is filed once, by the event that creates it: a later event of the same call (its end, or a start that
   comes in late) never moves it to another customer, lead or job, and a call placed from a record stays on it throughout.

   Drives the identity match's public entry (`matchByPhone`), and an incoming call through the phone service webhook route, on a
   real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. The phone service is never reached: the only
   thing standing in for it is the webhook body it would send. Every org it creates is removed.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomBytes, randomUUID } from 'crypto';
import type { JobStatus, LeadStatus, PrismaClient } from '@prisma/client';

// One real client for the app and the test. Built with the query event log, so the queries one match sends can be counted.
const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } }, log: [{ emit: 'event', level: 'query' }] }) };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// The suite-wide setup replaces the phone service's client; here the real one runs, so a request it made would reach the
// network edge faked below.
vi.unmock('../lib/ctm/client');

import { switchFixture } from './permission-switches-fixture';
import { matchByPhone } from '../lib/comms-identity';
import { countQueries } from './support/query-counter';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

suite('a shared number picks one customer by a fixed order (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM notification_recipients WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM notifications WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM pending_call_attributions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM messages WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM message_threads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM ctm_events WHERE ctm_event_id LIKE 'CA-3015-%' OR ctm_event_id LIKE 'MSG-3015-%'`));
    await fx.cleanup();
  });

  let sequence = 0;
  const DAY = 24 * 60 * 60 * 1000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

  /**
   * A number of its own per case, stored the way the customer form stores one (ten digits). Placeholders in the 555-01xx range
   * only, (555) 010-0100 up to (555) 010-0199, each handed out once per run; every case has its own company, so a number never
   * meets the same number from an earlier run.
   */
  let numbersUsed = 0;
  const freshNumber = () => {
    if (numbersUsed > 99) throw new Error('this suite has used every placeholder number in (555) 010-0100..0199');
    return `5550100${100 + numbersUsed++}`;
  };

  async function customer(org: string, name: string, opts: { phone?: string; createdDaysAgo: number; archived?: boolean }) {
    const id = randomUUID();
    await db.customer.create({
      data: {
        id, organization_id: org, customer_number: `C-${++sequence}-${id.slice(0, 6)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
        first_name: name, last_name: 'Shared', phone: opts.phone ?? null, created_at: daysAgo(opts.createdDaysAgo),
        ...(opts.archived ? { is_active: false, archived_at: daysAgo(1) } : {}),
      },
    });
    return id;
  }

  async function lead(org: string, customerId: string, opts: { createdDaysAgo: number; status?: LeadStatus; ownPhone?: string }) {
    const id = randomUUID();
    await db.lead.create({
      data: {
        id, organization_id: org, customer_id: customerId, lead_number: `L-${id.slice(0, 8)}`, service_request: 'Fix the door',
        status: opts.status ?? 'NEW', created_at: daysAgo(opts.createdDaysAgo),
      },
    });
    if (opts.ownPhone) {
      await db.recordContactEntry.create({
        data: { organization_id: org, lead_id: id, kind: 'PHONE', intent: 'ADDED', value: opts.ownPhone },
      });
    }
    return id;
  }

  async function job(org: string, customerId: string, opts: { createdDaysAgo: number; status?: JobStatus; ownPhone?: string }) {
    const made = await fx.addJob(org, customerId, { status: opts.status ?? 'SCHEDULED' });
    await db.job.update({ where: { id: made.id }, data: { created_at: daysAgo(opts.createdDaysAgo) } });
    if (opts.ownPhone) {
      await db.recordContactEntry.create({
        data: { organization_id: org, job_id: made.id, kind: 'PHONE', intent: 'ADDED', value: opts.ownPhone },
      });
    }
    return made.id;
  }

  it('picks the newer customer with an open lead over the older one with no open work', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
    const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
    await lead(org, newer, { createdDaysAgo: 2 });
    // Another company with the same number and newer open work is never considered.
    const { org: otherOrg } = await fx.newOrg();
    const elsewhere = await customer(otherOrg, 'Elsewhere', { phone: number, createdDaysAgo: 1 });
    await lead(otherOrg, elsewhere, { createdDaysAgo: 0 });

    const match = await matchByPhone(db, org, `+1${number}`);

    expect(match).toMatchObject({ kind: 'customer', customerId: newer, label: 'Newer Shared' });
  });

  it('a lead carrying the number as its own wins over both customers that carry it', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
    const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
    await lead(org, newer, { createdDaysAgo: 0 });
    // The lead's customer does not carry the number: only the lead does, as its own.
    const third = await customer(org, 'Third', { createdDaysAgo: 400 });
    await lead(org, third, { createdDaysAgo: 60, ownPhone: number });

    const match = await matchByPhone(db, org, `+1${number}`);

    // The lead's customer is picked. The match itself ties no lead (texts keep their ties until #3020); the incoming call
    // is filed on the lead itself, below.
    expect(match).toMatchObject({ kind: 'customer', customerId: third, leadId: null });
  });

  it('a lost lead carrying the number as its own does not win: the customer with an open lead from yesterday does', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const open = await customer(org, 'Open', { phone: number, createdDaysAgo: 30 });
    await lead(org, open, { createdDaysAgo: 1 });
    const lostOne = await customer(org, 'Lost', { createdDaysAgo: 400 });
    await lead(org, lostOne, { createdDaysAgo: 60, status: 'LOST', ownPhone: number });

    expect((await matchByPhone(db, org, number))?.customerId).toBe(open);
  });

  it('beside a lost lead carrying the number, an open lead carrying it is still the one record that does, and wins', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const carrier = await customer(org, 'Carrier', { phone: number, createdDaysAgo: 30 });
    await lead(org, carrier, { createdDaysAgo: 1 });
    const lostOne = await customer(org, 'Lost', { createdDaysAgo: 500 });
    await lead(org, lostOne, { createdDaysAgo: 20, status: 'LOST', ownPhone: number });
    const ownOne = await customer(org, 'Own', { createdDaysAgo: 400 });
    await lead(org, ownOne, { createdDaysAgo: 60, ownPhone: number });

    expect((await matchByPhone(db, org, number))?.customerId).toBe(ownOne);
  });

  it('a completed job is still open work: its customer wins over one whose open lead is older', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const leadOnly = await customer(org, 'Lead', { phone: number, createdDaysAgo: 30 });
    await lead(org, leadOnly, { createdDaysAgo: 3 });
    // Completed, Office review and Ready to close come before Done: the job is open until it is done or cancelled.
    const completed = await customer(org, 'Completed', { phone: number, createdDaysAgo: 400 });
    await job(org, completed, { createdDaysAgo: 1, status: 'COMPLETED' });

    expect((await matchByPhone(db, org, number))?.customerId).toBe(completed);
  });

  it('another company with the same number and a stronger candidate is never picked, wherever it keeps the number', async () => {
    const { org } = await fx.newOrg();
    const { org: otherOrg } = await fx.newOrg();
    // Each case: our company has one old customer with the number and no open work; the other company has a newer one,
    // keeping the number in one of the four places the pick reads.
    const places = ['phone', 'second phone', 'phone list', 'a lead\'s own number'] as const;
    for (const place of places) {
      const number = freshNumber();
      const ours = await customer(org, 'Ours', { phone: number, createdDaysAgo: 900 });
      const theirs = await customer(otherOrg, 'Theirs', { phone: place === 'phone' ? number : undefined, createdDaysAgo: 1 });
      if (place === 'second phone') await db.customer.update({ where: { id: theirs }, data: { secondary_phone: number } });
      if (place === 'phone list') await db.customerPhone.create({ data: { customer_id: theirs, phone: number } });
      await lead(otherOrg, theirs, { createdDaysAgo: 0, ownPhone: place === 'a lead\'s own number' ? number : undefined });

      expect({ place, picked: (await matchByPhone(db, org, number))?.customerId }).toEqual({ place, picked: ours });
    }
  });

  it('a lead\'s own number counts once it is carried onto the job made from it, while the lead is still open: one record', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
    await lead(org, newer, { createdDaysAgo: 0 });
    const third = await customer(org, 'Third', { createdDaysAgo: 400 });
    // Both the lead and its job are open, so each would count as a record carrying the number if the carried entry did.
    const openLead = await lead(org, third, { createdDaysAgo: 90, ownPhone: number });
    const fromLead = await job(org, third, { createdDaysAgo: 80 });
    const leadEntry = await db.recordContactEntry.findFirstOrThrow({ where: { lead_id: openLead }, select: { id: true } });
    await db.recordContactEntry.create({
      data: { organization_id: org, job_id: fromLead, kind: 'PHONE', intent: 'ADDED', value: number, source_entry_id: leadEntry.id },
    });

    expect((await matchByPhone(db, org, number))?.customerId).toBe(third);
  });

  it('a lead holding the number in two of its own entries is still the one record carrying it, and wins', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const carrier = await customer(org, 'Carrier', { phone: number, createdDaysAgo: 30 });
    await lead(org, carrier, { createdDaysAgo: 1 });
    const third = await customer(org, 'Third', { createdDaysAgo: 400 });
    // The same number entered twice on one lead, once as ten digits and once with its country code.
    const twice = await lead(org, third, { createdDaysAgo: 60, ownPhone: number });
    await db.recordContactEntry.create({ data: { organization_id: org, lead_id: twice, kind: 'PHONE', intent: 'ADDED', value: `+1${number}` } });

    expect((await matchByPhone(db, org, number))?.customerId).toBe(third);
  });

  it('two records carrying the number as their own leave the pick to the newest open work, and a removed one counts for nothing', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const older = await customer(org, 'Older', { createdDaysAgo: 900 });
    await lead(org, older, { createdDaysAgo: 40, ownPhone: number });
    const newer = await customer(org, 'Newer', { createdDaysAgo: 800 });
    await lead(org, newer, { createdDaysAgo: 10, ownPhone: number });
    const carrier = await customer(org, 'Carrier', { phone: number, createdDaysAgo: 700 });
    await lead(org, carrier, { createdDaysAgo: 1 });
    // Two own records: neither is "the one", so the newest open work decides, and that is the customer carrying it.
    expect((await matchByPhone(db, org, number))?.customerId).toBe(carrier);

    // The newer one's entry is removed: the older lead is now the one record carrying the number, and it wins.
    await db.recordContactEntry.updateMany({ where: { lead: { customer_id: newer } }, data: { removed_at: new Date() } });
    expect((await matchByPhone(db, org, number))?.customerId).toBe(older);
  });

  it('a customer marked inactive counts as archived, even with no archive date', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const inactive = await customer(org, 'Inactive', { phone: number, createdDaysAgo: 10 });
    await db.customer.update({ where: { id: inactive }, data: { is_active: false } });
    await lead(org, inactive, { createdDaysAgo: 1 });
    const active = await customer(org, 'Active', { phone: number, createdDaysAgo: 900 });

    expect((await matchByPhone(db, org, number))?.customerId).toBe(active);
  });

  it('an archived customer is picked only when no active one carries the number', async () => {
    const { org } = await fx.newOrg();
    const shared = freshNumber();
    // The archived one is newer, has open work, and is entered first: it still loses to the active one.
    const archived = await customer(org, 'Archived', { phone: shared, createdDaysAgo: 10, archived: true });
    const active = await customer(org, 'Active', { phone: shared, createdDaysAgo: 900 });
    await lead(org, archived, { createdDaysAgo: 1 });
    const onlyArchivedNumber = freshNumber();
    const alone = await customer(org, 'Alone', { phone: onlyArchivedNumber, createdDaysAgo: 50, archived: true });

    expect((await matchByPhone(db, org, shared))?.customerId).toBe(active);
    expect((await matchByPhone(db, org, onlyArchivedNumber))?.customerId).toBe(alone);
  });

  it('the same answer comes back every time for the same data, whatever order it was entered in', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    // Two customers alike in everything the order looks at: same number, same moment, no open work.
    const twins = [randomUUID(), randomUUID()];
    const sameDay = daysAgo(100);
    const enter = async (ids: string[]) => {
      for (const id of ids) {
        await db.customer.create({
          data: {
            id, organization_id: org, customer_number: `C-twin-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
            first_name: 'Twin', last_name: 'Shared', phone: number, created_at: sameDay,
          },
        });
      }
    };
    const ask = async () => (await matchByPhone(db, org, number))?.customerId;

    await enter(twins);
    const first = [await ask(), await ask()];
    // The very same two rows again, entered the other way round.
    await db.customer.deleteMany({ where: { id: { in: twins } } });
    await enter([...twins].reverse());
    const second = [await ask(), await ask()];

    expect(twins).toContain(first[0]);
    expect([...first, ...second]).toEqual([first[0], first[0], first[0], first[0]]);
  });

  it('a number on 47 customers is answered by one query, not one per customer', async () => {
    const { org } = await fx.newOrg();
    const number = freshNumber();
    const ids: string[] = [];
    for (let i = 1; i <= 47; i++) {
      // The number sits in each of the three places a customer keeps one: the phone, the second phone, the phone list.
      const place = i % 3;
      const id = await customer(org, `Sharer${i}`, { phone: place === 0 ? number : undefined, createdDaysAgo: 500 - i });
      if (place === 1) await db.customer.update({ where: { id }, data: { secondary_phone: number } });
      if (place === 2) await db.customerPhone.create({ data: { customer_id: id, phone: number } });
      ids.push(id);
    }
    // Customer 14 (number in the phone list) has the newest OPEN work: a job from 3 days ago.
    await job(org, ids[13]!, { createdDaysAgo: 3 });
    await lead(org, ids[39]!, { createdDaysAgo: 20 });
    // Newer work that is closed does not count: a done job and a lost lead on the newest customer.
    await job(org, ids[46]!, { createdDaysAgo: 1, status: 'DONE' });
    await lead(org, ids[46]!, { createdDaysAgo: 1, status: 'LOST' });

    const { result, queries } = await countQueries(() => matchByPhone(db, org, `(${number.slice(0, 3)}) ${number.slice(3, 6)}-${number.slice(6)}`), db);

    expect(result?.customerId).toBe(ids[13]);
    expect(queries).toHaveLength(1);
  });

  describe('an incoming call through the phone service webhook', () => {
    const token = randomBytes(24).toString('hex');
    const providerCalls: string[] = [];
    // The phone service's address in this suite. Nothing outside it may be reached.
    const PROVIDER = 'https://phone-provider.test/api/v1';
    const settings = env as Record<string, unknown>;
    const before = {
      CTM_WEBHOOK_TOKEN: settings.CTM_WEBHOOK_TOKEN, CTM_ACCESS_KEY: settings.CTM_ACCESS_KEY,
      CTM_SECRET_KEY: settings.CTM_SECRET_KEY, CTM_API_BASE: settings.CTM_API_BASE,
    };
    beforeAll(async () => {
      await fx.listener();
      // A connected phone service, so its client would really send a request. The route is closed while no token is set; this
      // run's token and keys are made up here, never stored.
      Object.assign(settings, {
        CTM_WEBHOOK_TOKEN: token, CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER,
      });
      // The phone service's network edge: any request to it is recorded, and none is expected. Any other address throws.
      vi.stubGlobal('fetch', async (input: Parameters<typeof fetch>[0]) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (!url.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${url}`);
        providerCalls.push(url);
        return new Response('{}', { status: 200 });
      });
    }, 120_000);
    afterAll(() => {
      vi.unstubAllGlobals();
      Object.assign(settings, before);
    });

    /** A company on the phone service, with its main line stored, so the webhook finds it and its number. */
    async function companyOnPhoneService() {
      const { org, tag, admin } = await fx.newOrg();
      orgs.push(org);
      const account = `3015${tag}`;
      await db.organization.update({ where: { id: org }, data: { ctm_account_id: account } });
      const ours = `+1${freshNumber()}`;
      await db.phoneNumber.create({ data: { organization_id: org, e164: ours, label: 'Main line', is_org_default: true, status: 'active' } });
      return { org, admin, account, ours };
    }

    /** A finished incoming call from `number`, posted to the webhook route the way the phone service posts it. Returns the call row. */
    async function callIn(company: { org: string; account: string; ours: string }, number: string) {
      const sid = `CA-3015-${randomUUID().slice(0, 12)}`;
      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/end?token=${token}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({
          sid, account_id: company.account, caller_number: `+1${number}`, tracking_number: company.ours, direction: 'inbound',
          call_status: 'completed', dial_status: 'completed', talk_time: 42, duration: 45, unix_time: Math.floor(Date.now() / 1000),
        }));
      expect(res.status).toBe(200);
      return db.callSession.findFirst({
        where: { organization_id: company.org, ctm_call_id: sid },
        select: { customer_id: true, lead_id: true, job_id: true, job_label: true },
      });
    }

    it('two customers share a number; the older has no open work, the newer has an open lead: the call files on the newer', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 2 });

      const call = await callIn(company, number);

      expect(call?.customer_id).toBe(newer);
      expect(providerCalls).toEqual([]);
    });

    it('a job carrying the number as its own wins over both customers: the call files on that job and its customer', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 0 });
      const third = await customer(org, 'Third', { createdDaysAgo: 400 });
      const ownJob = await job(org, third, { createdDaysAgo: 60, ownPhone: number });
      const jobNumber = (await db.job.findUniqueOrThrow({ where: { id: ownJob }, select: { job_number: true } })).job_number;

      const call = await callIn(company, number);

      expect(call).toEqual({ customer_id: third, lead_id: null, job_id: ownJob, job_label: jobNumber });
      expect(providerCalls).toEqual([]);
    });

    it('a lead carrying the number as its own wins over both customers: the call files on that lead and its customer', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 0 });
      const third = await customer(org, 'Third', { createdDaysAgo: 400 });
      const ownLead = await lead(org, third, { createdDaysAgo: 60, ownPhone: number });

      const call = await callIn(company, number);

      expect(call).toEqual({ customer_id: third, lead_id: ownLead, job_id: null, job_label: null });
    });

    it('a done job carrying the number as its own does not take the call: it files on the customer with open work', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const open = await customer(org, 'Open', { phone: number, createdDaysAgo: 30 });
      await lead(org, open, { createdDaysAgo: 1 });
      const doneOne = await customer(org, 'Done', { createdDaysAgo: 400 });
      await job(org, doneOne, { createdDaysAgo: 60, status: 'DONE', ownPhone: number });

      const call = await callIn(company, number);

      expect(call).toEqual({ customer_id: open, lead_id: null, job_id: null, job_label: null });
    });

    it('a completed job carrying the number as its own is still open: the call files on that job and its customer', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 0 });
      const third = await customer(org, 'Third', { createdDaysAgo: 400 });
      const completedJob = await job(org, third, { createdDaysAgo: 60, status: 'COMPLETED', ownPhone: number });
      const jobNumber = (await db.job.findUniqueOrThrow({ where: { id: completedJob }, select: { job_number: true } })).job_number;

      const call = await callIn(company, number);

      expect(call).toEqual({ customer_id: third, lead_id: null, job_id: completedJob, job_label: jobNumber });
    });

    type Company = { org: string; admin: { id: string; email: string }; account: string; ours: string };
    type Filing = { customer_id: string | null; lead_id: string | null; job_id: string | null; job_label: string | null };

    /** One event of a call, posted to the webhook route the way the phone service posts it. Returns the call row's filing. */
    async function post(company: Company, position: 'starts' | 'end', event: Record<string, unknown>): Promise<Filing | null> {
      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/${position}?token=${token}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({ account_id: company.account, tracking_number: company.ours, unix_time: Math.floor(Date.now() / 1000), ...event }));
      expect(res.status).toBe(200);
      return db.callSession.findFirst({
        where: { organization_id: company.org, ctm_call_id: String(event.sid) },
        select: { customer_id: true, lead_id: true, job_id: true, job_label: true },
      });
    }

    const newSid = () => `CA-3015-${randomUUID().slice(0, 12)}`;
    /** What the phone service reports while a call rings, and once it is over (with its transcript and summary). */
    const RINGING = { call_status: 'in-progress' };
    const ENDED = {
      call_status: 'completed', dial_status: 'completed', talk_time: 42, duration: 45,
      transcription_text: 'Caller: Hi, about the door. Agent: Sure.', summary: 'Asked about the door.',
    };
    const outbound = (company: Company, sid: string, number: string) =>
      ({ sid, caller_number: company.ours, called_number: `+1${number}`, direction: 'outbound' });
    const inbound = (sid: string, number: string) => ({ sid, caller_number: `+1${number}`, direction: 'inbound' });

    /** ServWave stores the record a call is placed from (the click-to-call stash) right before it dials. */
    async function placeFrom(company: Company, number: string, from: { customerId: string; leadId?: string; job?: { id: string; jobNumber: string } }) {
      await db.pendingCallAttribution.create({
        data: {
          organization_id: company.org, to_number: `+1${number}`, customer_id: from.customerId, lead_id: from.leadId ?? null,
          job_id: from.job?.id ?? null, job_label: from.job?.jobNumber ?? null, requested_by: company.admin.id,
        },
      });
    }

    const jobNumberOf = async (id: string) => (await db.job.findUniqueOrThrow({ where: { id }, select: { job_number: true } })).job_number;

    it('a call placed from a lead stays on that lead and its customer at every event, though another customer\'s lead carries the number as its own', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const x = await lead(org, a, { createdDaysAgo: 5 });
      const b = await customer(org, 'Other', { createdDaysAgo: 50 });
      await lead(org, b, { createdDaysAgo: 3, ownPhone: number });
      const placedOnX = { customer_id: a, lead_id: x, job_id: null, job_label: null };

      await placeFrom(company, number, { customerId: a, leadId: x });
      const sid = newSid();
      const atStart = await post(company, 'starts', { ...outbound(company, sid, number), ...RINGING });
      const atEnd = await post(company, 'end', { ...outbound(company, sid, number), ...ENDED });

      expect({ atStart, atEnd }).toEqual({ atStart: placedOnX, atEnd: placedOnX });
    });

    it('a call placed from a job stays on that job and its customer at every event, and never takes the lead another customer\'s lead carries', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const j = await job(org, a, { createdDaysAgo: 5 });
      const jobNumber = await jobNumberOf(j);
      const b = await customer(org, 'Other', { createdDaysAgo: 50 });
      await lead(org, b, { createdDaysAgo: 3, ownPhone: number });
      const placedOnJ = { customer_id: a, lead_id: null, job_id: j, job_label: jobNumber };

      await placeFrom(company, number, { customerId: a, job: { id: j, jobNumber } });
      const sid = newSid();
      const atStart = await post(company, 'starts', { ...outbound(company, sid, number), ...RINGING });
      const atEnd = await post(company, 'end', { ...outbound(company, sid, number), ...ENDED });

      expect({ atStart, atEnd }).toEqual({ atStart: placedOnJ, atEnd: placedOnJ });
    });

    it('a placed call whose start never arrives, or arrives after its end, stays on the lead or job it was placed from', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const x = await lead(org, a, { createdDaysAgo: 5 });
      const j = await job(org, a, { createdDaysAgo: 4 });
      const jobNumber = await jobNumberOf(j);
      const b = await customer(org, 'Other', { createdDaysAgo: 50 });
      await lead(org, b, { createdDaysAgo: 3, ownPhone: number });

      await placeFrom(company, number, { customerId: a, leadId: x });
      const fromLead = newSid();
      const leadAtEnd = await post(company, 'end', { ...outbound(company, fromLead, number), ...ENDED });
      const leadAtLateStart = await post(company, 'starts', { ...outbound(company, fromLead, number), ...RINGING });

      await placeFrom(company, number, { customerId: a, job: { id: j, jobNumber } });
      const fromJob = newSid();
      const jobAtEnd = await post(company, 'end', { ...outbound(company, fromJob, number), ...ENDED });
      const jobAtLateStart = await post(company, 'starts', { ...outbound(company, fromJob, number), ...RINGING });

      const onX = { customer_id: a, lead_id: x, job_id: null, job_label: null };
      const onJ = { customer_id: a, lead_id: null, job_id: j, job_label: jobNumber };
      expect({ leadAtEnd, leadAtLateStart, jobAtEnd, jobAtLateStart }).toEqual({
        leadAtEnd: onX, leadAtLateStart: onX, jobAtEnd: onJ, jobAtLateStart: onJ,
      });
    });

    it('a placed call whose start and end come in at the same moment stays on the lead it was placed from, every time', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const x = await lead(org, a, { createdDaysAgo: 5 });
      const b = await customer(org, 'Other', { createdDaysAgo: 50 });
      await lead(org, b, { createdDaysAgo: 3, ownPhone: number });

      const filings: Array<Filing | null> = [];
      for (let run = 0; run < 16; run++) {
        await placeFrom(company, number, { customerId: a, leadId: x });
        const sid = newSid();
        // The phone service delivers both events of the call together (a call that fails at once, or a retry backlog).
        await Promise.all([
          post(company, 'starts', { ...outbound(company, sid, number), ...RINGING }),
          post(company, 'end', { ...outbound(company, sid, number), ...ENDED }),
        ]);
        filings.push(await db.callSession.findFirst({
          where: { organization_id: org, ctm_call_id: sid },
          select: { customer_id: true, lead_id: true, job_id: true, job_label: true },
        }));
      }

      expect(filings).toEqual(Array(16).fill({ customer_id: a, lead_id: x, job_id: null, job_label: null }));
    });

    it('a late start of one placed call does not take the record the next call to the number is placed from', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const first = await lead(org, a, { createdDaysAgo: 9 });
      const second = await lead(org, a, { createdDaysAgo: 2 });

      await placeFrom(company, number, { customerId: a, leadId: first });
      const firstCall = newSid();
      await post(company, 'end', { ...outbound(company, firstCall, number), ...ENDED });
      // The next call is placed from the other lead before the first call's start event has come in.
      await placeFrom(company, number, { customerId: a, leadId: second });
      await post(company, 'starts', { ...outbound(company, firstCall, number), ...RINGING });
      const secondCall = newSid();
      const next = await post(company, 'starts', { ...outbound(company, secondCall, number), ...RINGING });

      expect(next).toEqual({ customer_id: a, lead_id: second, job_id: null, job_label: null });
    });

    /** The placer, as the phone service names the agent leg once it is connected (it may be missing while the call rings). */
    const placedBy = (company: Company) => ({ agent: { id: 'agent-3015', name: 'Test Admin', email: company.admin.email } });

    it('a call filed at its start on the customer it was placed from keeps it at its end, and leaves the next call placed to the number its own lead', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const x = await lead(org, a, { createdDaysAgo: 5 });

      // The first call is placed from the customer's page; while it is on, a second call to the number is placed from the lead.
      await placeFrom(company, number, { customerId: a });
      const firstCall = newSid();
      const firstAtStart = await post(company, 'starts', { ...outbound(company, firstCall, number), ...RINGING });
      await placeFrom(company, number, { customerId: a, leadId: x });
      const firstAtEnd = await post(company, 'end', { ...outbound(company, firstCall, number), ...ENDED, ...placedBy(company) });
      const secondCall = newSid();
      const secondAtStart = await post(company, 'starts', { ...outbound(company, secondCall, number), ...RINGING });

      const onA = { customer_id: a, lead_id: null, job_id: null, job_label: null };
      expect({ firstAtStart, firstAtEnd, secondAtStart }).toEqual({
        firstAtStart: onA, firstAtEnd: onA, secondAtStart: { customer_id: a, lead_id: x, job_id: null, job_label: null },
      });
    });

    it('a call filed at its start on the lead it was placed from is not moved by another record\'s stash found at its end', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const a = await customer(org, 'Placed', { phone: number, createdDaysAgo: 100 });
      const x = await lead(org, a, { createdDaysAgo: 5 });
      const c = await customer(org, 'Elsewhere', { createdDaysAgo: 40 });
      const z = await job(org, c, { createdDaysAgo: 2 });
      const zNumber = await jobNumberOf(z);

      await placeFrom(company, number, { customerId: a, leadId: x });
      const sid = newSid();
      const atStart = await post(company, 'starts', { ...outbound(company, sid, number), ...RINGING });
      // Another call to the number is placed from a job of another customer before this one ends.
      await placeFrom(company, number, { customerId: c, job: { id: z, jobNumber: zNumber } });
      const atEnd = await post(company, 'end', { ...outbound(company, sid, number), ...ENDED, ...placedBy(company) });

      const onX = { customer_id: a, lead_id: x, job_id: null, job_label: null };
      expect({ atStart, atEnd }).toEqual({ atStart: onX, atEnd: onX });
    });

    it('an incoming call on a shared number is filed once by the fixed order: its end leaves it there though the data changed meanwhile', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 2 });
      const onNewer = { customer_id: newer, lead_id: null, job_id: null, job_label: null };

      const sid = newSid();
      const atStart = await post(company, 'starts', { ...inbound(sid, number), ...RINGING });
      // While the call is on, another customer's lead takes the number as its own: a new call would now be filed there.
      const third = await customer(org, 'Third', { createdDaysAgo: 400 });
      await lead(org, third, { createdDaysAgo: 60, ownPhone: number });
      expect((await matchByPhone(db, org, number))?.customerId).toBe(third);
      const atEnd = await post(company, 'end', { ...inbound(sid, number), ...ENDED });

      expect({ atStart, atEnd }).toEqual({ atStart: onNewer, atEnd: onNewer });
    });

    it('the missed-call alert names the customer the call is filed on, though the data changed while it rang', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      await customer(org, 'Older', { phone: number, createdDaysAgo: 900 });
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 2 });

      const sid = newSid();
      await post(company, 'starts', { ...inbound(sid, number), ...RINGING });
      const third = await customer(org, 'Third', { createdDaysAgo: 400 });
      await lead(org, third, { createdDaysAgo: 60, ownPhone: number });
      expect((await matchByPhone(db, org, number))?.customerId).toBe(third);
      const atEnd = await post(company, 'end', { ...inbound(sid, number), call_status: 'no-answer', dial_status: 'no-answer', talk_time: 0, duration: 20 });

      const call = await db.callSession.findFirstOrThrow({ where: { organization_id: org, ctm_call_id: sid }, select: { id: true } });
      // The alert is raised after the phone service has its answer, so it is waited for.
      const alert = await vi.waitFor(async () => {
        const found = await db.notification.findFirst({
          where: { organization_id: org, verb: 'communication.call_missed', object_id: call.id }, select: { title: true },
        });
        if (!found) throw new Error('no missed-call alert yet');
        return found;
      }, { timeout: 10_000, interval: 100 });
      expect({ filedOn: atEnd?.customer_id, title: alert.title }).toEqual({ filedOn: newer, title: 'Missed call — Newer Shared' });
    });

    it('an incoming call filed on the lead carrying the number stays on it at its end, though that lead was lost meanwhile', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      const newer = await customer(org, 'Newer', { phone: number, createdDaysAgo: 30 });
      await lead(org, newer, { createdDaysAgo: 0 });
      const third = await customer(org, 'Third', { createdDaysAgo: 400 });
      const ownLead = await lead(org, third, { createdDaysAgo: 60, ownPhone: number });
      const onOwnLead = { customer_id: third, lead_id: ownLead, job_id: null, job_label: null };

      const sid = newSid();
      const atStart = await post(company, 'starts', { ...inbound(sid, number), ...RINGING });
      await db.lead.update({ where: { id: ownLead }, data: { status: 'LOST' } });
      expect((await matchByPhone(db, org, number))?.customerId).toBe(newer);
      const atEnd = await post(company, 'end', { ...inbound(sid, number), ...ENDED });

      expect({ atStart, atEnd }).toEqual({ atStart: onOwnLead, atEnd: onOwnLead });
    });

    it('an incoming call from a number nobody carried when it rang is filed at its end on the customer who carries it by then', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();

      const sid = newSid();
      const atStart = await post(company, 'starts', { ...inbound(sid, number), ...RINGING });
      const added = await customer(org, 'Added', { phone: number, createdDaysAgo: 0 });
      const atEnd = await post(company, 'end', { ...inbound(sid, number), ...ENDED });

      expect({ atStart, atEnd }).toEqual({
        atStart: { customer_id: null, lead_id: null, job_id: null, job_label: null },
        atEnd: { customer_id: added, lead_id: null, job_id: null, job_label: null },
      });
    });

    it('a text sent to the number neither ties to nor moves the lead that carries the number as its own (that tie is #3020)', async () => {
      const company = await companyOnPhoneService();
      const { org } = company;
      const number = freshNumber();
      await customer(org, 'Texted', { phone: number, createdDaysAgo: 100 });
      const b = await customer(org, 'Other', { createdDaysAgo: 50 });
      const y = await lead(org, b, { createdDaysAgo: 3, ownPhone: number });

      const messageId = `MSG-3015-${randomUUID().slice(0, 12)}`;
      const res = await request(await fx.listener())
        .post(`/api/webhooks/ctm/outbound_text?token=${token}`)
        .set('Content-Type', 'application/json')
        .send(JSON.stringify({
          message_id: messageId, account_id: company.account, caller_number: company.ours, tracking_number: company.ours,
          called_number: `+1${number}`, direction: 'msg_outbound', message_body: 'On our way', unix_time: Math.floor(Date.now() / 1000),
        }));

      expect(res.status).toBe(200);
      const text = await db.message.findFirst({ where: { organization_id: org, ctm_sms_id: messageId }, select: { lead_id: true } });
      expect(text).toEqual({ lead_id: null });
      expect((await db.lead.findUniqueOrThrow({ where: { id: y }, select: { status: true } })).status).toBe('NEW');
    });
  });
});
