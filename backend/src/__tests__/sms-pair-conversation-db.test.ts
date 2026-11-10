/* =============================================================================
   #3019 - One conversation per pair of numbers (parent #3013, Q38).

   An SMS conversation with a customer or an unknown number is the customer's (or the unknown sender's) number plus one of
   our numbers. Driven through the real HTTP doors against a real migrated database (TEST_DATABASE_URL; the suite skips when
   it is unset):
     - incoming texts (the phone system's webhook) find or create the conversation for their pair;
     - a send from a conversation leaves from that conversation's number, whoever sends it;
     - a send from a customer or a lead continues the latest conversation with the number (decision 2), else leaves from the
       sender's own number, else the main line;
     - the conversation's default customer follows the fixed order (#3015);
     - a conversation from before pairs (the split script has not reached it) keeps working: nothing fails, no text is lost;
     - another company with the same numbers is never joined;
     - the inbox names our number on each conversation.
   The phone system is faked at its network edge only: `fetch` answers the opt-out check and the send, and records the number
   each text went to and the company number it went out from. Every org the suite makes is removed again.

   The split of existing conversations is scripts/__tests__/sms-conversation-pair-split-db.test.ts; the entry-point guard is
   sms-pair-conversation-doors-guard.test.ts.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
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
// The suite-wide setup replaces the phone-system client; here the real one runs, and only its network edge is faked.
vi.unmock('../lib/ctm/client');

import { switchFixture } from './permission-switches-fixture';
import { env } from '../config/env';

const suite = realClient ? describe : describe.skip;

// The phone system's address in this suite. Nothing outside it may be reached.
const PROVIDER = 'https://phone-provider.test/api/v1';

/** What the faked phone system was asked to send: where each text went, and the company number it left from. */
const sent: { to: string; from: string }[] = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** The phone system at its network edge: no one has opted out, and every send is accepted with a fresh message id. */
async function fakeProvider(url: unknown, init?: { method?: string; body?: unknown }) {
  const u = String(url);
  if (!u.startsWith(PROVIDER)) throw new Error(`unexpected network call: ${u}`);
  const path = u.slice(PROVIDER.length);
  if ((init?.method ?? 'GET') === 'GET' && path.includes('/opt_out_texts')) return json({ opt_out_texts: [] });
  if (init?.method === 'POST' && /\/sms$/.test(path)) {
    const form = new URLSearchParams(String(init.body));
    sent.push({ to: form.get('to') ?? '', from: form.get('from') ?? '' });
    return json({ id: `MSG-3019-${randomUUID()}` });
  }
  return json({ error: 'not found' }, 404);
}

