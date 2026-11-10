/* =============================================================================
   #3014 - the fill-in of the other party's number on texts stored before texts recorded it
   (scripts/text-other-party-number-fill-in.ts).

   Real migrated database (TEST_DATABASE_URL; skips when unset). The script's public entry is run on a seeded company, the way a
   person runs it: a dry run prints the counts and writes nothing; a run with --confirm fills every text whose stored phone-system
   event names the number, then the rest from the conversation's customer phone or title, and leaves the rest empty; a second
   run changes nothing; a company that is not named is left alone. A stored event is read with the text's own direction, must
   come from the company's phone-system account, and never fills a text with one of the company's own numbers; a run with a
   company that is not an id is refused.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';
import { runFillIn } from '../text-other-party-number-fill-in';

const { realClient } = (() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) as PrismaClient };
})();

const suite = realClient ? describe : describe.skip;

suite('the other-party number fill-in (real database)', () => {
  const db = realClient as PrismaClient;
  const orgs: string[] = [];
  const eventKeys: string[] = [];

  async function seedOrg() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `fill-${tag}`, email: `fill-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', ctm_account_id: `fill${tag}`,
      },
    });
    return { org, tag, account: `fill${tag}` };
  }

  async function customer(org: string, phone: string | null) {
    const id = randomUUID();
    await db.customer.create({
      data: { id, organization_id: org, customer_number: `C-${id.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Lee', phone },
    });
    return id;
  }

  async function thread(org: string, data: { customer_id?: string; title?: string; kind?: string; user_id?: string }) {
    const t = await db.messageThread.create({ data: { organization_id: org, channel: 'sms', campaign_type: 'customer_care', ...data } });
    return t.id;
  }

  async function text(org: string, threadId: string, direction: 'in' | 'out', opts: { sid?: string; otherParty?: string } = {}) {
    const m = await db.message.create({
      data: {
        organization_id: org, thread_id: threadId, direction, body: 'run-fill', ts: new Date(), status: direction === 'in' ? 'received' : 'sent',
        ctm_sms_id: opts.sid ?? null, other_party_e164: opts.otherParty ?? null,
      },
    });
    return m.id;
  }

  /** The phone system's event, stored the way the webhook stores it (keyed by its own id and the hook it arrived on). */
  async function storedEvent(key: string, position: string, payload: Record<string, unknown>) {
    eventKeys.push(key);
    await db.ctmEvent.create({ data: { ctm_event_id: key, event_type: position, payload: payload as object } });
  }

  const numberOf = async (id: string) =>
    (await db.message.findUniqueOrThrow({ where: { id }, select: { other_party_e164: true } })).other_party_e164;

  let A: Awaited<ReturnType<typeof seedOrg>>;
  let B: Awaited<ReturnType<typeof seedOrg>>;
  const m: Record<string, string> = {};

  beforeAll(async () => {
    A = await seedOrg();
    B = await seedOrg();
    const pat = await customer(A.org, '(555) 010-3002');
    const noPhone = await customer(A.org, null);
    const patThread = await thread(A.org, { customer_id: pat });
    const unknownThread = await thread(A.org, { title: '+15550104004' });
    const staffThread = await thread(A.org, { title: 'Dana Ruiz', kind: 'team' });
    const noPhoneThread = await thread(A.org, { customer_id: noPhone });

    const s1 = `MSG-fill-${randomUUID()}`;
    const s2 = `MSG-fill-${randomUUID()}`;
    const s4 = `MSG-fill-${randomUUID()}`;
    // An incoming text whose stored event names its sender: the event wins over the conversation's customer phone.
    m.inFromEvent = await text(A.org, patThread, 'in', { sid: s1 });
    await storedEvent(`${s1}:inbound_text`, 'inbound_text', {
      message_id: s1, account_id: A.account, caller_number: '+15550109009', direction: 'msg_inbound', message_body: 'hi',
    });
    // An outbound text whose event arrived as a status change keyed by the event's own id, not the text's.
    m.outFromEvent = await text(A.org, patThread, 'out', { sid: s2 });
    const eventId = String(Math.floor(Math.random() * 1e9));
    await storedEvent(`${eventId}:status_change`, 'status_change', {
      sid: eventId, message_id: s2, account_id: A.account, called_number: '(555) 010-9010', direction: 'msg_outbound', status: 'delivered',
    });
    // No event: the conversation's customer phone.
    m.outNoSid = await text(A.org, patThread, 'out');
    m.inNoEvent = await text(A.org, patThread, 'in', { sid: s4 });
    // No event, no customer: the conversation's title, which is the number.
    m.inUnknown = await text(A.org, unknownThread, 'in');
    // Nothing names a number: left empty.
    m.staff = await text(A.org, staffThread, 'out');
    m.noPhone = await text(A.org, noPhoneThread, 'out');
    // Already holds a number: never touched.
    m.alreadySet = await text(A.org, patThread, 'out', { otherParty: '+15550107777' });

    // Another company, with the same customer number: never touched by a run for company A.
    const otherPat = await customer(B.org, '(555) 010-3002');
    m.otherCompany = await text(B.org, await thread(B.org, { customer_id: otherPat }), 'in');
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    await quietly(db.ctmEvent.deleteMany({ where: { ctm_event_id: { in: eventKeys } } }));
    for (const org of orgs) {
      for (const table of ['messages', 'message_threads', 'customers', 'phone_numbers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM organizations WHERE id = '${org}'`));
    }
  });

  async function run(argv: string[]) {
    const printed: string[] = [];
    const result = await runFillIn(argv, { prisma: db, print: (line) => printed.push(line) });
    return { result, printed: printed.join('\n') };
  }

  const FILLABLE = ['inFromEvent', 'outFromEvent', 'outNoSid', 'inNoEvent', 'inUnknown'];

  it('a dry run prints the counts and writes nothing', async () => {
    const { result, printed } = await run(['--org', A.org]);

    expect(result).toEqual({
      ok: true, confirmed: false,
      counts: { from_stored_event: 2, from_customer_phone: 2, from_conversation_title: 1, left_empty: 2 },
    });
    expect(printed).toContain('Dry run');
    expect(printed).toMatch(/stored event:\s+2/);
    expect(printed).toMatch(/customer phone:\s+2/);
    expect(printed).toMatch(/title:\s+1/);
    expect(printed).toMatch(/left empty:\s+2/);
    for (const key of FILLABLE) expect(await numberOf(m[key]), key).toBeNull();
  });

  it('with --confirm, fills every text from its stored event, then the rest from the conversation', async () => {
    const { result } = await run(['--org', A.org, '--confirm']);

    expect(result).toEqual({
      ok: true, confirmed: true,
      counts: { from_stored_event: 2, from_customer_phone: 2, from_conversation_title: 1, left_empty: 2 },
    });
    expect(await numberOf(m.inFromEvent)).toBe('+15550109009');
    expect(await numberOf(m.outFromEvent)).toBe('+15550109010');
    expect(await numberOf(m.outNoSid)).toBe('+15550103002');
    expect(await numberOf(m.inNoEvent)).toBe('+15550103002');
    expect(await numberOf(m.inUnknown)).toBe('+15550104004');
    expect(await numberOf(m.staff)).toBeNull();
    expect(await numberOf(m.noPhone)).toBeNull();
    expect(await numberOf(m.alreadySet)).toBe('+15550107777');
    expect(await numberOf(m.otherCompany)).toBeNull();
  });

  it('a second run changes nothing', async () => {
    // A company of its own, filled once here, so this run does not lean on the runs above.
    const c = await seedOrg();
    const pat = await customer(c.org, '(555) 010-3002');
    const patThread = await thread(c.org, { customer_id: pat });
    const sid = `MSG-fill-${randomUUID()}`;
    const fromEvent = await text(c.org, patThread, 'in', { sid });
    await storedEvent(`${sid}:inbound_text`, 'inbound_text', {
      message_id: sid, account_id: c.account, caller_number: '+15550109009', direction: 'msg_inbound', message_body: 'hi',
    });
    const fromCustomer = await text(c.org, patThread, 'out');
    const empty = await text(c.org, await thread(c.org, { title: 'Dana Ruiz', kind: 'team' }), 'out');
    const first = await run(['--org', c.org, '--confirm']);
    expect(first.result).toMatchObject({ counts: { from_stored_event: 1, from_customer_phone: 1, left_empty: 1 } });

    const { result } = await run(['--org', c.org, '--confirm']);

    expect(result).toEqual({
      ok: true, confirmed: true,
      counts: { from_stored_event: 0, from_customer_phone: 0, from_conversation_title: 0, left_empty: 1 },
    });
    expect(await numberOf(fromEvent)).toBe('+15550109009');
    expect(await numberOf(fromCustomer)).toBe('+15550103002');
    expect(await numberOf(empty)).toBeNull();
  });

  describe("a stored event never fills a text with our own number or the wrong side's number", () => {
    /** A company of its own (so the counts above stay as they are), with our main line and a customer on file. */
    async function companyWithMainLine() {
      const c = await seedOrg();
      const mainLine = '+15550100101';
      await db.phoneNumber.create({ data: { organization_id: c.org, e164: mainLine, label: 'Main line', is_org_default: true } });
      const pat = await customer(c.org, '(555) 010-3002');
      return { ...c, mainLine, patThread: await thread(c.org, { customer_id: pat }) };
    }

    it('an outbound text whose only event names no direction, with our main line as its caller, takes the customer phone', async () => {
      const c = await companyWithMainLine();
      const sid = `MSG-fill-${randomUUID()}`;
      const outbound = await text(c.org, c.patThread, 'out', { sid });
      await storedEvent(`${randomUUID()}:sms_status`, 'sms_status', {
        message_id: sid, account_id: c.account, caller_number: c.mainLine, status: 'delivered',
      });

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(outbound)).toBe('+15550103002');
      expect(result).toMatchObject({ counts: { from_stored_event: 0, from_customer_phone: 1 } });
    });

    it("an event that names no direction, or the other one, is not read: the text takes the customer phone", async () => {
      const c = await companyWithMainLine();
      const [noDirection, otherDirection] = [`MSG-fill-${randomUUID()}`, `MSG-fill-${randomUUID()}`];
      const outbound = await text(c.org, c.patThread, 'out', { sid: noDirection });
      const inbound = await text(c.org, c.patThread, 'in', { sid: otherDirection });
      await storedEvent(`${randomUUID()}:sms_status`, 'sms_status', {
        message_id: noDirection, account_id: c.account, caller_number: '+15550106006', status: 'delivered',
      });
      await storedEvent(`${randomUUID()}:status_change`, 'status_change', {
        message_id: otherDirection, account_id: c.account, caller_number: '+15550106006', called_number: '+15550106007',
        direction: 'msg_outbound', status: 'delivered',
      });

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(outbound)).toBe('+15550103002');
      expect(await numberOf(inbound)).toBe('+15550103002');
      expect(result).toMatchObject({ counts: { from_stored_event: 0, from_customer_phone: 2 } });
    });

    it('an outbound text whose event has the live outbound shape takes the contact the event names', async () => {
      const c = await companyWithMainLine();
      const sid = `MSG-fill-${randomUUID()}`;
      const outbound = await text(c.org, c.patThread, 'out', { sid });
      // As measured live: the caller and the contact are the customer texted, the called number another party.
      await storedEvent(`${randomUUID()}:status_change`, 'status_change', {
        message_id: sid, account_id: c.account, caller_number: '+15550105005', contact_number: '+15550105005',
        called_number: '+15550108008', direction: 'msg_outbound', status: 'delivered',
      });

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(outbound)).toBe('+15550105005');
      expect(result).toMatchObject({ counts: { from_stored_event: 1, from_customer_phone: 0 } });
    });

    it("an event another phone-system account reported is not this company's record of the text", async () => {
      const c = await companyWithMainLine();
      const sid = `MSG-fill-${randomUUID()}`;
      const inbound = await text(c.org, c.patThread, 'in', { sid });
      await storedEvent(`${sid}:inbound_text`, 'inbound_text', {
        message_id: sid, account_id: `other-${c.account}`, caller_number: '+15550109009', direction: 'msg_inbound',
      });

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(inbound)).toBe('+15550103002');
      expect(result).toMatchObject({ counts: { from_stored_event: 0, from_customer_phone: 1 } });
    });

    it('an outbound text whose event names one of our own numbers as the other party takes the customer phone', async () => {
      const c = await companyWithMainLine();
      const sid = `MSG-fill-${randomUUID()}`;
      const outbound = await text(c.org, c.patThread, 'out', { sid });
      await storedEvent(`${randomUUID()}:status_change`, 'status_change', {
        message_id: sid, account_id: c.account, called_number: c.mainLine, direction: 'msg_outbound', status: 'delivered',
      });

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(outbound)).toBe('+15550103002');
      expect(result).toMatchObject({ counts: { from_stored_event: 0, from_customer_phone: 1 } });
    });
  });

  describe("the conversation never fills a text with one of our own numbers", () => {
    it("a customer whose phone is one of our own lines: the text is left empty", async () => {
      const c = await seedOrg();
      const mainLine = '+15550100102';
      await db.phoneNumber.create({ data: { organization_id: c.org, e164: mainLine, label: 'Main line', is_org_default: true } });
      const onOurLine = await customer(c.org, mainLine.slice(2));
      const outbound = await text(c.org, await thread(c.org, { customer_id: onOurLine }), 'out');

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(outbound)).toBeNull();
      expect(result).toMatchObject({ counts: { from_customer_phone: 0, from_conversation_title: 0, left_empty: 1 } });
    });

    it("a conversation titled with one of our own lines: the text is left empty", async () => {
      const c = await seedOrg();
      const mainLine = '+15550100103';
      await db.phoneNumber.create({ data: { organization_id: c.org, e164: mainLine, label: 'Main line', is_org_default: true } });
      const outbound = await text(c.org, await thread(c.org, { title: mainLine }), 'out');

      const { result } = await run(['--org', c.org, '--confirm']);

      expect(await numberOf(outbound)).toBeNull();
      expect(result).toMatchObject({ counts: { from_customer_phone: 0, from_conversation_title: 0, left_empty: 1 } });
    });
  });

  it('refuses to run without a company or --all', async () => {
    const { result, printed } = await run(['--confirm']);

    expect(result.ok).toBe(false);
    expect(printed).toContain('--org');
    expect(await numberOf(m.otherCompany)).toBeNull();
  });

  it.each([
    ['a company that is not an id', ['--org', 'not-an-id', '--confirm']],
    ['--org with the next flag where the id should be', ['--org', '--confirm']],
  ])('refuses %s, and writes nothing', async (_case, argv) => {
    const { result, printed } = await run(argv);

    expect(result).toEqual({ ok: false, error: expect.stringContaining('--org') });
    expect(printed).toContain('company id');
  });
});
