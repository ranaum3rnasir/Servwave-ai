/**
 * Payments go-live slice 39 - shared plumbing for the connected-account flows.
 *
 * Everything the suite writes on a shared database is left in place and listed in the report
 * (`removeFixtures`); the connected-account flows write only inside the demo org that owns the
 * charging account, and tag every row `qa-39`.
 */
import Stripe from 'stripe';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { env } from '../../src/config/env';
import { prisma } from '../../src/lib/prisma';
import { seedStarterTaskCategories } from '../../src/lib/tasks/categories';
import { databaseIsLocal, keepFixtures } from './policy';
import { postWebhook } from './sign';
import { SkipFlow, type SuiteContext } from './context';

export const QA_TAG = 'qa-39';

export function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What was left in the database (shared databases are never deleted from). Printed in the report. */
export const leftBehind: string[] = [];

const deferred: { label: string; fn: () => Promise<void> }[] = [];

/**
 * Remove a flow's fixtures, unless this run is against a shared database: then only record them.
 * On a local database the removal waits until the whole run is over (`runDeferredCleanups`), so the
 * nightly check at the end still sees every payment the flows booked.
 */
export async function removeFixtures(label: string, fn: () => Promise<void>): Promise<void> {
  if (keepFixtures({ DATABASE_URL: process.env.DATABASE_URL, VERIFY_STRIPE_KEEP_FIXTURES: process.env.VERIFY_STRIPE_KEEP_FIXTURES })) {
    leftBehind.push(label);
    return;
  }
  deferred.push({ label, fn });
}

