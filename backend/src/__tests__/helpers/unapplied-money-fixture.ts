/**
 * V7-09b - the shared setup of the unapplied-money real-database suites: an org with a connected account, an admin,
 * a customer, invoices and unapplied captures written straight to the table. The client comes from the suite
 * (one factory per file); nothing here imports the app's client.
 */
import request from 'supertest';
import { randomUUID } from 'crypto';
import { vi } from 'vitest';
import { supabaseAdmin } from '../../lib/supabase';

type Db = any; // the suite's own client; typing it here would relate two client types (CI runs out of memory)

export interface Fixture {
  org: string;
  tag: string;
  admin: { id: string; email: string };
  customer: string;
  account: string;
}

export async function seedOrg(db: Db, orgs: string[], withAccount = true): Promise<Fixture> {
  const org = randomUUID();
  orgs.push(org);
  const tag = org.slice(0, 8);
  const admin = { id: randomUUID(), email: `admin-${tag}@example.test` };
  const customer = randomUUID();
  const account = `acct_v709b_${tag}`;
  await db.organization.create({
    data: {
      id: org, name: `v709b-${tag}`, email: `v709b-${tag}@example.test`,
      address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
      estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      ...(withAccount ? { stripe_account_id: account, accepted_payment_methods: ['CARD'] } : {}),
    },
  });
  await db.user.create({ data: { id: admin.id, organization_id: org, email: admin.email, first_name: 'Test', last_name: 'Admin', role: 'ADMIN' } });
  await db.customer.create({
    data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer', email: `pat-${tag}@example.test` },
  });
  return { org, tag, admin, customer, account };
}

let invoiceSeq = 0;
export async function addInvoice(
  db: Db, f: Fixture, opts: { total: number; due?: number; status?: string; kind?: string; customer?: string },
): Promise<{ id: string; number: string }> {
  const id = randomUUID();
  const number = `INV-${f.tag}-${++invoiceSeq}`;
  await db.invoice.create({
    data: {
      id, organization_id: f.org, customer_id: opts.customer ?? f.customer, invoice_number: number,
      subtotal: opts.total, tax_amount: 0, total_amount: opts.total, amount_due: opts.due ?? opts.total,
      status: opts.status ?? 'SENT', ...(opts.kind ? { kind: opts.kind } : {}),
    },
  });
  return { id, number };
}

let captureSeq = 0;
export async function addCapture(
  db: Db, f: Fixture,
  opts: { amount: number; invoiceId?: string | null; reason?: string; sourceKey?: string; status?: string; account?: string | null; intent?: string | null; refunded?: number },
) {
  const n = ++captureSeq;
  return db.unappliedCapture.create({
    data: {
      organization_id: f.org,
      invoice_id: opts.invoiceId ?? null,
      reason: opts.reason ?? 'INVOICE_NOT_FOUND',
      amount: opts.amount,
      stripe_payment_intent_id: opts.intent === undefined ? `pi_v709b_${f.tag}_${n}` : opts.intent,
      stripe_checkout_session_id: `cs_v709b_${f.tag}_${n}`,
      stripe_account_id: opts.account === undefined ? f.account : opts.account,
      source_key: opts.sourceKey ?? `session:cs_v709b_${f.tag}_${n}`,
      status: opts.status ?? 'OPEN',
      ...(opts.refunded ? { refunded_amount: opts.refunded } : {}),
    },
  });
}

