/* =============================================================================
   #2980 - pick or switch to check, Zelle, bank transfer or card by phone after signing.

   The estimate stores the customer's current deposit method. Every pick through either door
   stores it: the approval door (at signing, and its retry on a signed, Pending estimate), and the
   deposit's own checkout (card or bank after signing). The public read returns it. The office gets
   one in-app alert per change and no email (Ran 2026-11-04), History names the method, and the
   customer's signed-estimate email goes exactly once per signing.

   Every step is the real HTTP route on a real, migrated database. The processor SDK is replaced
   by a recorder (as in deposit-retry-after-cancel-db), and the mail senders are the suite-wide
   mocks, so a queued email is a recorded call. Skips when TEST_DATABASE_URL is unset, like every
   other *-db suite. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

const { processor } = vi.hoisted(() => {
  const sessions: Array<{ id: string; url: string; created: number; status: 'open' | 'expired'; params: any }> = [];
  let n = 0;
  return {
    processor: {
      sessions,
      create: async (params: any) => {
        n += 1;
        const s = { id: `cs_2980_${n}_${Date.now()}`, url: `https://checkout.example/2980/${n}`, created: 1790000000 + n, status: 'open' as const, params };
        sessions.push(s);
        return { id: s.id, url: s.url, created: s.created, metadata: params.metadata };
      },
      list: async () => ({ data: [], has_more: false }),
      expire: async (id: string) => ({ id, status: 'expired' }),
      retrievePaymentIntent: vi.fn(),
    },
  };
});

// The suite-wide setup mocks the app's client; here it is a real one.
vi.mock('../lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  const url = process.env.TEST_DATABASE_URL;
  return { prisma: url ? new PrismaClient({ datasources: { db: { url } } }) : undefined };
});

vi.unmock('../lib/stripe');
vi.mock('stripe', () => ({
  default: class RecordingProcessorClient {
    checkout = { sessions: { create: processor.create, list: processor.list, expire: processor.expire } };
    paymentIntents = { retrieve: processor.retrievePaymentIntent };
    disputes = { list: vi.fn().mockResolvedValue({ data: [], has_more: false }) };
    applicationFees = { list: vi.fn().mockResolvedValue({ data: [] }), createRefund: vi.fn() };
  },
}));

import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import * as emailModule from '../lib/email';
import { sendEstimateApprovedNotification } from '../lib/email';
import { claimSignedCopy } from '../lib/estimates/deposit-method';

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const SIGNATURE = 'data:image/png;base64,iVBORw0KGgo=';
const TERMS = 'Work is guaranteed for one year.';
const SENT_WITH = ['CARD', 'ACH', 'CHECK', 'ZELLE', 'BANK_TRANSFER', 'EXTERNAL_CARD'];

/** A beat for the fire-and-forget announcements, before asserting that one did NOT happen. */
const settle = () => new Promise((r) => setTimeout(r, 400));

