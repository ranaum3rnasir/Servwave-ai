# Step 8A: Invoice & Payments Backend — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the complete invoice and payment backend — schema migration, controller, routes, webhook extension, email functions, and tests.

**Architecture:** Single `invoice.controller.ts` handles CRUD, send, void, delete, payments, notes, stats, and public endpoints. Extends existing `webhook.controller.ts` for Stripe invoice payments. Follows the exact patterns established by `estimate.controller.ts` and `job.controller.ts`.

**Tech Stack:** Express + TypeScript, Prisma ORM, Stripe SDK, Resend emails, Vitest + Supertest for tests.

**Spec:** `md_files/specs/invoices/invoice-payments-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `backend/src/controllers/invoice.controller.ts` | All invoice logic: CRUD, send, void, delete, payments, notes, stats, public, checkout |
| Create | `backend/src/routes/invoice.routes.ts` | Route definitions with auth/role middleware |
| Create | `backend/src/__tests__/invoices.test.ts` | Full test suite |
| Modify | `backend/src/controllers/webhook.controller.ts` | Add invoice payment handling path |
| Modify | `backend/src/lib/email.ts` | Add 4 invoice email functions |
| Modify | `backend/src/app.ts` | Register invoice routes |
| Modify | `backend/src/__tests__/setup.ts` | Add invoice/payment mocks |
| Modify | `backend/src/__tests__/helpers.ts` | Add invoice/payment fixtures |
| Modify | `backend/prisma/schema.prisma` | Add VOIDED status, discount_amount, voided fields, reference_number, tax_rate, nullable collected_by |
| Modify | `backend/src/controllers/search.controller.ts` | Add invoice to global search |

---

## Task 1: Schema Migration

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Add VOIDED to InvoiceStatus enum**

In `backend/prisma/schema.prisma`, find the `InvoiceStatus` enum and add `VOIDED`:

```prisma
enum InvoiceStatus {
  DRAFT
  SENT
  PARTIAL
  PAID
  VOIDED
}
```

- [ ] **Step 2: Add fields to Invoice model**

Add four fields to the `Invoice` model, after `amount_due`:

```prisma
discount_amount Decimal       @default(0) @db.Decimal(12, 2)
tax_rate        Decimal       @default(0) @db.Decimal(5, 4)   // Snapshot of tax rate used at creation
voided_at       DateTime?
voided_reason   String?
```

- [ ] **Step 3: Update Payment model**

Add `reference_number` and make `collected_by` nullable (needed for Stripe webhook payments where there's no user session):

```prisma
reference_number String?
```

Also change `collected_by` from required to optional:

```prisma
collected_by             String?       @db.Uuid    // nullable for webhook payments
```

And update the `collector` relation to optional:

```prisma
collector                User?          @relation("PaymentCollectedBy", fields: [collected_by], references: [id])
```

- [ ] **Step 4: Validate schema**

Run: `cd backend && npx prisma validate`
Expected: "The Prisma schema is valid."

- [ ] **Step 5: Generate Prisma client**

Run: `cd backend && npx prisma generate`
Expected: "Generated Prisma Client"

- [ ] **Step 6: Create and apply migration**

Run: `cd backend && npx prisma migrate dev --name add_invoice_fields_voided_discount_taxrate_payment_updates`
Expected: Migration applied successfully.

Note: If using Supabase MCP for migrations, generate the SQL with `npx prisma migrate diff --from-schema-datamodel prisma/schema.prisma --to-schema-datamodel prisma/schema.prisma --script` and apply via MCP instead.

- [ ] **Step 7: Commit**

```bash
git add backend/prisma/
git commit -m "feat: add VOIDED status, discount_amount, voided fields, payment reference_number"
```

---

## Task 2: Test Infrastructure — Mocks & Fixtures

**Files:**
- Modify: `backend/src/__tests__/setup.ts`
- Modify: `backend/src/__tests__/helpers.ts`

- [ ] **Step 1: Add invoice and payment mocks to setup.ts**

In `backend/src/__tests__/setup.ts`, add to the prisma mock object (alongside existing `job`, `estimate`, etc.):

```typescript
invoice: {
  findMany: vi.fn(),
  findFirst: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  count: vi.fn(),
  aggregate: vi.fn(),
},
payment: {
  findMany: vi.fn(),
  create: vi.fn(),
  aggregate: vi.fn(),
},
```

Also add the invoice email mocks alongside the existing email function mocks:

```typescript
sendInvoiceEmail: vi.fn().mockResolvedValue(undefined),
sendPaymentReceivedEmail: vi.fn().mockResolvedValue(undefined),
sendInvoicePaidEmail: vi.fn().mockResolvedValue(undefined),
sendPaymentReceivedAlert: vi.fn().mockResolvedValue(undefined),
```

- [ ] **Step 2: Add invoice fixtures to helpers.ts**

Add to `backend/src/__tests__/helpers.ts` after the existing job fixtures:

```typescript
export const INVOICE_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000901',
  invoice_number: 'I00001',
  job_id: JOB_FIXTURE.id,
  status: 'DRAFT',
  subtotal: 2300,
  discount_amount: 200,
  tax_amount: 168,
  deposit_credit: 1000,
  total_amount: 2268,
  amount_due: 1268,
  public_token: null,
  sent_at: null,
  paid_at: null,
  due_date: new Date('2026-04-25'),
  voided_at: null,
  voided_reason: null,
  created_at: new Date('2026-03-26'),
  updated_at: new Date('2026-03-26'),
  job: {
    ...JOB_FIXTURE,
    customer: CUSTOMER_FIXTURE,
    service_location: LOCATION_FIXTURE,
    estimate: {
      ...ESTIMATE_APPROVED_FIXTURE,
      line_items: [
        { id: 'li-1', sequence: 1, description: 'HVAC Install', quantity: 1, unit_price: 2000, is_taxable: true, line_total: 2000 },
        { id: 'li-2', sequence: 2, description: 'Permit Fee', quantity: 1, unit_price: 300, is_taxable: false, line_total: 300 },
      ],
      deposit: {
        id: 'dep-1',
        status: 'PAID',
        amount: 1000,
        total_refunded: 0,
      },
      discount_amount: 200,
      tax_rate: 0.08,
    },
    charges: [],
  },
  payments: [],
};

export const INVOICE_SENT_FIXTURE = {
  ...INVOICE_FIXTURE,
  status: 'SENT',
  public_token: 'test-invoice-token-123',
  sent_at: new Date('2026-03-27'),
};

export const INVOICE_PARTIAL_FIXTURE = {
  ...INVOICE_SENT_FIXTURE,
  status: 'PARTIAL',
  amount_due: 768,
  payments: [
    {
      id: 'pay-1',
      invoice_id: INVOICE_FIXTURE.id,
      amount: 500,
      method: 'CHECK',
      paid_at: new Date('2026-03-28'),
      collected_by: TEST_USERS.admin.id,
      reference_number: 'CHK-1234',
      notes: null,
      created_at: new Date('2026-03-28'),
    },
  ],
};