export async function runDeferredCleanups(): Promise<void> {
  // Newest first, so children go before the parents they were made under.
  for (const { label, fn } of deferred.splice(0).reverse()) {
    try {
      await fn();
    } catch (err) {
      console.log(`  [WARN] could not remove ${label}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

/** Poll until `fn` returns something other than undefined/null/false. */
export async function waitFor<T>(what: string, fn: () => Promise<T | undefined | null | false>, timeoutMs = 90_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(2000);
  }
}

// ── The org that owns the charging account (the demo org) ──────────────────────────────────────

export async function chargingOrgId(ctx: SuiteContext): Promise<string> {
  if (!ctx.chargingAccount) {
    throw new SkipFlow('no charging account: set VERIFY_STRIPE_CHARGING_ACCOUNT to an onboarded sandbox connected account');
  }
  const found = await prisma.organization.findFirst({
    where: { stripe_account_id: ctx.chargingAccount },
    select: { id: true, is_demo: true },
    orderBy: { created_at: 'asc' },
  });
  if (found) {
    if (!found.is_demo) throw new Error(`the org holding ${ctx.chargingAccount} is not a demo org; the suite only writes to a demo org`);
    return found.id;
  }
  if (!databaseIsLocal(process.env.DATABASE_URL)) {
    throw new Error(`no organization holds ${ctx.chargingAccount}; link the demo org to it first`);
  }
  // A throwaway local database: make the demo org the account belongs to.
  const id = randomUUID();
  await prisma.organization.create({
    data: {
      id, name: `${QA_TAG}-demo-org`, email: `${QA_TAG}-org@test.invalid`, is_demo: true, plan: 'SCALE',
      address_line1: '1 Harness St', city: 'Testville', state: 'CA', postal_code: '90001',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      stripe_account_id: ctx.chargingAccount, stripe_charges_enabled: true, stripe_payouts_enabled: true,
      accepted_payment_methods: ['CARD', 'ACH'],
    },
  });
  // The starter task categories every new org gets (removed with the org, ON DELETE CASCADE).
  await seedStarterTaskCategories(prisma, id);
  return id;
}

type OrgPatch = Parameters<typeof prisma.organization.update>[0]['data'];

/** Change org settings for the length of `fn`, then put them back (settings, not deletion, so it also runs on a shared database). */
export async function withOrgSettings<T>(orgId: string, patch: OrgPatch, fn: () => Promise<T>): Promise<T> {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  const select = Object.fromEntries(keys.map((k) => [k, true])) as Record<string, true>;
  const before = await prisma.organization.findUniqueOrThrow({ where: { id: orgId }, select });
  await prisma.organization.update({ where: { id: orgId }, data: patch });
  try {
    return await fn();
  } finally {
    await prisma.organization.update({ where: { id: orgId }, data: before as OrgPatch });
  }
}

export interface SeededInvoice {
  id: string;
  token: string;
  customerId: string;
  number: string;
  estimateId: string | null;
  leadId: string | null;
}

let seq = 0;
const stamp = () => `${Date.now() % 1e8}${++seq}`;

/** A payable invoice (or a deposit with its estimate) for `orgId`, every name tagged qa-39. */
export async function seedInvoice(
  orgId: string,
  o: { kind: 'STANDARD' | 'DEPOSIT'; totalCents: number; allowPartial?: boolean; methods?: ('CARD' | 'ACH')[] },
): Promise<SeededInvoice> {
  const n = stamp();
  const total = o.totalCents / 100;
  const customer = await prisma.customer.create({
    data: {
      organization_id: orgId, customer_number: `C-QA39-${n}`, kind: 'PERSON', segment: 'RESIDENTIAL',
      first_name: QA_TAG, last_name: `Customer ${n}`, email: 'delivered@resend.dev', created_by_source: 'SYSTEM',
    },
  });
  let estimateId: string | null = null;
  let leadId: string | null = null;
  if (o.kind === 'DEPOSIT') {
    const user = await prisma.user.findFirstOrThrow({ where: { organization_id: orgId }, select: { id: true } });
    const lead = await prisma.lead.create({
      data: { organization_id: orgId, lead_number: `L-QA39-${n}`, customer_id: customer.id, service_request: `${QA_TAG} deposit`, status: 'ESTIMATED', created_by_source: 'SYSTEM' },
    });
    leadId = lead.id;
    const estimate = await prisma.estimate.create({
      data: {
        organization_id: orgId, lead_id: lead.id, customer_id: customer.id, estimate_number: `E-QA39-${n}`,
        status: 'SENT', created_by: user.id, subtotal: total * 2, tax_amount: 0, total_amount: total * 2,
      },
    });
    estimateId = estimate.id;
  }
  const token = `qa39-${randomUUID()}`;
  const number = `I-QA39-${n}`;
  const invoice = await prisma.invoice.create({
    data: {
      organization_id: orgId, customer_id: customer.id, kind: o.kind, invoice_number: number, status: 'SENT',
      subtotal: total, tax_amount: 0, total_amount: total, amount_due: total, public_token: token,
      allow_partial_payment: o.allowPartial ? true : null,
      payment_methods_override: o.methods ?? ['CARD'],
      created_by_source: 'SYSTEM',
      ...(estimateId ? { estimate_id: estimateId } : {}),
    },
  });
  return { id: invoice.id, token, customerId: customer.id, number, estimateId, leadId };
}

/** A staff-recorded or processor-made payment row beside an invoice (for refund and reconcile setups). */
export function label(inv: SeededInvoice, orgId: string): string {
  return `${QA_TAG} invoice ${inv.number} (org ${orgId}, customer ${inv.customerId})`;
}

// ── The app's public checkout door and the hosted page, with nothing typed anywhere ────────────

export async function openCheckout(
  ctx: SuiteContext, inv: SeededInvoice, body: Record<string, unknown>,
): Promise<{ status: number; sessionId: string | null; json: Record<string, unknown> }> {
  const res = await fetch(`${ctx.apiUrl}/api/invoices/${inv.id}/public/checkout?token=${encodeURIComponent(inv.token)}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const url = typeof json.checkout_url === 'string' ? json.checkout_url : '';
  return { status: res.status, sessionId: url.match(/cs_test_[A-Za-z0-9]+/)?.[0] ?? null, json };
}

const CUSTOMER_EMAIL = 'delivered@resend.dev';

/** Pay an open session by card (the visa test token), on the connected account, through the hosted confirm. */
export async function payByCard(ctx: SuiteContext, sessionId: string, cents: number): Promise<void> {
  const account = ctx.chargingAccount!;
  const pm = await ctx.stripe.paymentMethods.create({
    type: 'card', card: { token: 'tok_visa' }, billing_details: { name: `${QA_TAG} Customer`, email: CUSTOMER_EMAIL },
  }, { stripeAccount: account });
  await ctx.stripe.rawRequest('POST', `/v1/payment_pages/${sessionId}/confirm`,
    { payment_method: pm.id, expected_amount: cents }, { stripeAccount: account });
}

export const TEST_BANK_OK = '000123456789';
export const TEST_BANK_FAIL = '000111111116';

/** Pay an open session by bank debit with a test bank account; the sandbox then needs the micro-deposit code. */
export async function payByBank(ctx: SuiteContext, sessionId: string, cents: number, accountNumber: string): Promise<{ intentId: string }> {
  const account = ctx.chargingAccount!;
  const pm = await ctx.stripe.paymentMethods.create({
    type: 'us_bank_account',
    us_bank_account: { account_holder_type: 'individual', routing_number: '110000000', account_number: accountNumber },
    billing_details: { name: `${QA_TAG} Customer`, email: CUSTOMER_EMAIL },
  }, { stripeAccount: account });
  await ctx.stripe.rawRequest('POST', `/v1/payment_pages/${sessionId}/confirm`,
    { payment_method: pm.id, expected_amount: cents }, { stripeAccount: account });
  const session = await ctx.stripe.checkout.sessions.retrieve(sessionId, {}, { stripeAccount: account });
  const intentId = typeof session.payment_intent === 'string' ? session.payment_intent : session.payment_intent?.id;
  assert(intentId, `the bank session ${sessionId} has a payment intent`);
  await ctx.stripe.paymentIntents.verifyMicrodeposits(intentId, { descriptor_code: 'SM11AA' }, { stripeAccount: account });
  return { intentId };
}

// ── The processor's real events, played back to the backend under test ──────────────────────────

export async function realEvents(
  ctx: SuiteContext,
  o: { type: string; since: number; match: (obj: Record<string, unknown>) => boolean; want?: number; timeoutMs?: number },
): Promise<Stripe.Event[]> {
  const account = ctx.chargingAccount!;
  const want = o.want ?? 1;
  const deadline = Date.now() + (o.timeoutMs ?? 90_000);
  for (;;) {
    const page = await ctx.stripe.events.list({ type: o.type, created: { gte: o.since }, limit: 100 }, { stripeAccount: account });
    const found = page.data.filter((e) => o.match(e.data.object as unknown as Record<string, unknown>)).reverse();
    if (found.length >= want) return found;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${want} ${o.type} event(s) on ${account}`);
    await sleep(2000);
  }
}

/** Post processor events to the backend, signed, as `account`'s events. A duplicate answer is fine (a listener may have delivered first). */
export async function deliverAsAccount(events: Stripe.Event[], account: string): Promise<void> {
  for (const e of events) {
    const res = await postWebhook({ ...e, account });
    assert(res.status === 200, `${e.type} ${e.id} answered 200 (got ${res.status} ${JSON.stringify(res.body)})`);
  }
}

export const sinceNow = () => Math.floor(Date.now() / 1000) - 5;

// ── A staff session, minted the way the QA session script does (demo org only) ─────────────────

function frontendAnonKey(): string | undefined {
  if (process.env.SUPABASE_ANON_KEY) return process.env.SUPABASE_ANON_KEY;
  if (process.env.VITE_SUPABASE_ANON_KEY) return process.env.VITE_SUPABASE_ANON_KEY;
  const file = path.resolve(__dirname, '../../../frontend/.env');
  if (!existsSync(file)) return undefined;
  const line = readFileSync(file, 'utf8').split(/\r?\n/).find((l) => /^\s*VITE_SUPABASE_ANON_KEY\s*=/.test(l));
  return line?.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}

export async function staffSession(ctx: SuiteContext): Promise<{ token: string; orgId: string }> {
  const email = process.env.VERIFY_STRIPE_STAFF_EMAIL ?? 'admin@alphacrm.com';
  const anon = frontendAnonKey();
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || !anon) {
    throw new SkipFlow('no staff session: needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and the anon key (frontend/.env) to sign in the demo admin');
  }
  const admin = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
  if (link.error || !link.data.properties) throw new SkipFlow(`no staff session: ${link.error?.message ?? 'no link'}`);
  const pub = createClient(env.SUPABASE_URL, anon, { auth: { persistSession: false } });
  const verified = await pub.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'magiclink' });
  const token = verified.data.session?.access_token;
  if (!token) throw new SkipFlow(`no staff session: ${verified.error?.message ?? 'no session'}`);
  const me = await fetch(`${ctx.apiUrl}/api/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
  if (!me.ok) throw new SkipFlow(`no staff session: /api/auth/me answered ${me.status} (is ${email} a user of the database the backend uses?)`);
  const body = (await me.json()) as { user?: Record<string, unknown> } & Record<string, unknown>;
  const who = (body.user ?? body) as { organization_id?: string; org_is_demo?: boolean };
  assert(who.org_is_demo === true, `the staff session is a demo org user (got org_is_demo=${who.org_is_demo})`);
  return { token, orgId: who.organization_id! };
}

// ── Cleanup of what seedInvoice wrote (local databases only; see removeFixtures) ───────────────

export async function deleteSeeded(orgId: string, inv: SeededInvoice): Promise<void> {
  const q = (sql: string) => prisma.$executeRawUnsafe(sql).catch(() => undefined);
  const ids = [inv.id, inv.estimateId, inv.leadId].filter(Boolean).map((i) => `'${i}'`).join(',');
  await q(`DELETE FROM refunds WHERE invoice_id = '${inv.id}'`);
  await q(`DELETE FROM disputes WHERE invoice_id = '${inv.id}'`);
  await q(`DELETE FROM unapplied_captures WHERE invoice_id = '${inv.id}'`);
  await q(`DELETE FROM payments WHERE invoice_id = '${inv.id}'`);
  await q(`DELETE FROM timeline_events WHERE entity_id IN (${ids})`);
  await q(`DELETE FROM invoices WHERE id = '${inv.id}'`);
  if (inv.estimateId) {
    await q(`DELETE FROM estimate_send_configs WHERE estimate_id = '${inv.estimateId}'`);
    await q(`DELETE FROM estimates WHERE id = '${inv.estimateId}'`);
  }
  if (inv.leadId) {
    await q(`DELETE FROM leads WHERE id = '${inv.leadId}'`);
  }
  await q(`DELETE FROM customers WHERE id = '${inv.customerId}' AND organization_id = '${orgId}'`);
}

/** The payment rows an invoice has, newest last. */
export const paymentsOf = (invoiceId: string) => prisma.payment.findMany({ where: { invoice_id: invoiceId }, orderBy: { created_at: 'asc' } });

/**
 * Pay an invoice by card the way a homeowner does (open the checkout through the app's public door,
 * pay the hosted page with the visa test token) and book it from the processor's own
 * checkout.session.completed event, played to the backend as the connected account's event.
 */
export async function bookCardPayment(
  ctx: SuiteContext, inv: SeededInvoice, body: Record<string, unknown>, chargedCents: number,
): Promise<{ sessionId: string; events: Stripe.Event[] }> {
  const since = sinceNow();
  const opened = await openCheckout(ctx, inv, { method: 'card', ...body });
  assert(opened.status === 200 && opened.sessionId, `the checkout opened (got ${opened.status} ${JSON.stringify(opened.json)})`);
  await payByCard(ctx, opened.sessionId, chargedCents);
  const events = await realEvents(ctx, { type: 'checkout.session.completed', since, match: (o) => o.id === opened.sessionId });
  return { sessionId: opened.sessionId, events };
}
