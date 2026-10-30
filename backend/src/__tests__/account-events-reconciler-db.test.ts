/* =============================================================================
   Payments go-live, slice 10 - account events go through the reconciler.

   account.updated reads the account back from the processor (never its payload) and stores what it
   says: the capability flags, and the accepted methods they imply. CARD is there while the card
   capability is active, ACH while the bank-debit capability is; each leaves when lost, without the
   owner touching settings. account.application.deauthorized disconnects the org and tells the owner.
   The webhook controller only verifies, resolves the org and hands over; no accepted-methods gate
   is left, so a restricted account's refund, dispute and bank-settlement events are still recorded.

   Events are posted to the real webhook route in the processor's payload shape for the pinned
   version. Real migrated database (TEST_DATABASE_URL); skips when unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
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

import type Stripe from 'stripe';
import { retrieveAccount } from '../lib/stripe';
import { sendPaymentsActionNeededEmail } from '../lib/email';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { refreshAccountStatus } from '../lib/account-status';

const suite = realClient ? describe : describe.skip;

/** The processor's account, as retrieved at the pinned API version. */
function processorAccount(id: string, over: {
  card?: string; ach?: string; charges?: boolean; payouts?: boolean; due?: string[]; disabled?: string | null; details?: boolean;
} = {}): Stripe.Account {
  return {
    id, object: 'account',
    charges_enabled: over.charges ?? true, payouts_enabled: over.payouts ?? true, details_submitted: over.details ?? true,
    capabilities: {
      card_payments: over.card ?? 'active',
      us_bank_account_ach_payments: over.ach ?? 'active',
      transfers: 'active',
    },
    requirements: { currently_due: over.due ?? [], eventually_due: [], past_due: [], disabled_reason: over.disabled ?? null },
    controller: { stripe_dashboard: { type: 'none' }, fees: { payer: 'account' }, losses: { payments: 'stripe' }, requirement_collection: 'stripe' },
  } as unknown as Stripe.Account;
}