export const PAYMENT_FIXTURE = {
  id: '00000000-0000-0000-0000-000000000801',
  invoice_id: INVOICE_FIXTURE.id,
  amount: 500,
  method: 'CHECK',
  paid_at: new Date('2026-03-28'),
  collected_by: TEST_USERS.admin.id,
  stripe_payment_intent_id: null,
  reference_number: 'CHK-1234',
  notes: null,
  created_at: new Date('2026-03-28'),
};

export const URGENT_INVOICE_FIXTURE = {
  ...INVOICE_FIXTURE,
  id: '00000000-0000-0000-0000-000000000902',
  invoice_number: 'I00002',
  job_id: URGENT_JOB_FIXTURE.id,
  subtotal: 150,
  discount_amount: 0,
  tax_amount: 12,
  deposit_credit: 0,
  total_amount: 162,
  amount_due: 162,
  job: {
    ...URGENT_JOB_FIXTURE,
    customer: CUSTOMER_FIXTURE,
    service_location: LOCATION_FIXTURE,
    estimate: null,
    charges: [JOB_CHARGE_FIXTURE],
  },
  payments: [],
};
```

Note: Fixtures use plain numbers to match existing patterns (e.g., `JOB_CHARGE_FIXTURE.unit_price = 150`). Prisma mocks return whatever you give them.

- [ ] **Step 3: Commit**

```bash
git add backend/src/__tests__/setup.ts backend/src/__tests__/helpers.ts
git commit -m "test: add invoice and payment mocks and fixtures"
```

---

## Task 3: Invoice Controller — Number Generation & Create

**Files:**
- Create: `backend/src/controllers/invoice.controller.ts`

- [ ] **Step 1: Create the controller file with imports, schemas, and number generation**

Create `backend/src/controllers/invoice.controller.ts`:

```typescript
import { Request, Response } from 'express';
import { z } from 'zod';
import crypto from 'crypto';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { parsePagination, buildPaginationMeta, parseSortParams } from '../lib/pagination';
import { logger } from '../lib/logger';
import {
  sendInvoiceEmail,
  sendPaymentReceivedEmail,
  sendInvoicePaidEmail,
  sendPaymentReceivedAlert,
} from '../lib/email';
import { createCheckoutSession, getSurchargeRate, isStripeConfigured } from '../lib/stripe';

// --- Zod Schemas ---
// NOTE: validate() middleware calls schema.parse(req.body) directly — no body: wrapper

export const createInvoiceSchema = z.object({
  job_id: z.string().uuid(),
});

export const voidInvoiceSchema = z.object({
  voided_reason: z.string().min(1).max(1000),
});

export const editInvoiceSchema = z.object({
  due_date: z.string().datetime().optional(),
});

export const recordPaymentSchema = z.object({
  amount: z.number().positive(),
  method: z.enum(['CARD', 'CASH', 'CHECK', 'BANK_TRANSFER']),
  paid_at: z.string().datetime().optional(),
  reference_number: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
});

export const addNoteSchema = z.object({
  content: z.string().min(1).max(5000),
});

// --- Helpers ---

async function generateInvoiceNumber(tx: any): Promise<string> {
  const latest = await tx.invoice.findFirst({
    where: { invoice_number: { startsWith: 'I' } },
    orderBy: { invoice_number: 'desc' },
    select: { invoice_number: true },
  });

  let nextNum = 1;
  if (latest) {
    const lastNum = parseInt(latest.invoice_number.slice(1), 10);
    if (!isNaN(lastNum)) nextNum = lastNum + 1;
  }

  return `I${String(nextNum).padStart(5, '0')}`;
}

function calculateDueDate(paymentType: string | null | undefined, fromDate: Date): Date {
  const d = new Date(fromDate);
  switch (paymentType) {
    case 'COD': return d;
    case 'NET 15': d.setDate(d.getDate() + 15); return d;
    case 'NET 30': d.setDate(d.getDate() + 30); return d;
    case 'NET 60': d.setDate(d.getDate() + 60); return d;
    case 'EOM':
      return new Date(d.getFullYear(), d.getMonth() + 1, 0);
    default: // fallback NET 30
      d.setDate(d.getDate() + 30); return d;
  }
}

function canAccessInvoice(
  invoice: { job: { assigned_to?: string | null; estimate?: { lead?: { assigned_to?: string | null } | null } | null } },
  req: Request,
): boolean {
  const role = req.user?.role;
  if (role === 'ADMIN' || role === 'DISPATCHER') return true;
  if (role === 'TECHNICIAN') return invoice.job.assigned_to === req.user?.id;
  if (role === 'SALES') return invoice.job.estimate?.lead?.assigned_to === req.user?.id;
  return false;
}
```

- [ ] **Step 2: Implement the select objects and create() function**

Add to the controller file. Follow the `invoiceDetailSelect` pattern from existing code:

```typescript
const invoiceDetailSelect = {
  id: true,
  invoice_number: true,
  status: true,
  subtotal: true,
  discount_amount: true,
  tax_amount: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  public_token: true,
  sent_at: true,
  paid_at: true,
  due_date: true,
  voided_at: true,
  voided_reason: true,
  created_at: true,
  updated_at: true,
  job: {
    select: {
      id: true,
      job_number: true,
      status: true,
      is_urgent: true,
      assigned_to: true,
      customer: {
        select: {
          id: true,
          first_name: true,
          last_name: true,
          email: true,
          phone: true,
          payment_type: true,
          tax_exempt: true,
        },
      },
      service_location: {
        select: {
          id: true,
          address_line1: true,
          address_line2: true,
          city: true,
          state: true,
          zip: true,
        },
      },
      estimate: {
        select: {
          id: true,
          estimate_number: true,
          tax_rate: true,
          discount_amount: true,
          discount_type: true,
          discount_value: true,
          discount_name: true,
          line_items: {
            select: {
              id: true,
              sequence: true,
              description: true,
              quantity: true,
              unit_price: true,
              is_taxable: true,
              line_total: true,
            },
            orderBy: { sequence: 'asc' as const },
          },
          deposit: {
            select: {
              id: true,
              amount: true,
              status: true,
              total_refunded: true,
              payment_method: true,
              paid_at: true,
            },
          },
          lead: {
            select: {
              id: true,
              assigned_to: true,
            },
          },
        },
      },
      charges: {
        select: {
          id: true,
          sequence: true,
          description: true,
          quantity: true,
          unit_price: true,
          is_taxable: true,
          line_total: true,
        },
        orderBy: { sequence: 'asc' as const },
      },
    },
  },
  payments: {
    select: {
      id: true,
      amount: true,
      method: true,
      paid_at: true,
      collected_by: true,
      stripe_payment_intent_id: true,
      reference_number: true,
      notes: true,
      created_at: true,
      collector: {
        select: { id: true, first_name: true, last_name: true },
      },
    },
    orderBy: { paid_at: 'asc' as const },
  },
};