suite('one conversation per pair of numbers (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const WEBHOOK_TOKEN = randomUUID();

  beforeAll(async () => {
    await fx.listener();
    // A connected phone system, with keys made up for this run.
    Object.assign(env as Record<string, unknown>, {
      CTM_ACCESS_KEY: randomUUID(), CTM_SECRET_KEY: randomUUID(), CTM_API_BASE: PROVIDER, CTM_WEBHOOK_TOKEN: WEBHOOK_TOKEN,
    });
    vi.stubGlobal('fetch', fakeProvider);
  }, 120_000);

  beforeEach(() => {
    sent.length = 0;
  });

  const orgs: string[] = [];
  afterAll(async () => {
    vi.unstubAllGlobals();
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['notification_recipients', 'notifications', 'timeline_events', 'message_thread_read_states',
        'messages', 'message_threads']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM user_phone_numbers WHERE phone_number_id IN (SELECT id FROM phone_numbers WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_numbers WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM leads WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM customers WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  let sequence = 0;
  const nextNumber = (prefix: string) => `${prefix}${String(++sequence).padStart(4, '0')}`;

  /**
   * A company connected to the phone system: its main line, Dana Ruiz with a number of her own, and a customer whose
   * phone is (555) 010-3002. `numbers` lets a second company carry the very same numbers.
   */
  async function connectedOrg(numbers?: { mainLine: string; danaLine: string }) {
    const made = await fx.newOrg();
    orgs.push(made.org);
    const account = `3019${made.tag}`;
    await db.organization.update({
      where: { id: made.org },
      data: { ctm_account_id: account, ctm_sms_ready: true, sms_sending_enabled: true },
    });
    const mainLine = numbers?.mainLine ?? nextNumber('+1555020');
    const danaLine = numbers?.danaLine ?? nextNumber('+1555021');
    const main = await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: mainLine, label: 'Main line', is_org_default: true, status: 'active',
        sms_enabled: true, ctm_number_id: `TPN-MAIN-${made.tag}`,
      },
    });
    const danaNumber = await db.phoneNumber.create({
      data: {
        organization_id: made.org, e164: danaLine, status: 'active', sms_enabled: true, ctm_number_id: `TPN-DANA-${made.tag}`,
      },
    });
    const dana = await fx.addUser(made.org, 'Dana', 'ADMIN');
    await db.user.update({ where: { id: dana.id }, data: { last_name: 'Ruiz' } });
    await db.userPhoneNumber.create({ data: { user_id: dana.id, phone_number_id: danaNumber.id, is_default: true } });
    // Stored bare, the way the customer forms store a phone (the number match compares stored spellings).
    await db.customer.update({ where: { id: made.customer }, data: { phone: '5550103002' } });
    return {
      ...made, account, dana, mainLine, danaLine,
      mainTpn: `TPN-MAIN-${made.tag}`, danaTpn: `TPN-DANA-${made.tag}`, mainId: main.id,
    };
  }

  type Company = Awaited<ReturnType<typeof connectedOrg>>;

  /** The customer texts one of our numbers, as the phone system reports it. */
  async function customerTexts(w: Company, ourNumber: string, body: string, from = '+15550103002', secondsAgo = 0) {
    const sid = `MSG-3019-${randomUUID()}`;
    const res = await request(await fx.listener())
      .post(`/api/webhooks/ctm/inbound_text?token=${WEBHOOK_TOKEN}`)
      .send({
        message_id: sid, account_id: w.account, caller_number: from, tracking_number: ourNumber,
        direction: 'msg_inbound', message_body: body, unix_time: Math.floor(Date.now() / 1000) - secondsAgo,
      });
    expect(res.status).toBe(200);
    return sid;
  }

  /** The company's conversations as the inbox lists them to its admin, each with its texts in order. */
  async function inbox(w: Company) {
    const res = await (await fx.signedInAs(w.admin)).get('/api/communication/threads');
    expect(res.status).toBe(200);
    return res.body.threads as {
      id: string; customerId: string;
      messages: { body: string; direction: string }[];
      pair?: { otherPartyE164: string; ourNumberE164: string | null; ourLine: { kind: string; name?: string } | null; customers: { id: string; name: string }[] };
    }[];
  }

  /** Each conversation as [the number pair, its texts' words], the way a person reads the inbox. */
  async function conversations(w: Company) {
    return (await inbox(w))
      .map((t) => ({ pair: t.pair ? [t.pair.otherPartyE164, t.pair.ourNumberE164] : null, texts: t.messages.map((m) => m.body).sort() }))
      .sort((a, b) => String(a.pair).localeCompare(String(b.pair)));
  }

  describe('a customer texted from Dana\'s number and from the main line has two conversations', () => {
    it('each holding only its own texts', async () => {
      const w = await connectedOrg();
      // Dana texts the customer from the customer's page: it leaves from her own number.
      const dana = await fx.signedInAs(w.dana);
      const first = await dana.post('/api/communication/sms', { customerId: w.customer, body: 'Your estimate is ready' });
      expect(first.status).toBe(201);
      // The customer texts the main line, then answers Dana.
      await customerTexts(w, w.mainLine, 'Is the office open Saturday?');
      await customerTexts(w, w.danaLine, 'Shall we book it?');

      expect(await conversations(w)).toEqual([
        { pair: ['+15550103002', w.mainLine], texts: ['Is the office open Saturday?'] },
        { pair: ['+15550103002', w.danaLine], texts: ['Shall we book it?', 'Your estimate is ready'] },
      ]);
      expect(sent).toEqual([{ to: '+15550103002', from: w.danaTpn }]);
    });
  });

  describe('a new text from either side lands in the conversation for its pair', () => {
    it('a reply in a conversation leaves from that conversation\'s number, even when another person sends it', async () => {
      const w = await connectedOrg();
      await customerTexts(w, w.danaLine, 'Can someone call me?');
      const [danaConversation] = await inbox(w);

      // The admin has no number of their own: the reply still leaves from Dana's number, in Dana's conversation.
      const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', {
        threadId: danaConversation!.id, body: 'Calling you now',
      });

      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: '+15550103002', from: w.danaTpn }]);
      expect(await conversations(w)).toEqual([
        { pair: ['+15550103002', w.danaLine], texts: ['Calling you now', 'Can someone call me?'] },
      ]);
    });

    it('a text from a lead continues the latest conversation with the number, whichever of our numbers it is on', async () => {
      const w = await connectedOrg();
      const lead = await fx.addLead(w.org, w.customer);
      await customerTexts(w, w.mainLine, 'First question', '+15550103002', 120);
      await customerTexts(w, w.danaLine, 'Second question', '+15550103002', 60);

      // The admin, who has no number of their own (a new conversation would be the main line's), texts from the lead:
      // the latest conversation with the number is Dana's, so the text continues it, from her number.
      const res = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', {
        customerId: w.customer, leadId: lead.id, body: 'Answering your second question',
      });

      expect(res.status).toBe(201);
      expect(res.body.message.leadId).toBe(lead.id);
      expect(sent).toEqual([{ to: '+15550103002', from: w.danaTpn }]);
      expect(await conversations(w)).toEqual([
        { pair: ['+15550103002', w.mainLine], texts: ['First question'] },
        { pair: ['+15550103002', w.danaLine], texts: ['Answering your second question', 'Second question'] },
      ]);
    });

    it('with no conversation yet, a text leaves from the sender\'s own number, else the main line', async () => {
      const w = await connectedOrg();
      const own = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { toNumber: '(555) 010-4004', body: 'From Dana' });
      const main = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { toNumber: '(555) 010-5005', body: 'From the office' });

      expect([own.status, main.status]).toEqual([201, 201]);
      expect(sent).toEqual([{ to: '+15550104004', from: w.danaTpn }, { to: '+15550105005', from: w.mainTpn }]);
      expect(await conversations(w)).toEqual([
        { pair: ['+15550104004', w.danaLine], texts: ['From Dana'] },
        { pair: ['+15550105005', w.mainLine], texts: ['From the office'] },
      ]);
    });

    it('an unknown number that texts two of our numbers has two conversations, filed on nobody', async () => {
      const w = await connectedOrg();
      await customerTexts(w, w.mainLine, 'Who is this?', '+15550106006');
      await customerTexts(w, w.danaLine, 'Hello?', '+15550106006');
      await customerTexts(w, w.mainLine, 'Still there?', '+15550106006');

      const listed = await inbox(w);
      expect(listed.map((t) => t.customerId)).toEqual(['', '']);
      expect(await conversations(w)).toEqual([
        { pair: ['+15550106006', w.mainLine], texts: ['Still there?', 'Who is this?'] },
        { pair: ['+15550106006', w.danaLine], texts: ['Hello?'] },
      ]);
    });

    it('another company with the same numbers is never joined', async () => {
      const other = await connectedOrg();
      const w = await connectedOrg({ mainLine: other.mainLine, danaLine: other.danaLine });
      await customerTexts(other, other.danaLine, 'Texting the other company');

      await customerTexts(w, w.danaLine, 'Texting this company');

      expect(await conversations(w)).toEqual([{ pair: ['+15550103002', w.danaLine], texts: ['Texting this company'] }]);
      expect(await conversations(other)).toEqual([{ pair: ['+15550103002', other.danaLine], texts: ['Texting the other company'] }]);
    });
  });

  describe('the conversation\'s default customer follows the fixed order', () => {
    it('two customers share a number: the reply is filed on the one with the newest open lead', async () => {
      const w = await connectedOrg();
      // The older customer was made first; a newer customer with the same number has an open lead.
      await db.customer.update({ where: { id: w.customer }, data: { created_at: new Date('2022-03-01T12:00:00Z') } });
      const newer = randomUUID();
      await db.customer.create({
        data: {
          id: newer, organization_id: w.org, customer_number: `C-${newer.slice(0, 8)}`, kind: 'PERSON', segment: 'RESIDENTIAL',
          first_name: 'Jordan', last_name: 'Lee', phone: '5550103002',
        },
      });
      await fx.addLead(w.org, newer);

      await customerTexts(w, w.mainLine, 'Is my appointment still on?');

      const [conversation] = await inbox(w);
      expect(conversation!.customerId).toBe(newer);
    });
  });

  /** The company's conversations as [their id, the number pair, their texts' words], for a conversation from before pairs. */
  async function conversationsById(w: Company) {
    return (await inbox(w))
      .map((t) => ({ id: t.id, pair: t.pair ? [t.pair.otherPartyE164, t.pair.ourNumberE164] : null, texts: t.messages.map((m) => m.body).sort() }))
      .sort((a, b) => String(a.pair).localeCompare(String(b.pair)));
  }

  /** A customer's (or an unknown number's) conversation as it was before #3019: not keyed by a pair, holding one text. */
  async function conversationFromBeforePairs(
    w: Company,
    text: { body: string; otherPartyE164: string | null; phoneNumberId: string | null },
    filedOn: { customerId: string | null; title?: string } = { customerId: w.customer },
  ) {
    const thread = await db.messageThread.create({
      data: {
        organization_id: w.org, channel: 'sms', campaign_type: 'customer_care',
        customer_id: filedOn.customerId, title: filedOn.title ?? null,
      },
    });
    await db.message.create({
      data: {
        organization_id: w.org, thread_id: thread.id, direction: 'out', body: text.body, ts: new Date('2025-06-01T12:00:00Z'),
        status: 'delivered', other_party_e164: text.otherPartyE164, phone_number_id: text.phoneNumberId,
      },
    });
    return thread.id;
  }

  describe('a conversation from before pairs keeps working until the split runs', () => {
    it('it takes the texts of its own pair, a reply in it lands in it, and another pair gets its own conversation', async () => {
      const w = await connectedOrg();
      // Sent last year (the #3014 fill-in has stored the customer's number on it), with no company number: the main line.
      const legacy = await conversationFromBeforePairs(w, { body: 'Sent last year', otherPartyE164: '+15550103002', phoneNumberId: null });

      await customerTexts(w, w.mainLine, 'Replying to an old text');
      // The admin has no number of their own: the reply leaves from the main line, today's rule for this conversation.
      const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: legacy, body: 'Thanks' });
      await customerTexts(w, w.danaLine, 'A question for Dana');
      const fromPage = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { customerId: w.customer, body: 'One more thing' });

      expect([reply.status, fromPage.status]).toEqual([201, 201]);
      expect(await conversationsById(w)).toEqual([
        { id: expect.not.stringMatching(legacy), pair: ['+15550103002', w.danaLine], texts: ['A question for Dana', 'One more thing'] },
        { id: legacy, pair: null, texts: ['Replying to an old text', 'Sent last year', 'Thanks'] },
      ]);
      expect(sent).toEqual([{ to: '+15550103002', from: w.mainTpn }, { to: '+15550103002', from: w.danaTpn }]);
    });

    it('before the fill-in has stored any number on its texts, it takes the first pair, and the next pair gets its own', async () => {
      const w = await connectedOrg();
      const legacy = await conversationFromBeforePairs(w, { body: 'Sent last year', otherPartyE164: null, phoneNumberId: null });

      await customerTexts(w, w.mainLine, 'To the office', '+15550103002', 60);
      await customerTexts(w, w.danaLine, 'To Dana', '+15550103002', 30);
      await customerTexts(w, w.mainLine, 'The office again');

      expect(await conversationsById(w)).toEqual([
        { id: expect.not.stringMatching(legacy), pair: ['+15550103002', w.danaLine], texts: ['To Dana'] },
        { id: legacy, pair: null, texts: ['Sent last year', 'The office again', 'To the office'] },
      ]);
    });

    it('an unknown number\'s conversation is not passed over because another company has one keyed by the same number', async () => {
      const other = await connectedOrg();
      const w = await connectedOrg({ mainLine: other.mainLine, danaLine: other.danaLine });
      await customerTexts(other, other.mainLine, 'Texting the other company', '+15550106006');
      const legacy = await conversationFromBeforePairs(
        w, { body: 'Who is this?', otherPartyE164: null, phoneNumberId: null }, { customerId: null, title: '+15550106006' },
      );

      await customerTexts(w, w.mainLine, 'Texting this company', '+15550106006');

      expect(await conversationsById(w)).toEqual([{ id: legacy, pair: null, texts: ['Texting this company', 'Who is this?'] }]);
    });

    /**
     * A conversation from before pairs, filed on the customer, holding these texts (of the customer's phone unless `otherParty`
     * says another number), oldest first, a minute apart.
     */
    async function conversationFromBeforePairsHolding(
      w: Company,
      texts: { body: string; direction: 'in' | 'out'; via: string | null; status: string | null; otherParty?: string }[],
    ) {
      const thread = await db.messageThread.create({
        data: { organization_id: w.org, channel: 'sms', campaign_type: 'customer_care', customer_id: w.customer },
      });
      for (const [i, t] of texts.entries()) {
        await db.message.create({
          data: {
            organization_id: w.org, thread_id: thread.id, direction: t.direction, body: t.body, ts: new Date(Date.UTC(2025, 5, 1, 12, i)),
            status: t.status, other_party_e164: t.otherParty ?? '+15550103002', phone_number_id: t.via,
          },
        });
      }
      return thread.id;
    }
    const danaNumberId = async (w: Company) => (await db.phoneNumber.findFirstOrThrow({ where: { organization_id: w.org, e164: w.danaLine } })).id;

    // Ran's rulings (2026-11-06), the split's rule: a reply that did not go out (skipped, failed or still queued: no company
    // number stored) is its conversation's own pair - the company number of its latest text with that other party that has
    // one; when that other party has none, the company number of the conversation's latest text that has one, whatever its
    // other party; the main line only when no text in the conversation has a company number.
    it('a reply in it that did not go out does not make it the main line\'s: a text to the main line gets its own conversation', async () => {
      const w = await connectedOrg();
      const legacy = await conversationFromBeforePairsHolding(w, [
        { body: 'Customer to Dana', direction: 'in', via: await danaNumberId(w), status: 'received' },
        { body: 'Dana replies, skipped', direction: 'out', via: null, status: 'skipped' },
      ]);

      await customerTexts(w, w.mainLine, 'To the office', '+15550103002', 60);
      // It keeps taking its own pair's texts.
      await customerTexts(w, w.danaLine, 'Dana again');

      expect(await conversationsById(w)).toEqual([
        { id: expect.not.stringMatching(legacy), pair: ['+15550103002', w.mainLine], texts: ['To the office'] },
        { id: legacy, pair: null, texts: ['Customer to Dana', 'Dana again', 'Dana replies, skipped'] },
      ]);
    });

    it('when none of its texts has a company number, a reply that did not go out is the main line\'s: a text to the main line joins it', async () => {
      const w = await connectedOrg();
      const legacy = await conversationFromBeforePairsHolding(w, [
        { body: 'Office replies, failed', direction: 'out', via: null, status: 'failed' },
        { body: 'Office replies, still queued', direction: 'out', via: null, status: 'queued' },
      ]);

      await customerTexts(w, w.mainLine, 'To the office', '+15550103002', 60);
      await customerTexts(w, w.danaLine, 'To Dana');

      expect(await conversationsById(w)).toEqual([
        { id: expect.not.stringMatching(legacy), pair: ['+15550103002', w.danaLine], texts: ['To Dana'] },
        { id: legacy, pair: null, texts: ['Office replies, failed', 'Office replies, still queued', 'To the office'] },
      ]);
    });

    // The customer texted Dana's line from (555) 010-5252; Dana's reply went to the customer's phone and did not go out. The
    // customer's phone has no text with a company number, so the reply takes the conversation's latest one: Dana's line.
    it.each(['skipped', 'queued', 'failed'])(
      'a %s reply to a number with no text through our numbers is the pair of its latest text that has one: a text to the main line gets its own conversation, a text to that number joins it',
      async (status) => {
        const w = await connectedOrg();
        const legacy = await conversationFromBeforePairsHolding(w, [
          { body: 'Customer from 5252 to Dana', direction: 'in', via: await danaNumberId(w), status: 'received', otherParty: '+15550105252' },
          { body: `Dana replies, ${status}`, direction: 'out', via: null, status },
        ]);

        await customerTexts(w, w.mainLine, 'To the office', '+15550103002', 60);
        await customerTexts(w, w.danaLine, 'To Dana');

        expect(await conversationsById(w)).toEqual([
          { id: expect.not.stringMatching(legacy), pair: ['+15550103002', w.mainLine], texts: ['To the office'] },
          { id: legacy, pair: null, texts: ['Customer from 5252 to Dana', `Dana replies, ${status}`, 'To Dana'] },
        ]);
      },
    );

    it('the LATEST text with a company number decides, whatever its other party: a reply after 5252\'s text to the main line is the main line\'s', async () => {
      const w = await connectedOrg();
      const legacy = await conversationFromBeforePairsHolding(w, [
        { body: 'Customer from 5252 to Dana', direction: 'in', via: await danaNumberId(w), status: 'received', otherParty: '+15550105252' },
        { body: 'Customer from 5252 to the office', direction: 'in', via: w.mainId, status: 'received', otherParty: '+15550105252' },
        { body: 'Office replies, skipped', direction: 'out', via: null, status: 'skipped' },
      ]);

      await customerTexts(w, w.danaLine, 'To Dana', '+15550103002', 60);
      await customerTexts(w, w.mainLine, 'To the office');

      expect(await conversationsById(w)).toEqual([
        { id: expect.not.stringMatching(legacy), pair: ['+15550103002', w.danaLine], texts: ['To Dana'] },
        { id: legacy, pair: null, texts: ['Customer from 5252 to Dana', 'Customer from 5252 to the office', 'Office replies, skipped', 'To the office'] },
      ]);
    });

    it('an outbound text with no company number and no status is not a reply that did not go out: it is the main line\'s, and a text to the main line joins it', async () => {
      const w = await connectedOrg();
      const legacy = await conversationFromBeforePairsHolding(w, [
        { body: 'Customer to Dana', direction: 'in', via: await danaNumberId(w), status: 'received' },
        { body: 'Office text, no status', direction: 'out', via: null, status: null },
      ]);

      await customerTexts(w, w.mainLine, 'To the office', '+15550103002', 60);
      await customerTexts(w, w.danaLine, 'To Dana');

      expect(await conversationsById(w)).toEqual([
        { id: legacy, pair: null, texts: ['Customer to Dana', 'Office text, no status', 'To Dana', 'To the office'] },
      ]);
    });
  });

  describe('after the split, a text joins only its pair\'s conversation', () => {
    it('a customer who texts two of our numbers has two conversations; one left with no number takes neither', async () => {
      const w = await connectedOrg();
      // The customer's conversations as the split script leaves them (scripts/__tests__/sms-conversation-pair-split-db): the
      // one holding last year's text from the main line keyed by its pair in place, and the one holding only an automated
      // text sent before the customer had a number left as it is, not keyed.
      const keyed = await conversationFromBeforePairs(w, { body: 'Sent last year', otherPartyE164: '+15550103002', phoneNumberId: w.mainId });
      await db.messageThread.update({ where: { id: keyed }, data: { other_party_e164: '+15550103002', our_number_e164: w.mainLine } });
      const leftAsItIs = await conversationFromBeforePairs(w, { body: 'Sent before they had a number', otherPartyE164: null, phoneNumberId: null });

      await customerTexts(w, w.mainLine, 'To the office', '+15550103002', 60);
      await customerTexts(w, w.danaLine, 'To Dana', '+15550103002', 30);
      // Dana answers from the customer's page: the latest conversation with the number is hers (decision 2).
      const fromPage = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { customerId: w.customer, body: 'Dana answers' });

      expect(fromPage.status).toBe(201);
      expect(await conversationsById(w)).toEqual([
        { id: keyed, pair: ['+15550103002', w.mainLine], texts: ['Sent last year', 'To the office'] },
        { id: expect.any(String), pair: ['+15550103002', w.danaLine], texts: ['Dana answers', 'To Dana'] },
        { id: leftAsItIs, pair: null, texts: ['Sent before they had a number'] },
      ]);
    });
  });

  describe('a number only a lead carries as its own: the conversation is that number\'s, and texts go to it', () => {
    /**
     * The customer's phone is (555) 010-3002; their open lead changed it to (555) 010-5252, which nobody else carries, so the
     * number's customer is the lead's (#3015). The customer also has a conversation from before pairs whose texts the
     * #3014 fill-in has not reached: it texts the customer's phone, 3002, so it never takes 5252's texts.
     */
    async function leadWithItsOwnNumber(w: Company) {
      const lead = await fx.addLead(w.org, w.customer);
      await db.recordContactEntry.create({
        data: {
          organization_id: w.org, lead_id: lead.id, kind: 'PHONE', intent: 'CHANGED', value: '5550105252',
          overridden_field: 'phone', customer_value_at_change: '5550103002',
        },
      });
      const legacy = await conversationFromBeforePairs(w, { body: 'Sent last year', otherPartyE164: null, phoneNumberId: null });
      return { lead, legacy };
    }

    it('an incoming text from 5252, then a reply from that conversation, goes to 5252', async () => {
      const w = await connectedOrg();
      const { legacy } = await leadWithItsOwnNumber(w);

      await customerTexts(w, w.mainLine, 'This is my new number', '+15550105252');
      const conversation = (await inbox(w)).find((t) => t.messages.some((m) => m.body === 'This is my new number'))!;
      const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: conversation.id, body: 'Noted, thanks' });

      expect(reply.status).toBe(201);
      expect(sent).toEqual([{ to: '+15550105252', from: w.mainTpn }]);
      expect(await conversationsById(w)).toEqual([
        { id: conversation.id, pair: ['+15550105252', w.mainLine], texts: ['Noted, thanks', 'This is my new number'] },
        { id: legacy, pair: null, texts: ['Sent last year'] },
      ]);
    });

    it('a text sent to 5252 with no lead attached goes to 5252, in a conversation whose other party is 5252', async () => {
      const w = await connectedOrg();
      const { legacy } = await leadWithItsOwnNumber(w);

      const res = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { toNumber: '(555) 010-5252', body: 'Texting your new number' });

      expect(res.status).toBe(201);
      expect(sent).toEqual([{ to: '+15550105252', from: w.danaTpn }]);
      expect(await conversationsById(w)).toEqual([
        { id: expect.not.stringMatching(legacy), pair: ['+15550105252', w.danaLine], texts: ['Texting your new number'] },
        { id: legacy, pair: null, texts: ['Sent last year'] },
      ]);
    });
  });

  describe('a lead or job whose card changed the customer\'s phone to (555) 010-5252 (#3016): its texts and the replies go to 5252', () => {
    // The customer's phone stays (555) 010-3002, and the customer has a conversation from before pairs with it. The record's
    // text box texts the number the record shows (#3016), so the conversation is that number's pair, and a reply in it from
    // the inbox texts that number too.
    it.each([
      ['lead', 'leadId'],
      ['job', 'jobId'],
    ] as const)('a text from the %s\'s text box goes to 5252, in the (5252, our number) conversation, tied to it; an inbox reply there goes to 5252', async (kind, idField) => {
      const w = await connectedOrg();
      const record = kind === 'lead' ? await fx.addLead(w.org, w.customer) : await fx.addJob(w.org, w.customer);
      const dana = await fx.signedInAs(w.dana);
      const pencil = await dana.post(`/api/${kind}s/${record.id}/contact-entries/change`, {
        kind: 'PHONE', replaces: '(555) 010-3002', value: '(555) 010-5252',
      });
      expect(pencil.status).toBe(201);
      const legacy = await conversationFromBeforePairs(w, { body: 'Sent last year', otherPartyE164: '+15550103002', phoneNumberId: null });

      const fromTheRecord = await dana.post('/api/communication/sms', { customerId: w.customer, [idField]: record.id, body: 'About your visit' });

      expect(fromTheRecord.status).toBe(201);
      expect(fromTheRecord.body.message[idField]).toBe(record.id);
      expect(sent).toEqual([{ to: '+15550105252', from: w.danaTpn }]);
      const conversation = (await inbox(w)).find((t) => t.messages.some((m) => m.body === 'About your visit'))!;
      expect(conversation.pair).toMatchObject({ otherPartyE164: '+15550105252', ourNumberE164: w.danaLine });

      const reply = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', { threadId: conversation.id, body: 'Following up' });

      expect(reply.status).toBe(201);
      expect(sent).toEqual([
        { to: '+15550105252', from: w.danaTpn },
        { to: '+15550105252', from: w.danaTpn },
      ]);
      expect(await conversationsById(w)).toEqual([
        { id: conversation.id, pair: ['+15550105252', w.danaLine], texts: ['About your visit', 'Following up'] },
        { id: legacy, pair: null, texts: ['Sent last year'] },
      ]);
    });
  });

  describe('one of our own numbers is never the other party of a conversation', () => {
    it('a text from the page of a customer whose phone is our main line is not keyed by our own number', async () => {
      const w = await connectedOrg();
      await db.customer.update({ where: { id: w.customer }, data: { phone: w.mainLine.slice(2) } });

      const res = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { customerId: w.customer, body: 'Testing the office phone' });

      expect(res.status).toBe(201);
      expect(await conversations(w)).toEqual([{ pair: null, texts: ['Testing the office phone'] }]);
    });

    it('a text composed to our main line\'s number is not keyed by our own number', async () => {
      const w = await connectedOrg();

      const res = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', { toNumber: w.mainLine, body: 'Testing the main line' });

      expect(res.status).toBe(201);
      expect(await conversations(w)).toEqual([{ pair: null, texts: ['Testing the main line'] }]);
    });
  });

  describe('the inbox names our number on each conversation', () => {
    it('Dana Ruiz\'s number, or the main line', async () => {
      const w = await connectedOrg();
      await customerTexts(w, w.danaLine, 'To Dana');
      await customerTexts(w, w.mainLine, 'To the office');

      const lines = (await inbox(w)).map((t) => ({ number: t.pair?.ourNumberE164, line: t.pair?.ourLine }))
        .sort((a, b) => String(a.number).localeCompare(String(b.number)));

      expect(lines).toEqual([
        { number: w.mainLine, line: { kind: 'main_line' } },
        { number: w.danaLine, line: { kind: 'person', name: 'Dana Ruiz' } },
      ]);
    });
  });

  it('journey: Dana texts from a lead, the customer answers, a colleague replies from Dana\'s number', async () => {
    const w = await connectedOrg();
    const lead = await fx.addLead(w.org, w.customer);
    const first = await (await fx.signedInAs(w.dana)).post('/api/communication/sms', {
      customerId: w.customer, leadId: lead.id, body: 'Can we come Tuesday?',
    });
    expect(first.status).toBe(201);
    await customerTexts(w, w.danaLine, 'Tuesday works');
    const [conversation] = await inbox(w);
    const colleague = await (await fx.signedInAs(w.admin)).post('/api/communication/sms', {
      threadId: conversation!.id, body: 'Booked for Tuesday',
    });
    expect(colleague.status).toBe(201);

    expect(sent).toEqual([{ to: '+15550103002', from: w.danaTpn }, { to: '+15550103002', from: w.danaTpn }]);
    const listed = await inbox(w);
    expect(listed).toHaveLength(1);
    // #3021: with every customer carrying the number (here the one customer).
    expect(listed[0]!.pair).toEqual({
      otherPartyE164: '+15550103002', ourNumberE164: w.danaLine, ourLine: { kind: 'person', name: 'Dana Ruiz' },
      customers: [{ id: w.customer, name: 'Pat Payer' }],
    });
    expect(listed[0]!.messages.map((m) => m.body).sort()).toEqual(['Booked for Tuesday', 'Can we come Tuesday?', 'Tuesday works']);
  });
});