suite('#2980 the customer picks or switches the deposit method after signing (real database)', () => {
  const db = prisma;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  beforeAll(async () => {
    (env as unknown as Record<string, unknown>).STRIPE_SECRET_KEY = 'sk_test_deposit_method_2980_db';
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
  });
  beforeEach(() => {
    processor.sessions.length = 0;
    processor.retrievePaymentIntent.mockReset();
    vi.mocked(sendEstimateApprovedNotification).mockClear();
  });

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM estimate_send_configs WHERE estimate_id IN (SELECT id FROM estimates WHERE organization_id = '${org}')`));
      for (const table of ['estimates', 'leads', 'customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_2980_%'`));
    await db.$disconnect();
  });

  /** A sent $1,000 estimate WITH terms, asking for a $500 deposit, sent with every kind of method. */
  async function sentEstimate() {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const lead = randomUUID();
    const estimate = randomUUID();
    const deposit = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `pb2980-${tag}`, email: `pb2980-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: TERMS, estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: `acct_2980_${tag}`, stripe_charges_enabled: true,
        accepted_payment_methods: SENT_WITH as never,
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `creator-${tag}@example.test`, first_name: 'Test', last_name: 'Creator', role: 'ADMIN', is_admin: true },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test` },
    });
    await db.lead.create({
      // The creator owns the lead, so the estimate's Owner is the person the office alert is for.
      data: { id: lead, organization_id: org, lead_number: `L-${tag}`, customer_id: customer, service_request: 'Garage door', status: 'ESTIMATED', commission_owner_id: user },
    });
    await db.estimate.create({
      data: {
        id: estimate, organization_id: org, lead_id: lead, customer_id: customer, created_by: user, estimate_number: `E-${tag}`,
        status: 'SENT', subtotal: 1000, tax_amount: 0, total_amount: 1000, sent_at: new Date(),
        public_token: `est-${tag}`, deposit_type: 'FIXED', deposit_value: 500,
        // The terms the customer was shown. The retry used to re-check them and refuse; a fixture
        // without them is why the old retry tests stayed green.
        snapshot_terms: TERMS,
        send_config: { create: { deposit_required: true, deposit_percentage: 50, deposit_amount: 500, payment_methods: SENT_WITH as never } },
      },
    });
    await db.invoice.create({
      data: {
        id: deposit, organization_id: org, customer_id: customer, estimate_id: estimate, kind: 'DEPOSIT',
        invoice_number: `D-${tag}`, status: 'SENT', subtotal: 500, tax_amount: 0, total_amount: 500,
        amount_due: 500, public_token: `dep-${tag}`,
      },
    });
    return { org, tag, user, estimate, deposit, number: `E-${tag}`, estimateToken: `est-${tag}`, depositToken: `dep-${tag}`, creator: `creator-${tag}@example.test` };
  }
  type Fixture = Awaited<ReturnType<typeof sentEstimate>>;

  const sign = (f: Fixture, method: string) =>
    request(app).post(`/api/estimates/${f.estimate}/approve?token=${f.estimateToken}`).send({ payment_method: method, signature_data: SIGNATURE, terms_accepted: true });
  /** What the signed page sends for a manual pick: the method, no signature, no terms flag. */
  const pickAfterSigning = (f: Fixture, method: string) =>
    request(app).post(`/api/estimates/${f.estimate}/approve?token=${f.estimateToken}`).send({ payment_method: method });
  const payByDoor = (f: Fixture, method: 'card' | 'bank') =>
    request(app).post(`/api/invoices/${f.deposit}/public/checkout?token=${f.depositToken}`).send({ method, expected_amount: 500, return_to: 'estimate' });
  const stored = async (f: Fixture) => (await db.estimate.findUniqueOrThrow({ where: { id: f.estimate }, select: { deposit_method: true, deposit_method_at: true } }));
  /** The estimate Owner's in-app deposit method alerts, oldest first: a first pick, or a change. */
  const ownerAlerts = async (f: Fixture) => (await db.notification.findMany({
    where: { organization_id: f.org, verb: 'estimate.deposit_method_selected', object_id: f.estimate, recipients: { some: { recipient_id: f.user } } },
    orderBy: { created_at: 'asc' },
  })).map((n) => ({ title: n.title, body: n.body, ...(n.data as { method?: string; previous_method?: string | null }) }));
  const officeAlerts = async (f: Fixture) => {
    const all = await ownerAlerts(f);
    return { selected: all.filter((a) => !a.previous_method), changed: all.filter((a) => a.previous_method) };
  };
  /** Every email the office's Owner was sent, by any sender: a deposit method pick sends none (Ran 2026-11-04). */
  const officeEmails = (f: Fixture) => Object.values(emailModule)
    .filter((fn) => vi.isMockFunction(fn))
    .flatMap((fn) => (fn as unknown as { mock: { calls: unknown[][] } }).mock.calls)
    .filter((args) => JSON.stringify(args).includes(f.creator));
  const customerMails = (f: Fixture) => vi.mocked(sendEstimateApprovedNotification).mock.calls.filter(([p]) => p.estimateNumber === f.number);
  const picks = (f: Fixture) => db.auditLog.findMany({
    where: { org_id: f.org, action: 'estimate.deposit_method_selected', resource_type: 'Estimate', resource_id: f.estimate },
    orderBy: { created_at: 'asc' },
  });
  /** Every write of a deposit method onto this estimate throws, as a lost database write would. */
  const failMethodWrites = (f: Fixture) => {
    const original = db.estimate.update.bind(db.estimate);
    return vi.spyOn(db.estimate, 'update').mockImplementation(((args: { where: { id?: string }; data: Record<string, unknown> }) =>
      args.where.id === f.estimate && 'deposit_method' in args.data
        ? Promise.reject(new Error('forced: the deposit method write failed'))
        : original(args as never)) as never);
  };
  const changeRows = async (f: Fixture) => (await picks(f)).filter((r) => (r.metadata as { previous_method?: string | null }).previous_method);
  const activityLines = (f: Fixture) => db.timelineEvent.findMany({ where: { organization_id: f.org, entity_id: f.estimate, event_type: 'DEPOSIT_PAYMENT_METHOD_SELECTED' }, orderBy: { created_at: 'asc' } });

  /**
   * The processor reports the newest checkout session complete, the way it delivers it: a card
   * session paid, or a bank session whose debit has started (it clears days later).
   */
  let eventSeq = 0;
  async function processorCompletes(f: Fixture, method: 'card' | 'bank') {
    const session = processor.sessions[processor.sessions.length - 1]!;
    const intent = `pi_2980_${f.tag}_${++eventSeq}`;
    processor.retrievePaymentIntent.mockResolvedValue({
      id: intent,
      latest_charge: {
        id: `ch_2980_${f.tag}_${eventSeq}`, object: 'charge', created: 1789990000, amount: 50000,
        payment_method_details: method === 'card'
          ? { type: 'card', card: { brand: 'visa', last4: '4242' } }
          : { type: 'us_bank_account', us_bank_account: { bank_name: 'TEST BANK', last4: '6789' } },
      },
    });
    const event = {
      id: `evt_2980_${f.tag}_${eventSeq}`, object: 'event', api_version: '2025-02-24.acacia', type: 'checkout.session.completed',
      created: 1790000100, account: `acct_2980_${f.tag}`,
      data: {
        object: {
          id: session.id, object: 'checkout.session', mode: 'payment', status: 'complete',
          payment_status: method === 'card' ? 'paid' : 'unpaid',
          payment_method_types: method === 'card' ? ['card'] : ['us_bank_account'],
          payment_intent: intent, amount_total: 50000, currency: 'usd', metadata: session.params.metadata,
        },
      },
    };
    const hook = await request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json')
      .set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
    expect(hook.status).toBe(200);
    expect((await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } })).status).toBe('WON');
  }

  // Ruling Q17: the customer's signed-estimate email goes ONCE per signing, whichever way the
  // deposit is paid. A manual method at signing sends it then; a card or bank signing sends it when
  // the payment completes. The office's approval alerts are not this email and are unchanged.
  const ONCE: Array<{ name: string; steps: (f: Fixture) => Promise<void> }> = [
    {
      name: 'Check at signing, then card through the deposit door, paid',
      steps: async (f) => {
        expect((await sign(f, 'CHECK')).status).toBe(200);
        await vi.waitFor(() => expect(customerMails(f)).toHaveLength(1));
        expect((await payByDoor(f, 'card')).status).toBe(200);
        await processorCompletes(f, 'card');
      },
    },
    {
      name: 'Check at signing, then bank through the deposit door, the debit started',
      steps: async (f) => {
        expect((await sign(f, 'CHECK')).status).toBe(200);
        await vi.waitFor(() => expect(customerMails(f)).toHaveLength(1));
        expect((await payByDoor(f, 'bank')).status).toBe(200);
        await processorCompletes(f, 'bank');
      },
    },
    {
      name: 'Check at signing, Zelle later, then card through the deposit door, paid',
      steps: async (f) => {
        expect((await sign(f, 'CHECK')).status).toBe(200);
        await vi.waitFor(() => expect(customerMails(f)).toHaveLength(1));
        expect((await pickAfterSigning(f, 'ZELLE')).status).toBe(200);
        expect((await payByDoor(f, 'card')).status).toBe(200);
        await processorCompletes(f, 'card');
      },
    },
    {
      // #2979's journey: the copy comes from the payment, since the signing sent none.
      name: 'card at signing, backed out, card again from the estimate page, paid',
      steps: async (f) => {
        expect((await sign(f, 'CARD')).status).toBe(200);
        expect((await payByDoor(f, 'card')).status).toBe(200);
        await processorCompletes(f, 'card');
      },
    },
    {
      name: 'card at signing, then Check, then card through the deposit door, paid',
      steps: async (f) => {
        expect((await sign(f, 'CARD')).status).toBe(200);
        expect((await pickAfterSigning(f, 'CHECK')).status).toBe(200);
        expect((await payByDoor(f, 'card')).status).toBe(200);
        await processorCompletes(f, 'card');
      },
    },
  ];
  it.each(ONCE.map((c) => [c.name, c] as const))('the customer gets the signed-estimate email once: %s', async (_name, c) => {
    const f = await sentEstimate();
    await c.steps(f);
    await vi.waitFor(() => expect(customerMails(f).length).toBeGreaterThan(0));
    await settle();
    expect(customerMails(f)).toHaveLength(1);
    expect(customerMails(f)[0][0]).toMatchObject({ to: `pat-${f.tag}@example.test` });
    // The office still hears of the approval the payment made (unchanged by the once rule).
    const approved = await db.auditLog.findMany({ where: { org_id: f.org, action: 'estimate.approved', resource_id: f.estimate } });
    expect(approved).toHaveLength(1);
    const bell = await db.notification.findMany({ where: { organization_id: f.org, dedup_key: `estimate.approved:${f.estimate}` } });
    expect(bell.length).toBeGreaterThan(0);
  });

  it('the journey: check at signing, Zelle later, Zelle again - two office alerts, no office email, one customer email, the choice shown on return', async () => {
    const f = await sentEstimate();

    // 1. Sign and pick Check: stored, the Owner's in-app alert in History's words, the signed-estimate email.
    expect((await sign(f, 'CHECK')).status).toBe(200);
    expect((await stored(f)).deposit_method).toBe('CHECK');
    await vi.waitFor(async () => {
      expect((await officeAlerts(f)).selected).toHaveLength(1);
      expect(customerMails(f)).toHaveLength(1);
    });
    expect((await officeAlerts(f)).selected[0]).toMatchObject({
      method: 'CHECK', previous_method: null,
      title: `Customer chose Check for the deposit on ${f.number}`,
      body: 'Watch for incoming payment before marking the deposit as received.',
    });

    // 2. Back later: the public read returns the stored method, so the page shows its instructions.
    const page = await request(app).get(`/api/estimates/${f.estimate}/public?token=${f.estimateToken}`);
    expect(page.status).toBe(200);
    expect(page.body.estimate).toMatchObject({ status: 'PENDING', deposit_method: 'CHECK' });

    // 3. Pay another way: Zelle, from the signed page (no signature, no terms flag). Proceeds.
    const firstChange = await pickAfterSigning(f, 'ZELLE');
    expect(firstChange.status, JSON.stringify(firstChange.body)).toBe(200);
    expect(firstChange.body.estimate).toMatchObject({ status: 'PENDING', deposit_method: 'ZELLE' });
    expect((await stored(f)).deposit_method).toBe('ZELLE');
    await vi.waitFor(async () => expect((await officeAlerts(f)).changed).toHaveLength(1));
    expect((await officeAlerts(f)).changed[0]).toMatchObject({
      previous_method: 'CHECK', method: 'ZELLE',
      title: `Customer changed the deposit method on ${f.number} from Check to Zelle`,
      body: 'Watch for incoming payment before marking the deposit as received.',
    });

    // 4. Zelle again: stored as it was, nothing sent, nothing written.
    const at = (await stored(f)).deposit_method_at;
    expect((await pickAfterSigning(f, 'ZELLE')).status).toBe(200);
    await settle();
    expect((await stored(f)).deposit_method_at?.toISOString()).toBe(at?.toISOString());

    // Two office alerts in all and no office email; the customer's signed-estimate email once, at signing.
    expect((await officeAlerts(f)).selected).toHaveLength(1);
    expect((await officeAlerts(f)).changed).toHaveLength(1);
    expect(officeEmails(f)).toEqual([]);
    expect(customerMails(f)).toHaveLength(1);

    // History names each pick by its codes, which the drawer words; two rows, not three.
    const rows = await picks(f);
    expect(rows.map((r) => r.metadata)).toEqual([
      expect.objectContaining({ method: 'CHECK', previous_method: null }),
      expect.objectContaining({ method: 'ZELLE', previous_method: 'CHECK' }),
    ]);
    // The dashboard's activity line is words, never a code.
    const lines = await db.timelineEvent.findMany({ where: { organization_id: f.org, entity_id: f.estimate, event_type: 'DEPOSIT_PAYMENT_METHOD_SELECTED' }, orderBy: { created_at: 'asc' } });
    expect(lines.map((l) => l.description)).toEqual([
      `Customer chose Check for the deposit on ${f.number}`,
      `Customer changed the deposit method on ${f.number} from Check to Zelle`,
    ]);

    // The signature on file is the one captured at signing, untouched by the retries.
    const signedRow = await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } });
    expect(signedRow.status).toBe('PENDING');
    expect(signedRow.terms_accepted).toBe(true);
  });

  it('card at signing, checkout left unpaid, then Check: a change from card, and the signed copy goes at that confirm (once)', async () => {
    const f = await sentEstimate();
    expect((await sign(f, 'CARD')).status).toBe(200);
    expect((await stored(f)).deposit_method).toBe('CARD');
    await settle();
    // A first pick of card at signing alerts the office of nothing, and sends no signed copy: the payment would.
    expect((await officeAlerts(f))).toEqual({ selected: [], changed: [] });
    expect(customerMails(f)).toHaveLength(0);

    expect((await pickAfterSigning(f, 'CHECK')).status).toBe(200);
    expect((await stored(f)).deposit_method).toBe('CHECK');
    await vi.waitFor(async () => expect((await officeAlerts(f)).changed).toHaveLength(1));
    expect((await officeAlerts(f)).changed[0]).toMatchObject({ previous_method: 'CARD', method: 'CHECK' });
    expect((await officeAlerts(f)).selected).toHaveLength(0);
    // Ran 2026-11-04: "once" beats "never on a retry" - the card signing sent nothing, so this confirm sends it.
    await vi.waitFor(() => expect(customerMails(f)).toHaveLength(1));
    expect(customerMails(f)[0][0]).toMatchObject({ to: `pat-${f.tag}@example.test` });

    // Another manual pick on the same signing sends no second copy.
    expect((await pickAfterSigning(f, 'ZELLE')).status).toBe(200);
    await settle();
    expect(customerMails(f)).toHaveLength(1);
    expect(officeEmails(f)).toEqual([]);
  });

  // Ran 2026-11-04 (with the conductor's reading of "History names the method"): a first card or
  // bank pick names its method in History, beside "Customer started deposit checkout", and alerts
  // no one - the payment confirms itself.
  it('a first card pick at signing: History names the method beside the checkout line, no alert', async () => {
    const f = await sentEstimate();
    expect((await sign(f, 'CARD')).status).toBe(200);
    await vi.waitFor(async () => expect(await picks(f)).toHaveLength(1));
    expect((await picks(f))[0]!.metadata).toMatchObject({ method: 'CARD', previous_method: null, via: 'stripe_checkout' });
    const started = await db.auditLog.findMany({ where: { org_id: f.org, action: 'estimate.deposit_checkout_started', resource_id: f.estimate } });
    expect(started).toHaveLength(1);
    await vi.waitFor(async () => expect((await activityLines(f)).map((l) => l.description)).toEqual([`Customer chose Credit/Debit Card for the deposit on ${f.number}`]));
    await settle();
    expect(await ownerAlerts(f)).toEqual([]);
  });

  it('a first bank pick through the deposit door, nothing on file (signed before the release): History names it as a first pick, no alert', async () => {
    const f = await sentEstimate();
    // An estimate signed by card before the release: signed, Pending, no method stored, no pick in History.
    const signedAt = new Date(Date.now() - 3_600_000);
    await db.estimate.update({
      where: { id: f.estimate },
      data: { status: 'PENDING', signature_data: SIGNATURE, signature_at: signedAt, terms_accepted: true, terms_accepted_at: signedAt },
    });

    expect((await payByDoor(f, 'bank')).status).toBe(200);
    expect((await stored(f)).deposit_method).toBe('ACH');
    await vi.waitFor(async () => expect(await picks(f)).toHaveLength(1));
    expect((await picks(f))[0]!.metadata).toMatchObject({ method: 'ACH', previous_method: null, via: 'deposit_checkout' });
    await vi.waitFor(async () => expect((await activityLines(f)).map((l) => l.description)).toEqual([`Customer chose Bank Account for the deposit on ${f.number}`]));
    await settle();
    expect(await ownerAlerts(f)).toEqual([]);
  });

  it('an estimate signed with Check before the release (its copy went then): a later pick and the payment send no second copy', async () => {
    const f = await sentEstimate();
    const signedAt = new Date(Date.now() - 3_600_000);
    // The row as the old approval door left it: signed, Pending, no stored method, and its pick row without a method code.
    await db.estimate.update({
      where: { id: f.estimate },
      data: { status: 'PENDING', signature_data: SIGNATURE, signature_at: signedAt, terms_accepted: true, terms_accepted_at: signedAt },
    });
    await db.auditLog.create({
      data: { org_id: f.org, actor_id: null, action: 'estimate.deposit_method_selected', resource_type: 'Estimate', resource_id: f.estimate, metadata: { via: 'manual_method' }, created_at: new Date(signedAt.getTime() + 500) },
    });

    expect((await pickAfterSigning(f, 'ZELLE')).status).toBe(200);
    // Ran 2026-11-04: nothing on file, so this counts as a first pick.
    await vi.waitFor(async () => expect((await officeAlerts(f)).selected).toHaveLength(1));
    expect((await payByDoor(f, 'card')).status).toBe(200);
    await processorCompletes(f, 'card');
    await settle();
    expect(customerMails(f)).toHaveLength(0);
  });

  it('the signed copy is claimed once per signing, even when two doors ask at the same moment', async () => {
    const f = await sentEstimate();
    expect((await sign(f, 'CARD')).status).toBe(200);
    const { signature_at } = await db.estimate.findUniqueOrThrow({ where: { id: f.estimate }, select: { signature_at: true } });
    const claim = () => claimSignedCopy({ organizationId: f.org, estimateId: f.estimate, signatureAt: signature_at });
    const answers = await Promise.all([claim(), claim(), claim(), claim()]);
    expect(answers.filter(Boolean)).toHaveLength(1);
    // A new signing (voided and signed again) is its own claim.
    expect(await claimSignedCopy({ organizationId: f.org, estimateId: f.estimate, signatureAt: new Date(signature_at!.getTime() + 1000) })).toBe(true);
    // The claim never shows in History: it is not filed under the estimate.
    const history = await db.auditLog.findMany({ where: { org_id: f.org, resource_type: 'Estimate', resource_id: f.estimate, action: 'estimate.signed_copy_sent' } });
    expect(history).toHaveLength(0);
  });

  it('check, then card through the deposit door: stored, the office told once, History names both', async () => {
    const f = await sentEstimate();
    expect((await sign(f, 'CHECK')).status).toBe(200);
    expect((await payByDoor(f, 'card')).status).toBe(200);
    expect((await stored(f)).deposit_method).toBe('CARD');
    await vi.waitFor(async () => expect((await officeAlerts(f)).changed).toHaveLength(1));
    expect((await officeAlerts(f)).changed[0]).toMatchObject({ previous_method: 'CHECK', method: 'CARD' });

    // Card again through the door (a second try after backing out): nothing more.
    expect((await payByDoor(f, 'card')).status).toBe(200);
    await settle();
    expect((await officeAlerts(f)).changed).toHaveLength(1);
    const rows = await picks(f);
    expect(rows.map((r) => r.metadata)).toEqual([
      expect.objectContaining({ method: 'CHECK', previous_method: null }),
      expect.objectContaining({ method: 'CARD', previous_method: 'CHECK', via: 'deposit_checkout' }),
    ]);
  });

  // Code review cr1 (a status never claims success for a failure): when storing the pick fails,
  // the office is told nothing and History records no change - the row still holds the old method,
  // so announcing the new one would be a lie and the next click would announce it again.

  it('the deposit door: a card pick whose save fails tells the office nothing and records no change', async () => {
    const f = await sentEstimate();
    expect((await sign(f, 'CHECK')).status).toBe(200);
    await vi.waitFor(async () => expect((await officeAlerts(f)).selected).toHaveLength(1));
    await vi.waitFor(async () => expect(await activityLines(f)).toHaveLength(1));

    const spy = failMethodWrites(f);
    try {
      // The checkout is already handed out, so the customer still gets it.
      const res = await payByDoor(f, 'card');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(spy).toHaveBeenCalled();
      await settle();
    } finally {
      spy.mockRestore();
    }
    expect((await stored(f)).deposit_method).toBe('CHECK');
    expect((await officeAlerts(f)).changed).toHaveLength(0);
    expect(await changeRows(f)).toHaveLength(0);
    expect(await activityLines(f)).toHaveLength(1);

    // The next click, with the write working again, is the one change the office hears of.
    expect((await payByDoor(f, 'card')).status).toBe(200);
    await vi.waitFor(async () => expect((await officeAlerts(f)).changed).toHaveLength(1));
    expect((await officeAlerts(f)).changed[0]).toMatchObject({ previous_method: 'CHECK', method: 'CARD' });
    await vi.waitFor(async () => expect(await changeRows(f)).toHaveLength(1));
  });

  it('the approval door: a pick whose save fails is refused, tells the office nothing and records no change', async () => {
    const f = await sentEstimate();
    expect((await sign(f, 'CHECK')).status).toBe(200);
    await vi.waitFor(async () => expect((await officeAlerts(f)).selected).toHaveLength(1));
    await vi.waitFor(async () => expect(await activityLines(f)).toHaveLength(1));

    const spy = failMethodWrites(f);
    try {
      // Card from the signed page goes through approval's card branch (its retry).
      const res = await pickAfterSigning(f, 'CARD');
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalled();
      await settle();
    } finally {
      spy.mockRestore();
    }
    expect((await stored(f)).deposit_method).toBe('CHECK');
    expect((await officeAlerts(f)).changed).toHaveLength(0);
    expect(await changeRows(f)).toHaveLength(0);
    expect(await activityLines(f)).toHaveLength(1);
  });

  it('a FIRST approval without the terms flag is still refused, and writes nothing', async () => {
    const f = await sentEstimate();
    const res = await request(app)
      .post(`/api/estimates/${f.estimate}/approve?token=${f.estimateToken}`)
      .send({ payment_method: 'CHECK', signature_data: SIGNATURE });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Terms acceptance is required');
    const row = await db.estimate.findUniqueOrThrow({ where: { id: f.estimate } });
    expect(row).toMatchObject({ status: 'SENT', signature_data: null, deposit_method: null, deposit_method_at: null });
  });

  // Close every way in: every door a customer picks a deposit method through stores it.
  const DOORS: Array<{ name: string; run: (f: Fixture) => Promise<request.Response>; expected: string; signFirst?: string }> = [
    { name: 'approval at signing, card', run: (f) => sign(f, 'CARD'), expected: 'CARD' },
    { name: 'approval at signing, bank', run: (f) => sign(f, 'ACH'), expected: 'ACH' },
    { name: 'approval at signing, check', run: (f) => sign(f, 'CHECK'), expected: 'CHECK' },
    { name: 'approval at signing, card by phone', run: (f) => sign(f, 'EXTERNAL_CARD'), expected: 'EXTERNAL_CARD' },
    { name: 'approval retry, bank transfer', signFirst: 'CARD', run: (f) => pickAfterSigning(f, 'BANK_TRANSFER'), expected: 'BANK_TRANSFER' },
    { name: 'approval retry, card by phone', signFirst: 'CARD', run: (f) => pickAfterSigning(f, 'EXTERNAL_CARD'), expected: 'EXTERNAL_CARD' },
    { name: 'approval retry, card', signFirst: 'CHECK', run: (f) => pickAfterSigning(f, 'CARD'), expected: 'CARD' },
    { name: 'deposit door after signing, card', signFirst: 'ZELLE', run: (f) => payByDoor(f, 'card'), expected: 'CARD' },
    { name: 'deposit door after signing, bank', signFirst: 'ZELLE', run: (f) => payByDoor(f, 'bank'), expected: 'ACH' },
  ];
  it.each(DOORS.map((d) => [d.name, d] as const))('every door stores the pick: %s', async (_name, door) => {
    const f = await sentEstimate();
    if (door.signFirst) expect((await sign(f, door.signFirst)).status).toBe(200);
    const res = await door.run(f);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = await stored(f);
    expect(row.deposit_method).toBe(door.expected);
    expect(row.deposit_method_at).toBeInstanceOf(Date);
  });
});