const invoiceListSelect = {
  id: true,
  invoice_number: true,
  status: true,
  subtotal: true,
  discount_amount: true,
  tax_amount: true,
  deposit_credit: true,
  total_amount: true,
  amount_due: true,
  due_date: true,
  sent_at: true,
  paid_at: true,
  created_at: true,
  job: {
    select: {
      id: true,
      job_number: true,
      customer: {
        select: { id: true, first_name: true, last_name: true, company_name: true },
      },
    },
  },
};

export async function create(req: Request, res: Response) {
  try {
    const { job_id } = req.body;

    // 1. Fetch job with all related data
    const job = await prisma.job.findUnique({
      where: { id: job_id },
      include: {
        customer: { select: { id: true, payment_type: true, tax_exempt: true } },
        service_location: { select: { state: true } },
        estimate: {
          include: {
            line_items: { orderBy: { sequence: 'asc' } },
            deposit: true,
          },
        },
        charges: { orderBy: { sequence: 'asc' } },
        invoice: { select: { id: true, status: true } },
      },
    });

    if (!job) return res.status(404).json({ error: 'Job not found' });
    if (job.status !== 'COMPLETED') return res.status(400).json({ error: 'Job must be COMPLETED to create an invoice' });

    // Check for existing non-voided invoice
    if (job.invoice && job.invoice.status !== 'VOIDED') {
      return res.status(400).json({ error: 'Job already has an invoice' });
    }

    // Technician guard
    if (req.user?.role === 'TECHNICIAN' && job.assigned_to !== req.user?.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // SALES cannot create invoices
    if (req.user?.role === 'SALES') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    // Check line items exist
    const estimateItems = job.estimate?.line_items || [];
    const jobCharges = job.charges || [];
    if (estimateItems.length === 0 && jobCharges.length === 0) {
      return res.status(400).json({ error: 'Cannot create invoice with no line items' });
    }

    // 2. Calculate totals
    const allItems = [
      ...estimateItems.map(i => ({ ...i, source: 'estimate' })),
      ...jobCharges.map(c => ({ ...c, source: 'job' })),
    ];

    const subtotal = allItems.reduce((sum, i) => sum + Number(i.line_total), 0);
    const discountAmount = job.estimate ? Number(job.estimate.discount_amount || 0) : 0;

    // Tax rate: from estimate for standard, from state tax rates for urgent
    let taxRate = 0;
    if (job.estimate) {
      taxRate = Number(job.estimate.tax_rate || 0);
    } else {
      // Urgent job: look up state tax rate
      const stateTax = await prisma.stateTaxRate.findFirst({
        where: { state_code: job.service_location.state },
      });
      taxRate = stateTax ? Number(stateTax.tax_rate) : 0;
    }

    // Tax calculation: discount applies only to estimate items
    let taxAmount = 0;
    if (!job.customer.tax_exempt) {
      // Taxable estimate items total
      const estimateTaxableTotal = estimateItems
        .filter(i => i.is_taxable)
        .reduce((sum, i) => sum + Number(i.line_total), 0);

      // Prorate discount across taxable estimate items
      const estimateSubtotal = estimateItems.reduce((sum, i) => sum + Number(i.line_total), 0);
      const discountOnTaxable = estimateSubtotal > 0
        ? (discountAmount * estimateTaxableTotal / estimateSubtotal)
        : 0;

      const adjustedEstimateTaxable = estimateTaxableTotal - discountOnTaxable;

      // Taxable job charges total (no discount applied)
      const jobChargeTaxable = jobCharges
        .filter(c => c.is_taxable)
        .reduce((sum, c) => sum + Number(c.line_total), 0);

      taxAmount = Math.round((adjustedEstimateTaxable + jobChargeTaxable) * taxRate * 100) / 100;
    }

    const totalAmount = Math.round((subtotal - discountAmount + taxAmount) * 100) / 100;

    // Deposit credit
    let depositCredit = 0;
    if (job.estimate?.deposit && job.estimate.deposit.status === 'PAID') {
      depositCredit = Number(job.estimate.deposit.amount) - Number(job.estimate.deposit.total_refunded || 0);
    }

    const amountDue = Math.round((totalAmount - depositCredit) * 100) / 100;

    // Due date
    const dueDate = calculateDueDate(job.customer.payment_type, new Date());

    // 3. Create invoice in transaction
    const invoice = await prisma.$transaction(async (tx: any) => {
      const invoiceNumber = await generateInvoiceNumber(tx);

      const created = await tx.invoice.create({
        data: {
          invoice_number: invoiceNumber,
          job_id: job.id,
          status: 'DRAFT',
          subtotal,
          discount_amount: discountAmount,
          tax_amount: taxAmount,
          deposit_credit: depositCredit,
          total_amount: totalAmount,
          amount_due: amountDue,
          due_date: dueDate,
        },
        select: invoiceDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          entity_type: 'INVOICE',
          entity_id: created.id,
          event_type: 'INVOICE_CREATED',
          description: `Invoice ${invoiceNumber} created`,
          created_by: req.user?.id,
        },
      });

      return created;
    });

    res.status(201).json({ invoice });
  } catch (err) {
    logger.error('Error creating invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 3: Write tests for create()**

Add to `backend/src/__tests__/invoices.test.ts` (create the file):

Test cases for create:
- Admin can create invoice from completed job (happy path)
- Returns 404 for non-existent job
- Returns 400 if job is not COMPLETED
- Returns 400 if job already has non-voided invoice
- Returns 400 if job has zero line items
- Returns 403 for SALES role
- Technician can create for own job only
- Technician gets 403 for other's job
- Correctly calculates deposit credit (PAID deposit)
- Correctly handles zero deposit (urgent job)
- Correctly applies tax_exempt flag
- Correctly calculates due date from payment_type
- Allows re-invoicing after void (existing invoice is VOIDED)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`
Expected: All new invoice create tests pass, all existing tests still pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts backend/src/__tests__/invoices.test.ts
git commit -m "feat: invoice create endpoint with tax calculation and deposit credit"
```

---

## Task 4: Invoice Controller — List, GetById, Edit, Delete

**Files:**
- Modify: `backend/src/controllers/invoice.controller.ts`
- Modify: `backend/src/__tests__/invoices.test.ts`

- [ ] **Step 1: Implement list() with bundled stats**

Follow the job controller's `list()` pattern with `Promise.all` for stats:

```typescript
export async function list(req: Request, res: Response) {
  try {
    const { page, limit, skip } = parsePagination(req.query);
    const search = (req.query.search as string) || '';
    const statusFilter = req.query.status ? (req.query.status as string).split(',') : undefined;
    const overdue = req.query.overdue === 'true';
    const createdAfter = req.query.created_after as string | undefined;
    const createdBefore = req.query.created_before as string | undefined;

    // Build where clause
    const where: any = {};

    // Role-based filtering
    if (req.user?.role === 'TECHNICIAN') {
      where.job = { assigned_to: req.user.id };
    } else if (req.user?.role === 'SALES') {
      where.job = { estimate: { lead: { assigned_to: req.user.id } } };
    }

    if (statusFilter) where.status = { in: statusFilter };
    if (overdue) {
      where.due_date = { lt: new Date() };
      where.status = { in: ['SENT', 'PARTIAL'] };
    }
    if (createdAfter) where.created_at = { ...where.created_at, gte: new Date(createdAfter) };
    if (createdBefore) where.created_at = { ...where.created_at, lte: new Date(createdBefore) };

    if (search) {
      where.OR = [
        { invoice_number: { contains: search, mode: 'insensitive' } },
        { job: { job_number: { contains: search, mode: 'insensitive' } } },
        { job: { customer: { first_name: { contains: search, mode: 'insensitive' } } } },
        { job: { customer: { last_name: { contains: search, mode: 'insensitive' } } } },
      ];
    }

    // Scope where for stats (respects role filtering but not status/search filters)
    const scopeWhere: any = {};
    if (req.user?.role === 'TECHNICIAN') {
      scopeWhere.job = { assigned_to: req.user.id };
    } else if (req.user?.role === 'SALES') {
      scopeWhere.job = { estimate: { lead: { assigned_to: req.user.id } } };
    }

    const now = new Date();

    const sortParams = parseSortParams(req.query as any, ['created_at', 'invoice_number', 'status', 'amount_due', 'due_date', 'total_amount']);

    const [invoices, total, dueStats, overdueStats, collectedStats, unsent, needInvoices] = await Promise.all([
      prisma.invoice.findMany({
        where,
        select: invoiceListSelect,
        skip,
        take: limit,
        orderBy: sortParams.orderBy || { created_at: 'desc' },
      }),
      prisma.invoice.count({ where }),
      // Due: SENT + PARTIAL
      prisma.invoice.aggregate({
        where: { ...scopeWhere, status: { in: ['SENT', 'PARTIAL'] } },
        _sum: { amount_due: true },
        _count: true,
      }),
      // Overdue: past due_date + SENT/PARTIAL
      prisma.invoice.aggregate({
        where: { ...scopeWhere, status: { in: ['SENT', 'PARTIAL'] }, due_date: { lt: now } },
        _sum: { amount_due: true },
        _count: true,
      }),
      // Collected this month
      prisma.payment.aggregate({
        where: {
          paid_at: {
            gte: new Date(now.getFullYear(), now.getMonth(), 1),
            lt: new Date(now.getFullYear(), now.getMonth() + 1, 1),
          },
        },
        _sum: { amount: true },
        _count: true,
      }),
      // Unsent (DRAFT)
      prisma.invoice.count({ where: { ...scopeWhere, status: 'DRAFT' } }),
      // Need invoices (completed jobs without non-voided invoice)
      prisma.job.count({
        where: {
          status: 'COMPLETED',
          OR: [
            { invoice: null },
            { invoice: { status: 'VOIDED' } },
          ],
        },
      }),
    ]);

    res.json({
      invoices,
      pagination: buildPaginationMeta(total, { page, limit, skip }),
      stats: {
        due: { total: dueStats._sum.amount_due || 0, count: dueStats._count },
        overdue: { total: overdueStats._sum.amount_due || 0, count: overdueStats._count },
        collected_this_month: { total: collectedStats._sum.amount || 0, count: collectedStats._count },
        unsent: unsent,
        need_invoices: needInvoices,
      },
    });
  } catch (err) {
    logger.error('Error listing invoices:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Implement getById()**

```typescript
export async function getById(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: invoiceDetailSelect,
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!canAccessInvoice(invoice, req)) return res.status(403).json({ error: 'Not authorized' });

    res.json({ invoice });
  } catch (err) {
    logger.error('Error fetching invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 3: Implement update() (DRAFT only, due_date)**

```typescript
export async function update(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, job: { select: { assigned_to: true, estimate: { select: { lead: { select: { assigned_to: true } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be edited' });

    const updated = await prisma.invoice.update({
      where: { id: req.params.id },
      data: { due_date: req.body.due_date ? new Date(req.body.due_date) : undefined },
      select: invoiceDetailSelect,
    });

    res.json({ invoice: updated });
  } catch (err) {
    logger.error('Error updating invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 4: Implement remove() (DRAFT only, hard delete)**

```typescript
export async function remove(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, job: { select: { assigned_to: true, estimate: { select: { lead: { select: { assigned_to: true } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be deleted' });

    await prisma.invoice.delete({ where: { id: req.params.id } });
    res.status(204).send();
  } catch (err) {
    logger.error('Error deleting invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 5: Write tests for list, getById, update, remove**

Test cases:
- list: returns paginated results with stats, filters by status, filters by overdue, search works, TECHNICIAN sees only own, SALES sees only own leads' invoices
- getById: returns full detail, 404 for missing, 403 for unauthorized
- update: can change due_date on DRAFT, 400 on non-DRAFT
- remove: deletes DRAFT, 400 on non-DRAFT, 404 on missing

- [ ] **Step 6: Run tests**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts backend/src/__tests__/invoices.test.ts
git commit -m "feat: invoice list with stats, getById, update, delete endpoints"
```

---

## Task 5: Invoice Controller — Send, Void, Notes

**Files:**
- Modify: `backend/src/controllers/invoice.controller.ts`
- Modify: `backend/src/__tests__/invoices.test.ts`

- [ ] **Step 1: Implement send()**

```typescript
export async function send(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: {
        ...invoiceDetailSelect,
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'DRAFT') return res.status(400).json({ error: 'Only DRAFT invoices can be sent' });

    const publicToken = crypto.randomUUID();
    const dueDate = invoice.due_date || calculateDueDate(invoice.job.customer.payment_type, new Date());

    const updated = await prisma.$transaction(async (tx: any) => {
      const inv = await tx.invoice.update({
        where: { id: req.params.id },
        data: {
          status: 'SENT',
          sent_at: new Date(),
          public_token: publicToken,
          due_date: dueDate,
        },
        select: invoiceDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          entity_type: 'INVOICE',
          entity_id: inv.id,
          event_type: 'INVOICE_SENT',
          description: `Invoice ${inv.invoice_number} sent to customer`,
          created_by: req.user?.id,
        },
      });

      return inv;
    });

    // Fire-and-forget email
    const publicUrl = `${env.FRONTEND_URL || ''}/p/invoices/${updated.id}?token=${publicToken}`;
    sendInvoiceEmail({
      to: updated.job.customer.email,
      customerName: `${updated.job.customer.first_name} ${updated.job.customer.last_name}`,
      invoiceNumber: updated.invoice_number,
      total: Number(updated.total_amount),
      amountDue: Number(updated.amount_due),
      dueDate: dueDate.toISOString(),
      publicUrl,
    }).catch(err => logger.error('Failed to send invoice email:', err));

    res.json({ invoice: updated });
  } catch (err) {
    logger.error('Error sending invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Implement voidInvoice()**

```typescript
export async function voidInvoice(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, status: true, invoice_number: true, job: { select: { assigned_to: true, estimate: { select: { lead: { select: { assigned_to: true } } } } } } },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status === 'PAID' || invoice.status === 'VOIDED') {
      return res.status(400).json({ error: 'Cannot void a PAID or already VOIDED invoice' });
    }
    if (invoice.status === 'DRAFT') {
      return res.status(400).json({ error: 'Use DELETE for DRAFT invoices' });
    }

    const updated = await prisma.$transaction(async (tx: any) => {
      const inv = await tx.invoice.update({
        where: { id: req.params.id },
        data: {
          status: 'VOIDED',
          voided_at: new Date(),
          voided_reason: req.body.voided_reason,
        },
        select: invoiceDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          entity_type: 'INVOICE',
          entity_id: inv.id,
          event_type: 'INVOICE_VOIDED',
          description: `Invoice ${invoice.invoice_number} voided: ${req.body.voided_reason}`,
          created_by: req.user?.id,
        },
      });

      return inv;
    });

    res.json({ invoice: updated });
  } catch (err) {
    logger.error('Error voiding invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 3: Implement getNotes() and addNote()**

Follow the existing polymorphic notes pattern from job/estimate controllers:

```typescript
export async function getNotes(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, job: { select: { assigned_to: true, estimate: { select: { lead: { select: { assigned_to: true } } } } } } },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (!canAccessInvoice(invoice, req)) return res.status(403).json({ error: 'Not authorized' });

    const notes = await prisma.note.findMany({
      where: { entity_type: 'INVOICE', entity_id: req.params.id },
      include: { creator: { select: { id: true, first_name: true, last_name: true } } },
      orderBy: { created_at: 'desc' },
    });

    res.json({ notes });
  } catch (err) {
    logger.error('Error fetching invoice notes:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}

export async function addNote(req: Request, res: Response) {
  try {
    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: { id: true, job: { select: { assigned_to: true, estimate: { select: { lead: { select: { assigned_to: true } } } } } } },
    });
    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    // Technician: own job only
    if (req.user?.role === 'TECHNICIAN' && invoice.job.assigned_to !== req.user?.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    // SALES cannot add notes
    if (req.user?.role === 'SALES') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    const note = await prisma.note.create({
      data: {
        entity_type: 'INVOICE',
        entity_id: req.params.id,
        content: req.body.content,
        created_by: req.user?.id!,
      },
      include: { creator: { select: { id: true, first_name: true, last_name: true } } },
    });

    res.status(201).json({ note });
  } catch (err) {
    logger.error('Error adding invoice note:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 4: Write tests for send, void, notes**

Test cases:
- send: DRAFT → SENT, generates public_token, sets sent_at, 400 on non-DRAFT
- void: SENT → VOIDED, requires reason, 400 on PAID, 400 on DRAFT (use DELETE), Admin only
- getNotes: returns notes, 404 on missing invoice
- addNote: creates note, SALES gets 403, Technician limited to own

- [ ] **Step 5: Run tests**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts backend/src/__tests__/invoices.test.ts
git commit -m "feat: invoice send, void, and notes endpoints"
```

---

## Task 6: Invoice Controller — Record Payment

**Files:**
- Modify: `backend/src/controllers/invoice.controller.ts`
- Modify: `backend/src/__tests__/invoices.test.ts`

- [ ] **Step 1: Implement recordPayment()**

This is the most critical function. Uses row-level locking to prevent race conditions:

```typescript
export async function recordPayment(req: Request, res: Response) {
  try {
    const { amount, method, paid_at, reference_number, notes } = req.body;

    const invoice = await prisma.invoice.findUnique({
      where: { id: req.params.id },
      select: {
        id: true,
        invoice_number: true,
        status: true,
        amount_due: true,
        job: {
          select: {
            assigned_to: true,
            customer: { select: { email: true, first_name: true, last_name: true } },
            estimate: { select: { lead: { select: { assigned_to: true } } } },
          },
        },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
      return res.status(400).json({ error: 'Payments can only be recorded on SENT or PARTIAL invoices' });
    }

    // Technician guard
    if (req.user?.role === 'TECHNICIAN' && invoice.job.assigned_to !== req.user?.id) {
      return res.status(403).json({ error: 'Not authorized' });
    }
    if (req.user?.role === 'SALES') {
      return res.status(403).json({ error: 'Not authorized' });
    }

    if (amount > Number(invoice.amount_due)) {
      return res.status(400).json({ error: 'Payment amount cannot exceed amount due' });
    }

    // Transaction with row lock
    const result = await prisma.$transaction(async (tx: any) => {
      // Re-read with lock to prevent race conditions
      const locked = await tx.$queryRaw`
        SELECT amount_due, status FROM invoices WHERE id = ${req.params.id} FOR UPDATE
      `;
      const currentDue = Number((locked as any[])[0].amount_due);

      if (amount > currentDue) {
        throw new Error('Payment amount exceeds current amount due');
      }

      const newAmountDue = Math.round((currentDue - amount) * 100) / 100;
      const isFullyPaid = newAmountDue <= 0;

      const payment = await tx.payment.create({
        data: {
          invoice_id: req.params.id,
          amount,
          method,
          paid_at: paid_at ? new Date(paid_at) : new Date(),
          collected_by: req.user?.id!,
          reference_number: reference_number || null,
          notes: notes || null,
        },
        include: {
          collector: { select: { id: true, first_name: true, last_name: true } },
        },
      });

      const updatedInvoice = await tx.invoice.update({
        where: { id: req.params.id },
        data: {
          amount_due: newAmountDue,
          status: isFullyPaid ? 'PAID' : 'PARTIAL',
          paid_at: isFullyPaid ? new Date() : undefined,
        },
        select: invoiceDetailSelect,
      });

      await tx.timelineEvent.create({
        data: {
          entity_type: 'INVOICE',
          entity_id: req.params.id,
          event_type: 'PAYMENT_RECEIVED',
          description: `Payment of $${amount.toFixed(2)} received via ${method}`,
          created_by: req.user?.id,
          metadata: { payment_id: payment.id, amount, method },
        },
      });

      if (isFullyPaid) {
        await tx.timelineEvent.create({
          data: {
            entity_type: 'INVOICE',
            entity_id: req.params.id,
            event_type: 'INVOICE_PAID',
            description: `Invoice ${invoice.invoice_number} paid in full`,
            created_by: req.user?.id,
          },
        });
      }

      return { invoice: updatedInvoice, payment, isFullyPaid };
    });

    // Fire-and-forget emails
    const customerName = `${invoice.job.customer.first_name} ${invoice.job.customer.last_name}`;
    sendPaymentReceivedEmail({
      to: invoice.job.customer.email,
      customerName,
      invoiceNumber: invoice.invoice_number,
      paymentAmount: amount,
      method,
      remainingDue: Number(result.invoice.amount_due),
    }).catch(err => logger.error('Failed to send payment received email:', err));

    if (result.isFullyPaid) {
      sendInvoicePaidEmail({
        to: invoice.job.customer.email,
        customerName,
        invoiceNumber: invoice.invoice_number,
        totalAmount: Number(result.invoice.total_amount),
      }).catch(err => logger.error('Failed to send invoice paid email:', err));
    }

    sendPaymentReceivedAlert({
      invoiceNumber: invoice.invoice_number,
      paymentAmount: amount,
      method,
      collectedBy: `${req.user?.first_name} ${req.user?.last_name}`,
      remainingDue: Number(result.invoice.amount_due),
    }).catch(err => logger.error('Failed to send payment alert:', err));

    res.status(201).json({ invoice: result.invoice, payment: result.payment });
  } catch (err: any) {
    if (err.message === 'Payment amount exceeds current amount due') {
      return res.status(400).json({ error: err.message });
    }
    logger.error('Error recording payment:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Write tests for recordPayment**

Test cases:
- Records payment successfully (SENT → PARTIAL)
- Full payment transitions SENT → PAID
- Full payment transitions PARTIAL → PAID
- Sets paid_at when fully paid
- Returns 400 if amount > amount_due
- Returns 400 if invoice status is DRAFT
- Returns 400 if invoice status is VOIDED
- Returns 403 for SALES role
- Technician can record on own job, 403 on other's
- Creates timeline event for payment
- Creates timeline event for fully paid
- Sends emails (verify email mock called)

- [ ] **Step 3: Run tests**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`

- [ ] **Step 4: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts backend/src/__tests__/invoices.test.ts
git commit -m "feat: record payment endpoint with row locking and status transitions"
```

---

## Task 7: Invoice Controller — Public Page & Stripe Checkout

**Files:**
- Modify: `backend/src/controllers/invoice.controller.ts`
- Modify: `backend/src/__tests__/invoices.test.ts`

- [ ] **Step 1: Implement getPublic()**

```typescript
export async function getPublic(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Token required' });

    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, public_token: token },
      select: {
        id: true,
        invoice_number: true,
        status: true,
        subtotal: true,
        discount_amount: true,
        tax_amount: true,
        deposit_credit: true,
        total_amount: true,
        amount_due: true,
        due_date: true,
        sent_at: true,
        paid_at: true,
        created_at: true,
        job: {
          select: {
            job_number: true,
            estimate: {
              select: {
                estimate_number: true,
                discount_name: true,
                discount_type: true,
                discount_value: true,
                tax_rate: true,
                line_items: {
                  select: { id: true, sequence: true, description: true, quantity: true, unit_price: true, is_taxable: true, line_total: true },
                  orderBy: { sequence: 'asc' as const },
                },
              },
            },
            charges: {
              select: { id: true, sequence: true, description: true, quantity: true, unit_price: true, is_taxable: true, line_total: true },
              orderBy: { sequence: 'asc' as const },
            },
            customer: {
              select: { first_name: true, last_name: true, email: true, phone: true },
            },
            service_location: {
              select: { address_line1: true, address_line2: true, city: true, state: true, zip: true },
            },
          },
        },
        payments: {
          select: { id: true, amount: true, method: true, paid_at: true },
          orderBy: { paid_at: 'asc' as const },
        },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });

    res.json({ invoice });
  } catch (err) {
    logger.error('Error fetching public invoice:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 2: Implement createPublicCheckout()**

```typescript
// NOTE: createCheckoutSession, getSurchargeRate, isStripeConfigured already imported at top of file

export async function createPublicCheckout(req: Request, res: Response) {
  try {
    const token = req.query.token as string;
    if (!token) return res.status(400).json({ error: 'Token required' });

    if (!isStripeConfigured()) {
      return res.status(400).json({ error: 'Card payments are not configured' });
    }

    const invoice = await prisma.invoice.findFirst({
      where: { id: req.params.id, public_token: token },
      select: {
        id: true,
        invoice_number: true,
        status: true,
        amount_due: true,
        job: {
          select: {
            customer: { select: { first_name: true, last_name: true } },
          },
        },
      },
    });

    if (!invoice) return res.status(404).json({ error: 'Invoice not found' });
    if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
      return res.status(400).json({ error: 'Invoice is not payable' });
    }

    const paymentAmount = Number(invoice.amount_due);
    const surchargeRate = getSurchargeRate();
    const surchargeAmount = Math.round(paymentAmount * surchargeRate * 100) / 100;
    const customerName = `${invoice.job.customer.first_name} ${invoice.job.customer.last_name}`;

    const baseUrl = process.env.FRONTEND_URL || '';
    const session = await createCheckoutSession({
      depositAmount: paymentAmount,  // reusing the same param name from deposit flow
      surchargeAmount,
      description: `Payment for Invoice ${invoice.invoice_number} — ${customerName}`,
      successUrl: `${baseUrl}/p/invoices/${invoice.id}?token=${token}&payment=success`,
      cancelUrl: `${baseUrl}/p/invoices/${invoice.id}?token=${token}&payment=cancelled`,
      metadata: { invoiceId: invoice.id },
    });

    res.json({ checkout_url: session.url, surcharge_amount: surchargeAmount });
  } catch (err) {
    logger.error('Error creating invoice checkout:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
}
```

- [ ] **Step 3: Write tests for getPublic and createPublicCheckout**

Test cases:
- getPublic: returns invoice with valid token, 404 with invalid token, 400 without token
- createPublicCheckout: creates Stripe session, returns checkout_url + surcharge, 400 on non-payable status, 400 if Stripe not configured

- [ ] **Step 4: Run tests**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts backend/src/__tests__/invoices.test.ts
git commit -m "feat: public invoice page and Stripe checkout endpoints"
```

---

## Task 8: Webhook Extension for Invoice Payments

**Files:**
- Modify: `backend/src/controllers/webhook.controller.ts`
- Modify: `backend/src/__tests__/webhook.test.ts` (or `invoices.test.ts`)

- [ ] **Step 1: Extend webhook handler**

In `backend/src/controllers/webhook.controller.ts`, modify the `checkout.session.completed` handler. The existing code checks `session.metadata?.depositId`. Add an `invoiceId` check before it:

Inside the existing `case 'checkout.session.completed'` block, add the invoice path **before** the existing `const depositId = session.metadata?.depositId` line. The existing top-level idempotency check already handles duplicates, so no per-branch check is needed:

```typescript
// NEW: Invoice payment path (before existing deposit path)
const invoiceId = session.metadata?.invoiceId;
if (invoiceId) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    select: {
      id: true,
      invoice_number: true,
      status: true,
      amount_due: true,
      total_amount: true,
      job: {
        select: {
          customer: { select: { email: true, first_name: true, last_name: true } },
        },
      },
    },
  });

  if (!invoice) {
    logger.warn(`Webhook: invoice ${invoiceId} not found`);
    return res.status(400).json({ error: 'Invoice not found' });
  }

  // Status guard: only process payable invoices
  if (invoice.status !== 'SENT' && invoice.status !== 'PARTIAL') {
    logger.warn(`Webhook: invoice ${invoiceId} not payable (status: ${invoice.status})`);
    // Still record event to prevent Stripe retries
    await prisma.stripeEvent.create({
      data: { stripe_event_id: event.id, event_type: event.type, processed_at: new Date() },
    });
    return res.json({ received: true, message: 'Invoice not payable' });
  }

  const paymentAmount = Number(invoice.amount_due);
  const surchargeRate = getSurchargeRate();
  const expectedTotal = Math.round((paymentAmount + paymentAmount * surchargeRate) * 100);
  const actualTotal = session.amount_total;

  if (actualTotal !== expectedTotal) {
    logger.warn(`Webhook: amount mismatch for invoice ${invoiceId}. Expected ${expectedTotal}, got ${actualTotal}`);
  }

  await prisma.$transaction(async (tx) => {
    const newAmountDue = 0; // Full payment via Stripe
    const payment = await tx.payment.create({
      data: {
        invoice_id: invoiceId,
        amount: paymentAmount,
        method: 'CARD',
        paid_at: new Date(),
        collected_by: null, // No user context in webhook — collected_by is nullable
        stripe_payment_intent_id: session.payment_intent as string,
      },
    });

    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        amount_due: newAmountDue,
        status: 'PAID',
        paid_at: new Date(),
      },
    });

    await tx.timelineEvent.create({
      data: {
        entity_type: 'INVOICE',
        entity_id: invoiceId,
        event_type: 'PAYMENT_RECEIVED',
        description: `Card payment of $${paymentAmount.toFixed(2)} received via Stripe`,
        metadata: { payment_id: payment.id, stripe_payment_intent_id: session.payment_intent },
      },
    });

    await tx.timelineEvent.create({
      data: {
        entity_type: 'INVOICE',
        entity_id: invoiceId,
        event_type: 'INVOICE_PAID',
        description: `Invoice ${invoice.invoice_number} paid in full`,
      },
    });

    await tx.stripeEvent.create({
      data: {
        stripe_event_id: event.id,
        event_type: event.type,
        processed_at: new Date(),
      },
    });
  });

  // Fire-and-forget emails
  const customerName = `${invoice.job.customer.first_name} ${invoice.job.customer.last_name}`;
  sendPaymentReceivedEmail({
    to: invoice.job.customer.email,
    customerName,
    invoiceNumber: invoice.invoice_number,
    paymentAmount,
    method: 'CARD',
    remainingDue: 0,
  }).catch(err => logger.error('Webhook email error:', err));

  sendInvoicePaidEmail({
    to: invoice.job.customer.email,
    customerName,
    invoiceNumber: invoice.invoice_number,
    totalAmount: Number(invoice.total_amount),
  }).catch(err => logger.error('Webhook email error:', err));

  sendPaymentReceivedAlert({
    invoiceNumber: invoice.invoice_number,
    paymentAmount,
    method: 'CARD',
    collectedBy: 'Stripe (online)',
    remainingDue: 0,
  }).catch(err => logger.error('Webhook alert error:', err));

  return res.json({ received: true });
}

// EXISTING: Deposit payment path (keep as-is)
const depositId = session.metadata?.depositId;
// ... existing deposit handling code ...
```

Note: `collected_by` is nullable (updated in Task 1 migration). Webhook payments set it to null.

- [ ] **Step 2: Write tests for invoice webhook path**

Test cases:
- Successfully processes invoice payment via webhook
- Idempotency: skips already-processed event
- Sets invoice to PAID
- Creates Payment record with CARD method
- Creates timeline events
- Sends emails
- Falls through to deposit path if no invoiceId

- [ ] **Step 3: Run tests**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`

- [ ] **Step 4: Commit**

```bash
git add backend/src/controllers/webhook.controller.ts backend/src/__tests__/
git commit -m "feat: extend Stripe webhook for invoice card payments"
```

---

## Task 9: Email Functions

**Files:**
- Modify: `backend/src/lib/email.ts`

- [ ] **Step 1: Add 4 invoice email functions**

Add to the end of `backend/src/lib/email.ts`, following the existing patterns (params object, guard on `resend`, try/catch with logging, HTML template):

```typescript
export async function sendInvoiceEmail(params: {
  to: string;
  customerName: string;
  invoiceNumber: string;
  total: number;
  amountDue: number;
  dueDate: string;
  publicUrl: string;
}): Promise<void> {
  if (!resend) { logger.warn('RESEND_API_KEY not set — skipping invoice email'); return; }
  try {
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: `Invoice ${params.invoiceNumber} from ALPHA CRM`,
      html: wrapHtml(`
        <h2>Invoice ${params.invoiceNumber}</h2>
        <p>Hi ${params.customerName},</p>
        <p>Your invoice for <strong>${formatCurrency(params.total)}</strong> is ready.</p>
        <p>Amount due: <strong>${formatCurrency(params.amountDue)}</strong></p>
        <p>Due date: <strong>${new Date(params.dueDate).toLocaleDateString()}</strong></p>
        <div style="text-align:center;margin:24px 0">
          <a href="${params.publicUrl}" style="background:#2563EB;color:#fff;padding:12px 32px;border-radius:6px;text-decoration:none;font-weight:600">View & Pay Invoice</a>
        </div>
      `),
    });
    logger.info(`Invoice email sent to ${params.to} for ${params.invoiceNumber}`);
  } catch (err) { logger.error(`Failed to send invoice email for ${params.invoiceNumber}:`, err); }
}

export async function sendPaymentReceivedEmail(params: {
  to: string;
  customerName: string;
  invoiceNumber: string;
  paymentAmount: number;
  method: string;
  remainingDue: number;
}): Promise<void> {
  if (!resend) { logger.warn('RESEND_API_KEY not set — skipping payment email'); return; }
  try {
    const isPaidInFull = params.remainingDue <= 0;
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: `Payment Received — Invoice ${params.invoiceNumber}`,
      html: wrapHtml(`
        <h2>Payment Received</h2>
        <p>Hi ${params.customerName},</p>
        <p>We received your payment of <strong>${formatCurrency(params.paymentAmount)}</strong> via ${params.method}.</p>
        ${isPaidInFull
          ? '<p style="color:#059669;font-weight:600">Your invoice is now paid in full. Thank you!</p>'
          : `<p>Remaining balance: <strong>${formatCurrency(params.remainingDue)}</strong></p>`
        }
      `),
    });
    logger.info(`Payment receipt sent to ${params.to} for ${params.invoiceNumber}`);
  } catch (err) { logger.error(`Failed to send payment email for ${params.invoiceNumber}:`, err); }
}

export async function sendInvoicePaidEmail(params: {
  to: string;
  customerName: string;
  invoiceNumber: string;
  totalAmount: number;
}): Promise<void> {
  if (!resend) { logger.warn('RESEND_API_KEY not set — skipping paid email'); return; }
  try {
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to: params.to,
      subject: `Invoice ${params.invoiceNumber} — Paid in Full`,
      html: wrapHtml(`
        <h2>Invoice Paid in Full</h2>
        <p>Hi ${params.customerName},</p>
        <p>Your invoice <strong>${params.invoiceNumber}</strong> for <strong>${formatCurrency(params.totalAmount)}</strong> has been paid in full.</p>
        <p>Thank you for your business!</p>
      `),
    });
    logger.info(`Paid-in-full email sent to ${params.to} for ${params.invoiceNumber}`);
  } catch (err) { logger.error(`Failed to send paid email for ${params.invoiceNumber}:`, err); }
}

export async function sendPaymentReceivedAlert(params: {
  invoiceNumber: string;
  paymentAmount: number;
  method: string;
  collectedBy: string;
  remainingDue: number;
}): Promise<void> {
  if (!resend) { logger.warn('RESEND_API_KEY not set — skipping payment alert'); return; }
  try {
    await resend.emails.send({
      from: env.EMAIL_FROM,
      to: env.EMAIL_FROM, // Send to company email (or admin users — configure as needed)
      subject: `[Internal] Payment received on ${params.invoiceNumber}`,
      html: wrapHtml(`
        <h2>Payment Received</h2>
        <p><strong>${formatCurrency(params.paymentAmount)}</strong> received on invoice ${params.invoiceNumber}</p>
        <p>Method: ${params.method}</p>
        <p>Collected by: ${params.collectedBy}</p>
        <p>Remaining: ${params.remainingDue <= 0 ? '<span style="color:#059669">Paid in Full</span>' : formatCurrency(params.remainingDue)}</p>
      `),
    });
    logger.info(`Payment alert sent for ${params.invoiceNumber}`);
  } catch (err) { logger.error(`Failed to send payment alert for ${params.invoiceNumber}:`, err); }
}
```

- [ ] **Step 2: Commit**

```bash
git add backend/src/lib/email.ts
git commit -m "feat: add 4 invoice email functions (sent, payment, paid, alert)"
```

---

## Task 10: Routes & App Registration

**Files:**
- Create: `backend/src/routes/invoice.routes.ts`
- Modify: `backend/src/app.ts`

- [ ] **Step 1: Create invoice routes file**

Create `backend/src/routes/invoice.routes.ts`:

```typescript
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { authorize } from '../middleware/authorize';
import { validate } from '../middleware/validate';
import { publicReadLimiter, publicActionLimiter } from '../middleware/rate-limit';
import * as invoiceController from '../controllers/invoice.controller';

const router = Router();

// Public routes (no auth) — with rate limiting
router.get('/:id/public', publicReadLimiter, invoiceController.getPublic);
router.post('/:id/public/checkout', publicActionLimiter, invoiceController.createPublicCheckout);

// Auth-gated routes
router.use(authenticate);

// CRUD
router.get('/', authorize('ADMIN', 'DISPATCHER', 'TECHNICIAN', 'SALES'), invoiceController.list);
router.post('/', authorize('ADMIN', 'DISPATCHER', 'TECHNICIAN'), validate(invoiceController.createInvoiceSchema), invoiceController.create);
router.get('/:id', authorize('ADMIN', 'DISPATCHER', 'TECHNICIAN', 'SALES'), invoiceController.getById);
router.patch('/:id', authorize('ADMIN', 'DISPATCHER'), validate(invoiceController.editInvoiceSchema), invoiceController.update);
router.delete('/:id', authorize('ADMIN', 'DISPATCHER'), invoiceController.remove);

// Actions
router.post('/:id/send', authorize('ADMIN', 'DISPATCHER'), invoiceController.send);
router.post('/:id/void', authorize('ADMIN'), validate(invoiceController.voidInvoiceSchema), invoiceController.voidInvoice);

// Payments
router.post('/:id/payments', authorize('ADMIN', 'DISPATCHER', 'TECHNICIAN'), validate(invoiceController.recordPaymentSchema), invoiceController.recordPayment);

// Notes
router.get('/:id/notes', authorize('ADMIN', 'DISPATCHER', 'TECHNICIAN', 'SALES'), invoiceController.getNotes);
router.post('/:id/notes', authorize('ADMIN', 'DISPATCHER', 'TECHNICIAN'), validate(invoiceController.addNoteSchema), invoiceController.addNote);

export default router;
```

- [ ] **Step 2: Register routes in app.ts**

In `backend/src/app.ts`, add import and route registration:

```typescript
import invoiceRoutes from './routes/invoice.routes';
```

And add before the 404 handler:

```typescript
app.use('/api/invoices', invoiceRoutes);
```

- [ ] **Step 3: Run all tests to verify everything works together**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -50`
Expected: All tests pass (existing + new invoice tests).

- [ ] **Step 4: Commit**

```bash
git add backend/src/routes/invoice.routes.ts backend/src/app.ts
git commit -m "feat: register invoice routes with auth and rate limiting"
```

---

## Task 11: Extend Global Search

**Files:**
- Modify: `backend/src/controllers/search.controller.ts`

- [ ] **Step 1: Add invoice search to global search**

In the `search()` function, add an invoice query alongside the existing job/customer/lead/estimate queries. Follow the existing `safeQuery()` pattern:

Add an invoice search query that searches by `invoice_number` and customer name, returns `{ id, invoice_number, status, amount_due, total_amount, job: { customer: { first_name, last_name } } }`.

- [ ] **Step 2: Run all tests**

Run: `cd backend && npm test -- --reporter=verbose 2>&1 | tail -30`

- [ ] **Step 3: Commit**

```bash
git add backend/src/controllers/search.controller.ts
git commit -m "feat: add invoices to global search"
```

---

## Task 12: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `cd backend && npm test -- --reporter=verbose`
Expected: All tests pass. Note the total count.

- [ ] **Step 2: Type check**

Run: `cd backend && npx tsc --noEmit`
Expected: No errors.

- [ ] **Step 3: Validate Prisma schema**

Run: `cd backend && npx prisma validate`
Expected: Valid.

- [ ] **Step 4: Final commit if any remaining changes**

```bash
git add -A && git status
# Review, then commit if needed
```