/** Sign in as this user for the next calls (the auth layer caches the resolved user by token). */
export function signedInAs(app: Parameters<typeof request>[0], user: { id: string; email: string }) {
  (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({ data: { user: { id: user.id, email: user.email } }, error: null });
  const bearer = `Bearer v709b-${user.id}`;
  return {
    get: (path: string) => request(app).get(path).set('Authorization', bearer),
    post: (path: string, body: object = {}) => request(app).post(path).set('Authorization', bearer).send(body),
  };
}

/** Post one event to the webhook route, the way the processor delivers it. */
export async function deliverEvent(app: Parameters<typeof request>[0], f: Fixture, type: string, object: object, id: string) {
  const event = { id, object: 'event', api_version: '2025-02-24.acacia', type, account: f.account, created: 1790000000, data: { object } };
  return request(app).post('/api/webhooks/stripe').set('Content-Type', 'application/json').set('stripe-signature', 'test_sig').send(Buffer.from(JSON.stringify(event)));
}

/** A processor that, like the real one, answers the same idempotency key with the same refund and refuses to give back more than was paid. */
export function fakeProcessor(paidCentsByIntent: (intent: string) => number) {
  const byKey = new Map<string, { id: string; object: 'refund'; status: string; amount: number }>();
  const refundedByIntent = new Map<string, number>();
  let n = 0;
  const create = async (intent: string, _ctx: unknown, cents: number | undefined, opts?: { idempotencyKey?: string }) => {
    const key = opts?.idempotencyKey ?? `nokey-${++n}`;
    const seen = byKey.get(key);
    if (seen) return seen;
    const amount = cents ?? paidCentsByIntent(intent);
    const already = refundedByIntent.get(intent) ?? 0;
    if (already + amount > paidCentsByIntent(intent)) {
      throw Object.assign(new Error('charge_already_refunded'), { type: 'StripeInvalidRequestError', statusCode: 400, code: 'charge_already_refunded' });
    }
    refundedByIntent.set(intent, already + amount);
    const refund = { id: `re_v709b_${randomUUID().slice(0, 8)}_${++n}`, object: 'refund' as const, status: 'succeeded', amount };
    byKey.set(key, refund);
    return refund;
  };
  return { create, refunds: () => [...byKey.values()], total: (intent: string) => refundedByIntent.get(intent) ?? 0 };
}

export async function cleanupOrgs(db: Db, orgs: string[]): Promise<void> {
  const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
  for (const org of orgs) {
    await quietly(db.$executeRawUnsafe(`DELETE FROM unapplied_captures WHERE organization_id = '${org}'`));
    await quietly(db.$executeRawUnsafe(`DELETE FROM role_permissions WHERE organization_id = '${org}'`));
    await quietly(db.$executeRawUnsafe(`DELETE FROM refunds WHERE organization_id = '${org}'`));
    await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
    for (const table of ['invoice_line_items']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
    }
    for (const table of ['permission_change_log', 'permission_role_switches', 'timeline_events', 'notifications', 'invoices', 'visit_assignees', 'visits', 'jobs']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
    }
    await quietly(db.$executeRawUnsafe(`DELETE FROM audit_logs WHERE org_id = '${org}'`));
    for (const table of ['customers', 'users']) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
    }
    await quietly(db.organization.deleteMany({ where: { id: org } }));
  }
  await quietly(db.$executeRawUnsafe(`DELETE FROM stripe_events WHERE stripe_event_id LIKE 'evt_v709b_%'`));
}

/** The backend pid of the connection a test transaction runs on (read inside that transaction). */
export async function backendPidOf(tx: { $queryRaw: (q: TemplateStringsArray) => Promise<unknown> }): Promise<number> {
  const rows = (await tx.$queryRaw`SELECT pg_backend_pid()::int AS pid`) as Array<{ pid: number }>;
  return rows[0].pid;
}

/** Wait until some session is blocked BY the test's own lock holder (its pid), i.e. the request under test has reached the lock the test holds. */
export async function waitUntilBlockedBy(db: Db, holderPid: number, timeoutMs = 40_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const rows = (await db.$queryRaw`SELECT count(*)::int AS n FROM pg_stat_activity WHERE ${holderPid}::int = ANY(pg_blocking_pids(pid))`) as Array<{ n: number }>;
    if (rows[0].n > 0) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('the request never reached the lock the test holds');
}
