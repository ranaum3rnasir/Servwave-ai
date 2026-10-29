import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import type { StatementForPdf, StatementPdfLine } from '../lib/pdf/templates/statement';

// ─── Statement (entity-redesign §9) ───────────────────
// A READ-ONLY generated view (NOT a table) of the §8 ledger: every Invoice on a job
// (or across a customer's billing group) with its Payments, Refunds, Credits and applied
// deposit credit, in chronological order, with a running balance.
//
// Route-guarded by read:Invoice (org-level); per-assignment ownership narrowing for
// SALES/TECH is deferred to Phase 8 (a statement is an org-internal financial doc).
//
// DEFER (§13): QuickBooks statement sync seam — the chronological projection here is the
//   natural export point; no code yet.
// DEFER (Phase 8): FE statement page — backend returns JSON + PDF only.
// DEFER (Phase 8): narrow statement to own invoices for SALES/TECH.

const DEPOSIT_CREDIT_REFERENCE = 'DEPOSIT-CREDIT';

function param(req: Request, name: string): string {
  return req.params[name] as string;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

// Prisma returns Decimal in prod; mocks return plain numbers — Number() handles both.
function num(v: unknown): number {
  return Number(v ?? 0);
}

// ─── Shared select (org-scoped, created_at asc) ───────
// Reused by both the job and customer statement so the ledger projection is identical.
const invoiceStatementSelect = {
  id: true,
  invoice_number: true,
  kind: true,
  status: true,
  total_amount: true,
  tax_amount: true,
  created_at: true,
  customer_id: true,
  customer: {
    select: { id: true, first_name: true, last_name: true, company_name: true },
  },
  // Voided payments stop counting (§8). The synthetic DEPOSIT-CREDIT row IS kept —
  // it is exactly the §9 "applied deposit credit" line.
  payments: {
    where: { voided_at: null },
    select: {
      id: true,
      amount: true,
      method: true,
      paid_at: true,
      reference_number: true,
      stripe_payment_intent_id: true,
      created_at: true,
    },
    orderBy: { paid_at: 'asc' as const },
  },
  refunds: {
    select: {
      id: true,
      amount: true,
      tax_portion: true,
      method: true,
      reason_category: true,
      created_at: true,
    },
  },
  credits: {
    select: {
      id: true,
      amount: true,
      tax_portion: true,
      reason: true,
      category: true,
      created_at: true,
    },
  },
} as const;

type StatementInvoice = {
  id: string;
  invoice_number: string;
  kind: string;
  status: string;
  total_amount: unknown;
  tax_amount: unknown;
  created_at: Date | string;
  customer_id?: string | null;
  customer?: { id: string; first_name: string | null; last_name: string | null; company_name: string | null } | null;
  payments: Array<{
    id: string;
    amount: unknown;
    method: string;
    paid_at: Date | string;
    reference_number: string | null;
    stripe_payment_intent_id: string | null;
    created_at: Date | string;
  }>;
  refunds: Array<{ id: string; amount: unknown; tax_portion: unknown; method: string; reason_category: string; created_at: Date | string }>;
  credits: Array<{ id: string; amount: unknown; tax_portion: unknown; reason: string | null; category: string | null; created_at: Date | string }>;
};

type EventType = 'invoice' | 'credit' | 'deposit_credit' | 'payment' | 'refund';

interface StatementLine {
  type: EventType;
  date: Date | string | null;
  invoice_id: string;
  invoice_number: string;
  invoice_kind: string;
  customer_id?: string | null;
  customer_name?: string;
  amount: number; // always the positive magnitude shown on the document
  running_balance: number;
}

interface BuiltStatement {
  lines: StatementLine[];
  totals: { billed: number; paid: number; deposit_credit: number; refunded: number; credited: number; balance: number };
}

// Deterministic same-day ordering: a bill precedes its settlements.
const TYPE_RANK: Record<EventType, number> = {
  invoice: 0,
  credit: 1,
  deposit_credit: 2,
  payment: 3,
  refund: 4,
};

function customerName(c?: { first_name: string | null; last_name: string | null; company_name: string | null } | null): string {
  if (!c) return 'Customer';
  const person = [c.first_name, c.last_name].filter(Boolean).join(' ').trim();
  return person || c.company_name || 'Customer';
}

function toTime(d: Date | string | null): number {
  if (d == null) return 0;
  const t = d instanceof Date ? d.getTime() : new Date(d).getTime();
  return Number.isNaN(t) ? 0 : t;
}

/**
 * buildStatement — the SINGLE running-balance implementation (used by both job + customer
 * handlers). Input: org-scoped, created_at-asc invoice rows. Output: chronological lines[]
 * each with running_balance, plus totals. A pure projection of existing money rows —
 * no new money semantics (READ-ONLY).
 */
export function buildStatement(invoices: StatementInvoice[]): BuiltStatement {
  interface Event {
    type: EventType;
    date: Date | string | null;
    delta: number; // signed effect on the running balance
    invoice_id: string;
    invoice_number: string;
    invoice_kind: string;
    customer_id?: string | null;
    customer_name?: string;
  }

  const events: Event[] = [];

  for (const inv of invoices) {
    const cname = customerName(inv.customer);
    const base = {
      invoice_id: inv.id,
      invoice_number: inv.invoice_number,
      invoice_kind: inv.kind,
      customer_id: inv.customer_id ?? null,
      customer_name: cname,
    };

    // (a) invoice billed line — skipped for VOIDED invoices (a void un-bills, mirroring
    // invoice.controller void which decrements amount_invoiced).
    if (inv.status !== 'VOIDED') {
      events.push({ type: 'invoice', date: inv.created_at, delta: +num(inv.total_amount), ...base });
    }

    // (b) payments — classify by reference_number (synthetic deposit-credit vs real).
    for (const p of inv.payments) {
      const type: EventType = p.reference_number === DEPOSIT_CREDIT_REFERENCE ? 'deposit_credit' : 'payment';
      events.push({ type, date: p.paid_at, delta: -num(p.amount), ...base });
    }

    // (c) credits — lower the bill.
    for (const c of inv.credits) {
      events.push({ type: 'credit', date: c.created_at, delta: -num(c.amount), ...base });
    }

    // (d) refunds — money back out (raises the balance owed/settlement gap).
    for (const r of inv.refunds) {
      events.push({ type: 'refund', date: r.created_at, delta: +num(r.amount), ...base });
    }
  }

  // Stable sort by (date asc, typeRank asc). Array.prototype.sort is stable in V8.
  events.sort((a, b) => {
    const dt = toTime(a.date) - toTime(b.date);
    if (dt !== 0) return dt;
    return TYPE_RANK[a.type] - TYPE_RANK[b.type];
  });

  let running = 0;
  const lines: StatementLine[] = events.map((e) => {
    running = roundMoney(running + e.delta);
    return {
      type: e.type,
      date: e.date,
      invoice_id: e.invoice_id,
      invoice_number: e.invoice_number,
      invoice_kind: e.invoice_kind,
      customer_id: e.customer_id,
      customer_name: e.customer_name,
      amount: roundMoney(Math.abs(e.delta)),
      running_balance: running,
    };
  });

  // Totals computed from the SAME events (no second raw pass → no drift).
  // 'payment' (real cash) and 'deposit_credit' (the synthetic DEPOSIT-CREDIT drawdown) are
  // kept in SEPARATE accumulators: the drawdown is the same dollars as the deposit payment,
  // so folding both into `paid` double-counts the deposit. balance nets both — identical math.
  let billed = 0;
  let paid = 0;
  let depositApplied = 0;
  let credited = 0;
  let refunded = 0;
  for (const e of events) {
    if (e.type === 'invoice') billed = roundMoney(billed + e.delta);
    else if (e.type === 'payment') paid = roundMoney(paid + Math.abs(e.delta));
    else if (e.type === 'deposit_credit') depositApplied = roundMoney(depositApplied + Math.abs(e.delta));
    else if (e.type === 'credit') credited = roundMoney(credited + Math.abs(e.delta));
    else if (e.type === 'refund') refunded = roundMoney(refunded + e.delta);
  }
  const balance = roundMoney(billed - paid - depositApplied - credited + refunded);

  return { lines, totals: { billed, paid, deposit_credit: depositApplied, refunded, credited, balance } };
}

// ─── PDF helpers ──────────────────────────────────────

function toPdfStatement(
  scope: 'job' | 'customer',
  title: string,
  party: { name: string | null; email: string | null },
  built: BuiltStatement,
): StatementForPdf {
  const lines: StatementPdfLine[] = built.lines.map((l) => ({
    date: l.date,
    type: l.type,
    label: '',
    invoice_number: l.invoice_number ?? null,
    // Signed amount for the PDF column placement: settlements negative, charges positive.
    amount: l.type === 'invoice' || l.type === 'refund' ? l.amount : -l.amount,
    running_balance: l.running_balance,
  }));
  return { scope, title, party, lines, totals: built.totals };
}

async function sendStatementPdf(
  req: Request,
  res: Response,
  scope: 'job' | 'customer',
  title: string,
  party: { name: string | null; email: string | null },
  built: BuiltStatement,
  filenameSlug: string,
): Promise<void> {
  // Both job + customer live in the same tenant as the requester (the scoped query proved
  // it), so req.user.organization_id is the org — no extra org_id read needed.
  const org = await prisma.organization.findUnique({ where: { id: req.user!.organization_id } });
  const statement = toPdfStatement(scope, title, party, built);
  const { generateStatementPdf } = await import('../lib/pdf/index.js');
  const buffer = await generateStatementPdf(statement, (org ?? { name: 'Statement' }) as any);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="statement-${filenameSlug}.pdf"`);
  res.setHeader('Content-Length', buffer.length);
  res.send(buffer);
}

// ─── Job statement ────────────────────────────────────

export const getJobStatement = async (req: Request, res: Response): Promise<void> => {
  const jobId = param(req, 'jobId');
  try {
    // Hop 1 — the job, tenant-scoped. This single scoped read is the tenant gate for the
    // whole job statement (every downstream invoice is reachable only via job_id = this job).
    const job = await prisma.job.findUnique({
      where: { id: jobId, ...tenantWhere(req) },
      select: {
        id: true,
        job_number: true,
        status: true,
        customer_id: true,
        customer: { select: { id: true, first_name: true, last_name: true, company_name: true, email: true } },
        service_location: { select: { address_line1: true, address_line2: true, city: true, state: true, zip: true } },
      },
    });

    if (!job) {
      res.status(404).json({ error: 'Job not found' });
      return;
    }

    // Hop 2 — every invoice on the job, tenant-scoped AGAIN (do NOT rely on the job hop alone).
    const invoices = (await prisma.invoice.findMany({
      where: { job_id: jobId, ...tenantWhere(req) },
      select: invoiceStatementSelect,
      orderBy: { created_at: 'asc' },
    })) as unknown as StatementInvoice[];

    const built = buildStatement(invoices);

    if (req.query.format === 'pdf') {
      const c = job.customer;
      await sendStatementPdf(
        req,
        res,
        'job',
        `Job ${job.job_number}`,
        { name: customerName(c), email: c?.email ?? null },
        built,
        job.job_number,
      );
      return;
    }

    res.json({ scope: 'job', job, lines: built.lines, totals: built.totals });
  } catch (err) {
    logger.error(`Statement generation failed for job ${jobId}:`, err);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
};

// ─── Customer / billing-group statement ───────────────

export const getCustomerStatement = async (req: Request, res: Response): Promise<void> => {
  const customerId = param(req, 'customerId');
  try {
    // Hop 1 — the customer, tenant-scoped.
    const customer = await prisma.customer.findUnique({
      where: { id: customerId, ...tenantWhere(req) },
      select: {
        id: true,
        first_name: true,
        last_name: true,
        company_name: true,
        email: true,
        bill_to_customer_id: true,
        parent_id: true,
      },
    });

    if (!customer) {
      res.status(404).json({ error: 'Customer not found' });
      return;
    }

    // Hop 2 — the billing-group member set, resolved by bill_to_customer_id (NOT parent_id).
    // §3 clar.3: the authoritative payer is bill_to. A member that bills itself is NOT rolled
    // into this customer; a member whose bill_to === this customer IS.
    const members = (await prisma.customer.findMany({
      where: { bill_to_customer_id: customerId, ...tenantWhere(req) },
      select: { id: true, first_name: true, last_name: true, company_name: true },
    })) as Array<{ id: string; first_name: string | null; last_name: string | null; company_name: string | null }>;

    // Self is always included — an invoice billed directly to this customer has
    // customer_id === customerId (bill_to may be null/self at creation).
    const memberIds = [customerId, ...members.map((m) => m.id)];

    // Hop 3 — invoices across the group, tenant-scoped AGAIN (the leak-prevention hop).
    // Invoice.customer_id already encodes the bill_to resolution done at creation, so we
    // query customer_id IN memberIds rather than re-resolving bill_to per invoice.
    const invoices = (await prisma.invoice.findMany({
      where: { customer_id: { in: memberIds }, ...tenantWhere(req) },
      select: invoiceStatementSelect,
      orderBy: { created_at: 'asc' },
    })) as unknown as StatementInvoice[];

    const built = buildStatement(invoices);

    if (req.query.format === 'pdf') {
      await sendStatementPdf(
        req,
        res,
        'customer',
        `Customer: ${customerName(customer)}`,
        { name: customerName(customer), email: customer.email ?? null },
        built,
        customer.id,
      );
      return;
    }

    res.json({ scope: 'customer', customer, members, lines: built.lines, totals: built.totals });
  } catch (err) {
    logger.error(`Statement generation failed for customer ${customerId}:`, err);
    res.status(500).json({ error: 'Failed to generate statement' });
  }
};