suite('account events through the reconciler (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  let app: Parameters<typeof request>[0];
  const mutableEnv = env as unknown as { STRIPE_SECRET_KEY?: string };
  beforeAll(async () => {
    app = (await import('../app.js')).default as unknown as Parameters<typeof request>[0];
    mutableEnv.STRIPE_SECRET_KEY = 'sk_test_pay10';
  });
  beforeEach(() => {
    vi.mocked(retrieveAccount).mockReset();
    vi.mocked(sendPaymentsActionNeededEmail).mockClear();
  });

  /** An org with a connected account and an admin; the methods it accepts today. */
  async function connectedOrg(opts: { accepts?: string[]; charges?: boolean; payouts?: boolean } = {}) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const account = `acct_pay10_${tag}`;
    await db.organization.create({
      data: {
        id: org, name: `pay10-${tag}`, email: `pay10-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        stripe_account_id: account,
        accepted_payment_methods: (opts.accepts ?? []) as never,
        stripe_charges_enabled: opts.charges ?? false, stripe_payouts_enabled: opts.payouts ?? false,
      },
    });
    await db.user.create({
      data: { id: randomUUID(), organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' },
    });
    let seq = 0;
    /** Post one event to the webhook route, the way the processor delivers it. */
    const deliver = async (type: string, object: object, opts2: { id?: string; account?: string; status?: number } = {}) => {
      const event = {
        id: opts2.id ?? `evt_pay10_${tag}_${++seq}`, object: 'event', api_version: '2025-02-24.acacia',
        type, created: 1790000000, account: opts2.account ?? account, data: { object },
      };
      const res = await request(app)
        .post('/api/webhooks/stripe')
        .set('Content-Type', 'application/json')
        .set('stripe-signature', 'test_sig')
        .send(Buffer.from(JSON.stringify(event)));
      expect(res.status).toBe(opts2.status ?? 200);
      return res;
    };
    /** The processor says this about the account when it is read back. */
    const processorSays = (over: Parameters<typeof processorAccount>[1] = {}) =>
      vi.mocked(retrieveAccount).mockResolvedValue(processorAccount(account, over));
    const updated = (opts2: { id?: string; status?: number } = {}) =>
      // The payload is the account as it was when the event was created: stale by design here
      // (everything off), so a handler trusting it would be caught.
      deliver('account.updated', { id: account, object: 'account', charges_enabled: false, payouts_enabled: false, capabilities: {} }, opts2);
    const readOrg = () => db.organization.findUniqueOrThrow({ where: { id: org } });
    const notifications = (verb: string) => db.notification.findMany({ where: { organization_id: org, verb } });
    const recorded = (eventId: string) => db.stripeEvent.count({ where: { stripe_event_id: eventId } });
    return { org, tag, account, deliver, processorSays, updated, readOrg, notifications, recorded };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM disputes WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      for (const table of ['timeline_events', 'notifications', 'invoices']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
      for (const table of ['customers', 'users']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_pay10_%'`));
    delete mutableEnv.STRIPE_SECRET_KEY;
    await db.$disconnect();
  });

  it('onboarding completes: CARD and ACH join the accepted methods when their capabilities turn active, not before; flags stored, the owner told once', async () => {
    const f = await connectedOrg({ accepts: ['CHECK'] });
    // Details submitted and charges on, but the processor is still reviewing both capabilities.
    f.processorSays({ card: 'pending', ach: 'pending' });
    await f.updated();
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['CHECK']);

    f.processorSays({ card: 'active', ach: 'active' });
    await f.updated({ id: `evt_pay10_${f.tag}_onboarded` });

    const org = await f.readOrg();
    expect(org.accepted_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);
    expect(org).toMatchObject({
      stripe_charges_enabled: true, stripe_payouts_enabled: true, stripe_details_submitted: true,
      stripe_requirements_due: [], stripe_disabled_reason: null,
      // The owner's default offers are not the sync's to write.
      card_offered_by_default: true, bank_offered_by_default: true,
    });
    expect(retrieveAccount).toHaveBeenCalledWith(f.account);
    expect(await f.notifications('billing.payments_activated')).toHaveLength(1);
    expect(await f.notifications('billing.payouts_activated')).toHaveLength(1);
    expect(await f.recorded(`evt_pay10_${f.tag}_onboarded`)).toBe(1);
  });

  // The onboarding return (/settings/payments?onboarding=return) runs the status refresh before any
  // event arrives; it follows the same capability rule.
  it('the onboarding-return refresh adds CARD and ACH only once their capabilities are active; the owner defaults stay on', async () => {
    const f = await connectedOrg({ accepts: ['EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH'] });
    f.processorSays({ card: 'pending', ach: 'pending' });
    await refreshAccountStatus(f.org);
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH']);

    f.processorSays({ card: 'active', ach: 'active' });
    const result = await refreshAccountStatus(f.org);

    expect(result).toEqual({ outcome: 'refreshed', stripe_charges_enabled: true });
    const org = await f.readOrg();
    expect(org.accepted_payment_methods).toEqual(['EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH', 'CARD', 'ACH']);
    expect(org).toMatchObject({ card_offered_by_default: true, bank_offered_by_default: true });
  });

  it('deauthorized: the org is disconnected and cannot take payments, CARD and ACH leave, the owner is told once', async () => {
    const f = await connectedOrg({ accepts: ['CHECK', 'CARD', 'ACH'], charges: true, payouts: true });

    await f.deliver('account.application.deauthorized', { id: 'ca_platform', object: 'application' });

    const org = await f.readOrg();
    expect(org.accepted_payment_methods).toEqual(['CHECK']);
    expect(org).toMatchObject({
      stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_details_submitted: false,
      stripe_requirements_due: [], stripe_disabled_reason: 'deauthorized',
    });
    // A pure teardown: the account is no longer ServWave's to read.
    expect(retrieveAccount).not.toHaveBeenCalled();
    const [notice, ...more] = await f.notifications('billing.payments_disconnected');
    expect(more).toHaveLength(0);
    expect(notice).toMatchObject({ actor_id: null, object_type: 'ORGANIZATION', needs_action: true });
    expect(notice.title).not.toMatch(/stripe/i);

    // Delivered again under another event id: still one notice.
    await f.deliver('account.application.deauthorized', { id: 'ca_platform', object: 'application' });
    expect(await f.notifications('billing.payments_disconnected')).toHaveLength(1);
  });

  // Conductor note from slice 06: the status refresh reads the account, then writes. An
  // account.updated landing between that read and that write used to be overwritten by the older
  // snapshot. A writer now writes only if no other write landed while it waited for its answer;
  // otherwise it asks again, so an older answer is never stored over a newer one.
  it('a refresh that read the account before an account.updated never overwrites the newer state the event stored', async () => {
    const f = await connectedOrg({ accepts: ['CHECK'] });
    let processorNow = processorAccount(f.account, { card: 'inactive', ach: 'inactive', charges: false, payouts: false });
    let releaseRefreshRead!: () => void;
    const refreshReadHeld = new Promise<void>((resolve) => { releaseRefreshRead = resolve; });
    let refreshReadStarted!: () => void;
    const refreshReading = new Promise<void>((resolve) => { refreshReadStarted = resolve; });
    let calls = 0;
    vi.mocked(retrieveAccount).mockImplementation(async () => {
      const answer = processorNow; // what the processor says at the moment it is asked
      if (++calls === 1) {
        refreshReadStarted();
        await refreshReadHeld; // the refresh's answer is slow to come back
      }
      return answer;
    });

    // The refresh asks first, while the account cannot take payments yet...
    const refresh = refreshAccountStatus(f.org);
    await refreshReading;
    // ...then onboarding completes, and the account.updated event arrives and is handled.
    processorNow = processorAccount(f.account, { card: 'active', ach: 'active' });
    const event = f.updated();
    // Give the event time to run (or to wait its turn), then let the refresh's old answer through.
    await new Promise((resolve) => setTimeout(resolve, 300));
    releaseRefreshRead();
    await Promise.all([refresh, event]);

    const org = await f.readOrg();
    expect(org).toMatchObject({ stripe_charges_enabled: true, stripe_payouts_enabled: true });
    expect(org.accepted_payment_methods).toEqual(['CHECK', 'CARD', 'ACH']);
  });

  // A slow processor answer must not hold a database connection, or a lock other writers of the
  // account wait on: the read happens outside any transaction. A writer that commits while it is
  // outstanding sends the reader round again, so the older answer is still never stored.
  it('a deauthorization arriving while a refresh waits on a slow processor answer is handled at once, and the refresh does not undo it', async () => {
    const f = await connectedOrg({ accepts: ['CHECK', 'CARD', 'ACH'], charges: true, payouts: true });
    let deauthDone = false;
    let deauthHandled!: () => void;
    const deauthFinished = new Promise<void>((resolve) => { deauthHandled = resolve; });
    let refreshReadStarted!: () => void;
    const refreshReading = new Promise<void>((resolve) => { refreshReadStarted = resolve; });
    let deauthDoneDuringRead = false;
    let calls = 0;
    vi.mocked(retrieveAccount).mockImplementation(async () => {
      if (++calls === 1) {
        const answer = processorAccount(f.account); // active, as it was when asked
        refreshReadStarted();
        // The answer is slow: it comes back once the deauthorization is handled, or after 3s.
        await Promise.race([deauthFinished, new Promise((resolve) => setTimeout(resolve, 3000))]);
        deauthDoneDuringRead = deauthDone;
        return answer;
      }
      // The platform can no longer read an account that disconnected from it.
      throw Object.assign(new Error('no access to account'), { code: 'account_invalid' });
    });

    const refresh = refreshAccountStatus(f.org);
    await refreshReading;
    await f.deliver('account.application.deauthorized', { id: 'ca_platform', object: 'application' });
    deauthDone = true;
    deauthHandled();
    await refresh;

    expect(deauthDoneDuringRead).toBe(true);
    const org = await f.readOrg();
    expect(org).toMatchObject({ stripe_charges_enabled: false, stripe_payouts_enabled: false, stripe_disabled_reason: 'deauthorized' });
    expect(org.accepted_payment_methods).toEqual(['CHECK']);
  }, 15_000);

  it('the card capability lost: CARD leaves the accepted methods; the owner keeps the methods they chose; it comes back when active again', async () => {
    const f = await connectedOrg({ accepts: ['CHECK', 'CARD', 'ACH'], charges: true, payouts: true });

    f.processorSays({ card: 'inactive', ach: 'active' });
    await f.updated();
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['CHECK', 'ACH']);

    f.processorSays({ card: 'active', ach: 'inactive' });
    await f.updated();
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['CHECK', 'CARD']);
  });

  it('requirements due: the owner gets one action-needed notice and one email, however often the same requirements are delivered', async () => {
    const f = await connectedOrg({ accepts: ['CARD'], charges: true, payouts: true });
    f.processorSays({ due: ['individual.verification.document'] });

    await f.updated();
    await f.updated();

    const [notice, ...more] = await f.notifications('billing.payments_action_needed');
    expect(more).toHaveLength(0);
    expect(notice).toMatchObject({ needs_action: true, dedup_key: `billing.payments_action_needed:action:${f.account}:individual.verification.document` });
    expect(notice.title).not.toMatch(/stripe/i);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledTimes(1);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledWith(expect.objectContaining({ organizationId: f.org, to: `admin-${f.tag}@example.test` }));
    expect((await f.readOrg()).stripe_requirements_due).toEqual(['individual.verification.document']);
  });

  it('a paused account: card payments off, CARD leaves, the owner gets a paused notice and an email', async () => {
    const f = await connectedOrg({ accepts: ['CARD'], charges: true, payouts: true });
    f.processorSays({ charges: false, payouts: false, disabled: 'requirements.past_due' });

    await f.updated();

    const org = await f.readOrg();
    expect(org).toMatchObject({ stripe_charges_enabled: false, stripe_disabled_reason: 'requirements.past_due' });
    expect(org.accepted_payment_methods).toEqual([]);
    const [notice] = await f.notifications('billing.payments_paused');
    expect(notice.title).not.toMatch(/stripe/i);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledTimes(1);
  });

  it('an account that both needs action and is paused: both notices, but each admin gets one email, not two', async () => {
    const f = await connectedOrg({ accepts: ['CARD'], charges: true, payouts: true });
    f.processorSays({ charges: false, payouts: false, due: ['individual.verification.document'], disabled: 'requirements.past_due' });

    await f.updated();

    expect(await f.notifications('billing.payments_action_needed')).toHaveLength(1);
    expect(await f.notifications('billing.payments_paused')).toHaveLength(1);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledTimes(1);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledWith(expect.objectContaining({ organizationId: f.org, to: `admin-${f.tag}@example.test` }));
  });

  it('the status refresh tells the owner about requirements due too; the account.updated seeing the same answer adds no second notice or email', async () => {
    const f = await connectedOrg({ accepts: [] });
    f.processorSays({ due: ['external_account'] });

    // The onboarding return (or the nightly run) sees the account first.
    await refreshAccountStatus(f.org);
    expect(await f.notifications('billing.payments_action_needed')).toHaveLength(1);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledTimes(1);

    await f.updated();

    expect(await f.notifications('billing.payments_action_needed')).toHaveLength(1);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledTimes(1);
    expect(await f.notifications('billing.payments_activated')).toHaveLength(1);
    expect(await f.notifications('billing.payouts_activated')).toHaveLength(1);
  });

  // Slice 32 (conductor ruling 2026-10-08): a first-time owner got ten "needs one more thing" and two
  // "paused" interrupts, with admin emails, during one onboarding. Zero until it is finished.
  it('first-time onboarding: a run of account.updated events that change the requirements each step tells the owner nothing', async () => {
    const f = await connectedOrg({ accepts: [] });
    const steps = [
      ['business_profile.url', 'external_account', 'individual.verification.document'],
      ['external_account', 'individual.verification.document'],
      ['individual.verification.document'],
    ];

    for (const due of steps) {
      f.processorSays({ details: false, charges: false, payouts: false, due, disabled: 'requirements.past_due' });
      await f.updated();
    }

    expect(await f.notifications('billing.payments_action_needed')).toHaveLength(0);
    expect(await f.notifications('billing.payments_paused')).toHaveLength(0);
    expect(sendPaymentsActionNeededEmail).not.toHaveBeenCalled();
    expect((await f.readOrg()).stripe_requirements_due).toEqual(['individual.verification.document']);
  });

  it('once details are submitted, a requirement the owner must fix is one notice in ServWave words, with one email and a link to Settings', async () => {
    const f = await connectedOrg({ accepts: [] });
    f.processorSays({ details: false, charges: false, payouts: false, due: ['individual.verification.document'], disabled: 'requirements.past_due' });
    await f.updated();

    f.processorSays({ details: true, charges: false, payouts: false, due: ['individual.verification.document'], disabled: 'requirements.past_due' });
    await f.updated();
    await f.updated();

    const [notice, ...more] = await f.notifications('billing.payments_action_needed');
    expect(more).toHaveLength(0);
    expect(notice.data).toMatchObject({ link_path: '/settings/payout-account' });
    expect(notice.body).toMatch(/Settings > Payments/);
    expect(notice.body).toMatch(/identity/i);
    expect(notice.body).not.toMatch(/individual\.|verification\.document|stripe/i);
    expect(sendPaymentsActionNeededEmail).toHaveBeenCalledTimes(1);
  });

  it('the processor still checking what was submitted is not an interruption', async () => {
    const f = await connectedOrg({ accepts: [] });
    f.processorSays({ details: true, charges: false, payouts: false, disabled: 'requirements.pending_verification' });

    await f.updated();

    expect(await f.notifications('billing.payments_paused')).toHaveLength(0);
    expect(sendPaymentsActionNeededEmail).not.toHaveBeenCalled();
  });

  it('a replayed event id changes nothing and is answered as a duplicate', async () => {
    const f = await connectedOrg({ accepts: ['CHECK', 'CARD', 'ACH'], charges: true, payouts: true });
    f.processorSays({ card: 'inactive' });
    await f.updated({ id: `evt_pay10_${f.tag}_once` });
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['CHECK', 'ACH']);
    f.processorSays();

    const res = await f.updated({ id: `evt_pay10_${f.tag}_once` });

    expect(res.body).toEqual({ received: true, duplicate: true });
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['CHECK', 'ACH']);
    expect(await f.recorded(`evt_pay10_${f.tag}_once`)).toBe(1);
  });

  // Payments go-live slice 37: a processed account event used to leave no app log line (only the
  // response size told processed from duplicate).
  it('a reconciled account event leaves one info line with the org, the event type, the outcome and the event id; a replay adds none', async () => {
    const f = await connectedOrg({ accepts: ['CHECK'] });
    f.processorSays({ card: 'active', ach: 'active' });
    const info = vi.spyOn(logger, 'info');
    const lines = () => info.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('account event') && l.includes(f.org));

    await f.updated({ id: `evt_pay10_${f.tag}_logged` });
    await f.updated({ id: `evt_pay10_${f.tag}_logged` });

    // The replay is answered as a duplicate before the reconciler runs: no second line.
    expect(lines()).toEqual([`Reconciler: account event account.updated evt_pay10_${f.tag}_logged for org ${f.org}: refreshed`]);
    info.mockRestore();
  });

  // Carried over from the mocked webhook.test.ts case this slice deleted ("records the event and
  // returns 200 ... when no org matches the connected account"): it guards behaviour the old handler
  // already had, so it passes on the old code by design.
  it('an account ServWave does not know (another environment on the same sandbox) is recorded and touches nothing', async () => {
    const f = await connectedOrg({ accepts: ['CHECK'] });
    f.processorSays();

    await f.deliver('account.updated', { id: 'acct_elsewhere', object: 'account' }, { id: `evt_pay10_${f.tag}_elsewhere`, account: 'acct_elsewhere' });

    expect(retrieveAccount).not.toHaveBeenCalled();
    expect((await f.readOrg()).accepted_payment_methods).toEqual(['CHECK']);
    expect(await f.recorded(`evt_pay10_${f.tag}_elsewhere`)).toBe(1);
  });

  it('a processor outage is retried (nothing written, not recorded), but an answer that the account cannot be read fails closed: cards off, CARD and ACH leave', async () => {
    const f = await connectedOrg({ accepts: ['CHECK', 'CARD', 'ACH'], charges: true, payouts: true });
    const { default: Stripe } = await import('stripe');
    vi.mocked(retrieveAccount).mockRejectedValueOnce(new Stripe.errors.StripeAPIError({ message: 'processor unavailable', statusCode: 500 } as never));

    await f.updated({ id: `evt_pay10_${f.tag}_outage`, status: 500 });
    expect(await f.recorded(`evt_pay10_${f.tag}_outage`)).toBe(0);
    expect(await f.readOrg()).toMatchObject({ stripe_charges_enabled: true, accepted_payment_methods: ['CHECK', 'CARD', 'ACH'] });

    // Re-delivered, the processor now answers about the account itself: ServWave cannot read it.
    vi.mocked(retrieveAccount).mockRejectedValueOnce(new Stripe.errors.StripePermissionError({
      type: 'invalid_request_error', code: 'account_invalid', message: 'The provided key does not have access to account',
    } as never));
    await f.updated({ id: `evt_pay10_${f.tag}_outage` });

    expect(await f.recorded(`evt_pay10_${f.tag}_outage`)).toBe(1);
    expect(await f.readOrg()).toMatchObject({ stripe_charges_enabled: false, stripe_payouts_enabled: false, accepted_payment_methods: ['CHECK'] });
  });

  // Slice 19 conductor note: with CARD now leaving the accepted methods when charges go off, the
  // money events of a restricted account must still be recorded. No accepted-methods gate is left.
  describe('a restricted account (charges off, CARD and ACH gone) still has its money events recorded', () => {
    async function restricted() {
      const f = await connectedOrg({ accepts: ['CARD', 'ACH'], charges: true, payouts: true });
      f.processorSays({ charges: false, payouts: false, disabled: 'requirements.past_due' });
      await f.updated();
      expect((await f.readOrg()).accepted_payment_methods).toEqual([]);
      const customer = randomUUID();
      await db.customer.create({
        data: { id: customer, organization_id: f.org, customer_number: `C-${f.tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
      });
      let n = 0;
      /** An invoice of $total with one payment on it, as the processor charged it. */
      const invoiceWithPayment = async (opts: { method: 'CARD' | 'ACH'; state: 'SUCCEEDED' | 'PROCESSING'; total?: number }) => {
        const total = opts.total ?? 500;
        const k = ++n;
        const invoice = randomUUID();
        const payment = randomUUID();
        const paid = opts.state === 'SUCCEEDED';
        await db.invoice.create({
          data: {
            id: invoice, organization_id: f.org, customer_id: customer, invoice_number: `INV-${f.tag}-${k}`,
            subtotal: total, tax_amount: 0, total_amount: total, amount_due: paid ? 0 : total, net_collected: paid ? total : 0,
            status: paid ? 'PAID' : 'SENT', ...(paid ? { paid_at: new Date() } : {}),
          },
        });
        await db.payment.create({
          data: {
            id: payment, invoice_id: invoice, amount: total, method: opts.method, state: opts.state, paid_at: new Date(),
            stripe_payment_intent_id: `pi_pay10_${f.tag}_${k}`, stripe_charge_id: `ch_pay10_${f.tag}_${k}`,
            stripe_checkout_session_id: `cs_pay10_${f.tag}_${k}`, stripe_account_id: f.account, created_by_source: 'CLIENT',
          },
        });
        return { invoice, payment, k, total, pi: `pi_pay10_${f.tag}_${k}`, charge: `ch_pay10_${f.tag}_${k}`, session: `cs_pay10_${f.tag}_${k}` };
      };
      return { ...f, invoiceWithPayment };
    }

    it('a refund on its card payment is recorded', async () => {
      const f = await restricted();
      const p = await f.invoiceWithPayment({ method: 'CARD', state: 'SUCCEEDED' });

      await f.deliver('refund.created', {
        id: `re_pay10_${f.tag}`, object: 'refund', amount: 10000, currency: 'usd', status: 'succeeded',
        charge: p.charge, payment_intent: p.pi, metadata: {},
      });

      const refunds = await db.refund.findMany({ where: { organization_id: f.org } });
      expect(refunds).toHaveLength(1);
      expect(refunds[0]).toMatchObject({ stripe_refund_id: `re_pay10_${f.tag}`, invoice_id: p.invoice, state: 'SUCCEEDED' });
      expect(Number(refunds[0].amount)).toBe(100);
    });

    it('a dispute on its card payment is recorded and the invoice reads DISPUTED', async () => {
      const f = await restricted();
      const p = await f.invoiceWithPayment({ method: 'CARD', state: 'SUCCEEDED' });

      await f.deliver('charge.dispute.created', {
        id: `dp_pay10_${f.tag}`, object: 'dispute', amount: p.total * 100, currency: 'usd', status: 'needs_response',
        reason: 'fraudulent', charge: p.charge, payment_intent: p.pi, evidence_details: { due_by: 1791000000 }, metadata: {},
      });

      const disputes = await db.dispute.findMany({ where: { organization_id: f.org } });
      expect(disputes).toHaveLength(1);
      expect(disputes[0]).toMatchObject({ payment_id: p.payment, status: 'NEEDS_RESPONSE' });
      expect((await db.invoice.findUniqueOrThrow({ where: { id: p.invoice } })).status).toBe('DISPUTED');
    });

    it('a bank payment that clears is settled: SUCCEEDED, the invoice PAID', async () => {
      const f = await restricted();
      const p = await f.invoiceWithPayment({ method: 'ACH', state: 'PROCESSING', total: 300 });

      await f.deliver('checkout.session.async_payment_succeeded', {
        id: p.session, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
        payment_intent: p.pi, amount_total: 30000, currency: 'usd', payment_method_types: ['us_bank_account'],
        metadata: { invoiceId: p.invoice, organizationId: f.org, kind: 'invoice', payableNowCents: '30000' },
      });

      expect((await db.payment.findUniqueOrThrow({ where: { id: p.payment } })).state).toBe('SUCCEEDED');
      expect(await db.invoice.findUniqueOrThrow({ where: { id: p.invoice } })).toMatchObject({ status: 'PAID' });
    });
  });

  // Slice 17 conductor note: two simultaneous deliveries of one checkout whose money cannot be
  // applied must write it down once. The base code already did (no code change in this slice), so
  // this passes on it by design; dropping the checkout lock in reconcileCheckout turns it red. The reconciler claims the event id first, in the same
  // transaction as the write-down, and serialises a session's deliveries, so the second delivery
  // finds the claim (or the write-down) and adds nothing.
  it('two simultaneous deliveries of a checkout that cannot be applied write the money down once', async () => {
    const f = await connectedOrg({ accepts: ['CARD'], charges: true, payouts: true });
    const customer = randomUUID();
    const invoice = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: f.org, customer_number: `C-${f.tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    // Already paid by hand: nothing is owed, so the checkout's money is not applied.
    await db.invoice.create({
      data: {
        id: invoice, organization_id: f.org, customer_id: customer, invoice_number: `INV-${f.tag}`,
        subtotal: 200, tax_amount: 0, total_amount: 200, amount_due: 0, net_collected: 200, status: 'PAID', paid_at: new Date(),
      },
    });
    const session = {
      id: `cs_pay10_${f.tag}_late`, object: 'checkout.session', mode: 'payment', payment_status: 'paid', status: 'complete',
      payment_intent: `pi_pay10_${f.tag}_late`, amount_total: 20000, currency: 'usd', payment_method_types: ['card'],
      metadata: { invoiceId: invoice, organizationId: f.org, kind: 'invoice', payableNowCents: '20000' },
    };

    // The same event delivered twice at once, and the same money under other event ids at once.
    await Promise.all([
      f.deliver('checkout.session.completed', session, { id: `evt_pay10_${f.tag}_same` }),
      f.deliver('checkout.session.completed', session, { id: `evt_pay10_${f.tag}_same` }),
      ...Array.from({ length: 6 }, (_, i) => f.deliver('checkout.session.completed', session, { id: `evt_pay10_${f.tag}_other${i}` })),
    ]);

    const writtenDown = await db.timelineEvent.findMany({ where: { organization_id: f.org, event_type: 'PAYMENT_UNRECORDED' } });
    expect(writtenDown).toHaveLength(1);
    expect(await f.notifications('billing.payment_unrecorded')).toHaveLength(1);
    expect(await db.payment.count({ where: { invoice_id: invoice } })).toBe(0);
  });
});
