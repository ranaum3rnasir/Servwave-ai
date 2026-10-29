# Step 9C — Stripe Test-Mode Verification & Production-Readiness — Implementation Plan

> **Stale hostname, 2026-08-25:** the webhook URL below names `staging.alphacrm.com`, which never
> carried the app — `alphacrm.com` is a parked domain. Staging's API is
> `alpha-crm-test-env.onrender.com`. `stripe-environment-config.md` is the live source for
> webhook endpoints; this file is a record of the 9C design/plan.

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Stripe integration production-ready in single-tenant mode, fix two real gaps (invoice refund + dashboard-refund sync), tighten idempotency, and prepare the multi-tenant infrastructure seam for 9C2 (Stripe Connect Standard onboarding).

**Architecture:** Phase-driven execution. Schema migration first to unblock the new code paths. New code uses TDD (write failing test → implement → run). Refactors are protected by the existing 605-test safety net. Verification harness is the final gate before browser walk-through and docs.

**Tech Stack:** Node 20, Express, TypeScript, Prisma, PostgreSQL (Supabase), Stripe SDK `^17.7.0`, Vitest, supertest. Frontend: React 18 + TypeScript + TanStack Query + shadcn/ui. Stripe API version pinned: `2025-02-24.acacia`.

**Companion docs:**
- Approved design: `md_files/plans/payments/2026-04-29-stripe-test-mode-verification-design.md` (referenced as "spec §X.Y" throughout)
- Vault note for ongoing context: `Architecture/Stripe-Integration.md` (will be rewritten in Phase 10)

**Worktree convention:** Per CLAUDE.md rule 9, work happens in `C:\Users\ranro\Documents\ALPHA_CRM\alpha_crm-worktrees\stripe-9c\` on branch `feat/stripe-9c-production-ready`.

---

## File Structure (what gets created or modified)

| File | Action | Responsibility |
|---|---|---|
| `backend/prisma/schema.prisma` | Modify | Add `Organization.stripe_account_id`, Invoice refund fields, Payment refund fields, `InvoiceStatus.REFUNDED`, `User.refunded_invoices` back-relation |
| `backend/prisma/migrations/<ts>_stripe_9c/migration.sql` | Create (auto by Prisma) | Single migration for all schema changes above |
| `backend/src/lib/stripe.ts` | Modify | Add `getStripeForOrg(org)` (sync), make `_platformStripe()` private, extend `createCheckoutSession` and `createRefund` signatures to accept `ctx` and `metadata` |
| `backend/src/controllers/estimate.controller.ts` | Modify | Refactor 2 Stripe call sites (approve, refund-deposit) to use `getStripeForOrg(org)`; add `metadata: { source: 'in_app', depositId }` on deposit refund |
| `backend/src/controllers/invoice.controller.ts` | Modify | Refactor 1 call site (public checkout); add `refundInvoice` handler + `refundInvoiceSchema` |
| `backend/src/controllers/webhook.controller.ts` | Modify | Add `resolveOrgFromEvent` helper, `charge.refunded` case, P2002 idempotency catch (move `stripeEvent.create` to FIRST in transactions), explicit `DuplicateWebhookError` outer catch returning 200 |
| `backend/src/routes/invoice.routes.ts` | Modify | Add `POST /:id/refund` route (ADMIN only) |
| `backend/src/__tests__/invoices.test.ts` | Modify | Add tests for `refundInvoice` (happy + R5 multi-payment rejection + non-PAID + no-Stripe payment) |
| `backend/src/__tests__/webhook.test.ts` | Modify | Add tests for `charge.refunded` (invoice path × in_app/dashboard, deposit path × in_app/dashboard, unknown PI), P2002 catch path, DuplicateWebhookError → 200 |
| `backend/src/__tests__/stripe-lib.test.ts` | Create | Unit tests for `getStripeForOrg`, `resolveOrgFromEvent` |
| `backend/scripts/verify-stripe.ts` | Create | Verification harness — preflight + 10 flow tests + sandboxed fixtures |
| `backend/scripts/verify-stripe/preflight.ts` | Create | Env vars + backend reachability + Stripe API version drift check (R6) |
| `backend/scripts/verify-stripe/fixtures.ts` | Create | `setupFixtures()` + `teardownFixtures()` with `9C-VERIFY-` namespace (R7) |
| `backend/scripts/verify-stripe/sign.ts` | Create | Webhook signing helper using `stripe.webhooks.generateTestHeaderString` |
| `backend/package.json` | Modify | Add `verify:stripe` script |
| `frontend/src/components/invoices/RefundInvoiceDialog.tsx` | Create | Mirror of `RefundDepositDialog.tsx` |
| `frontend/src/pages/InvoiceDetailPage.tsx` | Modify | Mount Refund button (ADMIN only) + dialog |
| `md_files/plans/payments/2026-04-29-stripe-test-mode-verification.md` | Create | Live verification checklist (the runbook user follows in Phase 9) |
| `md_files/plans/payments/stripe-environment-config.md` | Create | Standalone Stripe environment configuration runbook |
| `PRE-LAUNCH-CHECKLIST.md` | Modify | Replace stale Stripe TODOs with pointers to the runbook |
| `Vault: Architecture/Stripe-Integration.md` | Modify | Rewrite for production-ready + Connect-ready architecture |
| `Vault: Status/Build-Progress.md` | Modify | Flip 9C from ⬜ to ✅ |
| `Vault: Status/Current-Focus.md` | Modify | Update next step to 9D Notifications |
| `Vault: log.md` | Append | Session entry |

---

## Phase 0 — Setup (worktree + prerequisites)

**Acceptance criteria:** Worktree created, stripe-cli installed and authenticated, `backend/.env` has Stripe test keys, `stripe listen` is forwarding to localhost, backend starts cleanly.

### Task 0.1: Create worktree

- [ ] **Step 1: Create branch + worktree**

```bash
git worktree add C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm-worktrees/stripe-9c -b feat/stripe-9c-production-ready
```

Expected: worktree directory created, branch created off main.

- [ ] **Step 2: Install dependencies in worktree**

```bash
cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm-worktrees/stripe-9c
npm install
```

Expected: clean install, no errors.

### Task 0.2: Install stripe-cli (Windows)

- [ ] **Step 1: Install via Scoop**

```bash
scoop install stripe
```

Expected: `Stripe CLI installed successfully`.

- [ ] **Step 2: Verify install**

```bash
stripe --version
```

Expected: prints version number (e.g. `stripe version 1.x.x`).

- [ ] **Step 3: Authenticate**

```bash
stripe login
```

Expected: opens browser, you grant access, terminal prints `Done! You are authenticated...`.

### Task 0.3: Get Stripe test keys + register staging webhook

- [ ] **Step 1: Capture test API keys** (manual — user does this)

Open Stripe dashboard (test mode) → Developers → API keys → reveal test secret key (`sk_test_*`). Capture publishable key too (`pk_test_*`).

- [ ] **Step 2: Start `stripe listen` to forward webhooks**

In a dedicated terminal that stays open:

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

Expected: prints a webhook signing secret like `whsec_test_abcd1234...`. **Copy this — it's the local-dev `STRIPE_WEBHOOK_SECRET`.**

- [ ] **Step 3: Register staging webhook endpoint** (manual — user does this if not already done)

Stripe dashboard (test mode) → Developers → Webhooks → "Add endpoint":
- URL: `https://staging.alphacrm.com/api/webhooks/stripe`
- Events: `checkout.session.completed`, `charge.refunded`
- Copy the staging signing secret (different from local).

(Note: this step is verified separately during Phase 10 documentation; at this point we just need staging to receive events for later harness testing.)

### Task 0.4: Configure backend/.env with test keys

- [ ] **Step 1: Edit `backend/.env`**

Add (or update if existing):

```
STRIPE_SECRET_KEY=sk_test_<your_test_key_here>
STRIPE_WEBHOOK_SECRET=whsec_test_<from stripe listen output>
CREDIT_CARD_SURCHARGE_RATE=3.5
```

- [ ] **Step 2: Restart backend with the new env**

```bash
cd backend && npm run dev
```

Expected: backend starts, log line confirms env loaded, no Stripe-related errors.

- [ ] **Step 3: Verify Stripe is configured**

In a separate terminal:

```bash
curl -s http://localhost:3000/health || curl -s http://localhost:3000/api/health
```

Expected: 200 OK. Then check the backend log for any startup warnings about missing Stripe config — there should be none.

### Task 0.5: Confirm baseline tests still pass

- [ ] **Step 1: Run full backend suite**

```bash
cd backend && npm test
```

Expected: all 605 tests pass. **This is the baseline. If anything fails here, stop and triage before proceeding.**

- [ ] **Step 2: Commit env setup notes (no secrets)**

```bash
git add -A  # only docs/config files; .env is gitignored
git status  # verify .env is NOT in the staged set
git commit -m "chore: setup 9C — install stripe-cli, configure backend .env"
```

### Task 0.6: Read current Stripe API version from code (avoid drift)

- [ ] **Step 1: Capture the existing pin**

```bash
grep "apiVersion" backend/src/lib/stripe.ts
```

Expected output: `apiVersion: '2025-02-24.acacia'` (or whatever value is currently pinned). **Use whatever value the file shows** in all subsequent code snippets — do not assume `2025-02-24.acacia` if the file shows something else.

- [ ] **Step 2: Factor it into a single exported constant in Task 2.1**

When editing `lib/stripe.ts` in Task 2.1, add at the top:

```typescript
export const STRIPE_API_VERSION = '2025-02-24.acacia';  // [USE the captured pin from Step 1]
```

Then use `STRIPE_API_VERSION` in `_platformStripe()` and import it in `scripts/verify-stripe/sign.ts` (Task 7.4) and the preflight (Task 7.2). Single source of truth.

---

## Phase 1 — Schema Migration

**Acceptance criteria:** Migration applied, new fields visible via `prisma studio`, existing 605 tests still pass.

### Task 1.1: Add fields to schema.prisma

- [ ] **Step 1: Edit `backend/prisma/schema.prisma` — Organization model**

Find the `Organization` model (search: `model Organization {`). Add this field alongside existing fields:

```prisma
model Organization {
  // ... existing fields ...
  stripe_account_id String?  // null = platform-managed; set after Connect onboarding (9C2)

  @@index([stripe_account_id])
}
```

- [ ] **Step 2: Edit Invoice model — add refund fields**

Find `model Invoice {` (around line 366). Add:

```prisma
  total_refunded          Decimal   @default(0) @db.Decimal(12, 2)
  refunded_at             DateTime?
  refund_reason           String?
  refund_reason_category  String?
  refunded_by             String?   @db.Uuid
  refunded_by_user        User?     @relation("InvoiceRefundedBy", fields: [refunded_by], references: [id])
```

- [ ] **Step 3: Edit Payment model — add refund fields**

Find `model Payment {` (around line 397). Add:

```prisma
  refunded_at      DateTime?
  refunded_amount  Decimal?  @db.Decimal(12, 2)
```

- [ ] **Step 4: Add REFUNDED to InvoiceStatus enum**

Find `enum InvoiceStatus {` (around line 582). Add:

```prisma
enum InvoiceStatus {
  DRAFT
  SENT
  PARTIAL
  PAID
  VOIDED
  REFUNDED
}
```

- [ ] **Step 5: Add User back-relation for `InvoiceRefundedBy`**

Find `model User {`. Add (next to other invoice-related relations if any, otherwise as a new line):

```prisma
  refunded_invoices  Invoice[]  @relation("InvoiceRefundedBy")
```

### Task 1.2: Generate and apply the migration

- [ ] **Step 1: Validate the schema**

```bash
cd backend && npx prisma validate
```

Expected: `The schema at .../schema.prisma is valid 🚀`.

- [ ] **Step 2: Create + apply the migration**

```bash
npx prisma migrate dev --name stripe_9c
```

Expected:
- New folder `backend/prisma/migrations/<timestamp>_stripe_9c/` created
- `migration.sql` contains ALTER TABLE for organizations, invoices, payments + new enum value
- Database is up to date

- [ ] **Step 3: Visually verify migration SQL**

```bash
cat backend/prisma/migrations/*stripe_9c*/migration.sql
```

Expected: ALTER TABLE statements only; no DROP statements; new index on organizations(stripe_account_id).

### Task 1.3: Regenerate Prisma client + verify

- [ ] **Step 1: Generate client**

```bash
cd backend && npx prisma generate
```

Expected: `Generated Prisma Client (v...)`.

- [ ] **Step 2: Run baseline tests**

```bash
npm test
```

Expected: all 605 tests still pass — schema additions are additive, nothing should break.

- [ ] **Step 3: Commit**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/
git commit -m "feat(payments): schema migration for invoice refunds + Connect infra (9C)"
```

---

## Phase 2 — Connect Infrastructure (sync `getStripeForOrg` + `resolveOrgFromEvent` + refactor)

**Acceptance criteria:** All Stripe call sites use the new sync indirection, webhook handler resolves org from event metadata, all 605 tests still pass + new unit tests for the indirection pass.

### Task 2.1: Add `getStripeForOrg(org)` to `lib/stripe.ts`

- [ ] **Step 1: Write the failing unit test**

Create `backend/src/__tests__/stripe-lib.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStripeForOrg } from '../lib/stripe';

vi.mock('../config/env', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_dummy',
    STRIPE_WEBHOOK_SECRET: 'whsec_dummy',
    CREDIT_CARD_SURCHARGE_RATE: '3.5',
    NODE_ENV: 'test',
  },
}));

describe('getStripeForOrg', () => {
  it('returns the platform Stripe singleton with stripeAccount=undefined when org.stripe_account_id is null', () => {
    const ctx = getStripeForOrg({ stripe_account_id: null });
    expect(ctx.stripe).toBeDefined();
    expect(ctx.stripeAccount).toBeUndefined();
  });

  it('forwards stripe_account_id to ctx.stripeAccount when set (9C2-ready)', () => {
    const ctx = getStripeForOrg({ stripe_account_id: 'acct_test_connect_123' });
    expect(ctx.stripeAccount).toBe('acct_test_connect_123');
  });

  it('returns the same Stripe singleton across calls', () => {
    const a = getStripeForOrg({ stripe_account_id: null });
    const b = getStripeForOrg({ stripe_account_id: null });
    expect(a.stripe).toBe(b.stripe);
  });
});
```

- [ ] **Step 2: Run the test — expect failure**

```bash
cd backend && npx vitest run src/__tests__/stripe-lib.test.ts
```

Expected: FAIL — `getStripeForOrg` is not exported from `../lib/stripe`.

- [ ] **Step 3: Edit `backend/src/lib/stripe.ts`**

Refactor the file to make `getStripe()` internal and add the new public API. See spec §3.2 for full pattern. The change set:

```typescript
// Rename getStripe → _platformStripe (internal, no export)
function _platformStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured. Set STRIPE_SECRET_KEY in environment.');
  }
  if (!_stripe) {
    _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '2025-02-24.acacia' });
  }
  return _stripe;
}

// New public API
export function getStripeForOrg(org: { stripe_account_id: string | null }): {
  stripe: Stripe;
  stripeAccount?: string;
} {
  return {
    stripe: _platformStripe(),
    stripeAccount: org.stripe_account_id ?? undefined,
  };
}

// Keep isStripeConfigured() and getSurchargeRate() unchanged

// Extend createCheckoutSession signature
export async function createCheckoutSession(
  options: {
    depositAmount: number;
    surchargeAmount: number;
    description: string;
    successUrl: string;
    cancelUrl: string;
    metadata: Record<string, string>;
  },
  ctx: { stripe: Stripe; stripeAccount?: string },
): Promise<Stripe.Checkout.Session> {
  const totalCents = Math.round((options.depositAmount + options.surchargeAmount) * 100);

  const session = await ctx.stripe.checkout.sessions.create(
    {
      payment_method_types: ['card'],
      // ... existing params unchanged ...
    },
    ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined,
  );

  return session;
}

// Extend createRefund signature
export async function createRefund(
  paymentIntentId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
  amountInCents?: number,
  options?: { metadata?: Record<string, string> },
): Promise<Stripe.Refund> {
  const params: Stripe.RefundCreateParams = { payment_intent: paymentIntentId };
  if (amountInCents) params.amount = amountInCents;
  if (options?.metadata) params.metadata = options.metadata;
  return ctx.stripe.refunds.create(
    params,
    ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined,
  );
}

// constructWebhookEvent: keep using _platformStripe internally; webhook signature verification doesn't need org context
```

Add a code comment near `payment_method_types: ['card']`:

```typescript
// IMPORTANT: 'card' only. If we add Link/ACH/SEPA/Klarna, those complete asynchronously
// and we MUST add payment_intent.succeeded webhook handling. See spec §1 out-of-scope.
payment_method_types: ['card'],
```

- [ ] **Step 4: Run the test — expect pass**

```bash
npx vitest run src/__tests__/stripe-lib.test.ts
```

Expected: 3 tests pass.

### Task 2.2: Refactor `estimate.controller.ts` call sites

- [ ] **Step 1: Read the current state to anchor the refactor**

```bash
grep -n "getStripe\|createCheckoutSession\|createRefund" backend/src/controllers/estimate.controller.ts
```

This shows the call site lines. Spec §3.3 lists 2 sites in this file: approve estimate (creates session for deposit) and refund deposit.

- [ ] **Step 2: Update approve-estimate site**

At the call to `createCheckoutSession`, ensure the estimate query includes `organization` (extend the `include`). Then:

```typescript
const ctx = getStripeForOrg(estimate.organization);
const session = await createCheckoutSession({
  // ... existing options ...
}, ctx);
```

- [ ] **Step 3: Update refund-deposit site**

The existing `refundDeposit` query at `estimate.controller.ts:1851-1857` uses `select` (not `include`). **Mixing `select` and `include` is invalid in Prisma — extend the existing `select` shape:**

```typescript
const existing = await prisma.estimate.findUnique({
  where: { id: estimateId },
  select: {
    id: true,
    status: true,
    estimate_number: true,
    lead_id: true,
    organization: { select: { id: true, stripe_account_id: true } },  // NEW
    deposit: {
      select: {
        id: true,
        status: true,
        amount: true,
        stripe_payment_intent_id: true,
      },
    },
    // ... preserve any other fields the existing select had
  },
});
```

**Replace the existing call site at `estimate.controller.ts:1886`:**

```diff
- await createRefund(existing.deposit.stripe_payment_intent_id);
+ const ctx = getStripeForOrg(existing.organization);
+ await createRefund(
+   existing.deposit.stripe_payment_intent_id,
+   ctx,
+   undefined,
+   { metadata: { source: 'in_app', depositId: existing.deposit.id } },  // R2 race resolution
+ );
```

- [ ] **Step 4: Inventory + update mock call sites in tests**

Before running tests, identify what existing mocks will break:

```bash
cd backend && grep -rn "createCheckoutSession\|createRefund" src/__tests__/
```

For each match in `estimates.test.ts` and `invoices.test.ts`, the mock must update from expecting `(opts)` or `(paymentIntentId)` to the new shape:
- `createCheckoutSession(opts, ctx)` — 2 args
- `createRefund(paymentIntentId, ctx, amountInCents?, options?)` — 4 args (last 2 optional)

Common patterns to update:
- `expect(createCheckoutSession).toHaveBeenCalledWith(opts)` → `expect(createCheckoutSession).toHaveBeenCalledWith(opts, expect.objectContaining({ stripe: expect.anything() }))`
- `vi.mocked(createRefund).mockResolvedValue(...)` — return value unchanged, but call assertions update

- [ ] **Step 5: Run estimate tests**

```bash
npx vitest run src/__tests__/estimates.test.ts
```

Expected: pass after mocks updated.

### Task 2.3: Refactor `invoice.controller.ts` call site (public checkout)

- [ ] **Step 1: Find the call site**

```bash
grep -n "createCheckoutSession" backend/src/controllers/invoice.controller.ts
```

- [ ] **Step 2: Update — load `organization` on the invoice query, then**

```typescript
const ctx = getStripeForOrg(invoice.organization);
const session = await createCheckoutSession(opts, ctx);
```

- [ ] **Step 3: Run invoice tests**

```bash
npx vitest run src/__tests__/invoices.test.ts
```

Expected: pass (after mock signature updates if needed).

### Task 2.4: Add `resolveOrgFromEvent` helper to `webhook.controller.ts`

- [ ] **Step 1: Write failing unit test in `stripe-lib.test.ts`**

Add to `backend/src/__tests__/stripe-lib.test.ts`. **Add the prisma mock block at the top of the file** (matches the pattern in `webhook.test.ts`):

```typescript
import { prisma } from '../lib/prisma';
import { resolveOrgFromEvent } from '../controllers/webhook.controller';

vi.mock('../lib/prisma', () => ({
  prisma: {
    deposit: { findUnique: vi.fn(), findFirst: vi.fn() },
    invoice: { findUnique: vi.fn() },
    payment: { findFirst: vi.fn() },
    organization: { findFirst: vi.fn() },
  },
}));

describe('resolveOrgFromEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves org via depositId metadata for checkout.session.completed (deposit path)', async () => {
    const mockDeposit = { estimate: { organization: { id: 'org_1', stripe_account_id: null } } };
    (prisma.deposit.findUnique as any).mockResolvedValue(mockDeposit);

    const event = {
      id: 'evt_1',
      type: 'checkout.session.completed',
      account: undefined,
      data: { object: { metadata: { depositId: 'dep_1' } } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_1');
    expect(prisma.deposit.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'dep_1' },
    }));
  });

  it('resolves org via invoiceId metadata', async () => {
    const mockInvoice = { organization: { id: 'org_2', stripe_account_id: null } };
    (prisma.invoice.findUnique as any).mockResolvedValue(mockInvoice);

    const event = {
      id: 'evt_2',
      type: 'checkout.session.completed',
      account: undefined,
      data: { object: { metadata: { invoiceId: 'inv_1' } } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_2');
  });

  it('resolves org via payment_intent for charge.refunded (invoice path)', async () => {
    (prisma.payment.findFirst as any).mockResolvedValue({
      invoice: { organization: { id: 'org_3', stripe_account_id: null } },
    });

    const event = {
      id: 'evt_3',
      type: 'charge.refunded',
      account: undefined,
      data: { object: { payment_intent: 'pi_1' } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_3');
  });

  it('falls back to deposit when payment lookup misses (charge.refunded deposit path)', async () => {
    (prisma.payment.findFirst as any).mockResolvedValue(null);
    (prisma.deposit.findFirst as any).mockResolvedValue({
      estimate: { organization: { id: 'org_4', stripe_account_id: null } },
    });

    const event = {
      id: 'evt_4',
      type: 'charge.refunded',
      account: undefined,
      data: { object: { payment_intent: 'pi_unknown' } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_4');
  });

  it('uses event.account first when present (9C2 Direct charges)', async () => {
    (prisma.organization.findFirst as any).mockResolvedValue({ id: 'org_connect', stripe_account_id: 'acct_x' });

    const event = {
      id: 'evt_5',
      type: 'checkout.session.completed',
      account: 'acct_x',
      data: { object: { metadata: { depositId: 'dep_should_be_ignored' } } },
    } as any;

    const org = await resolveOrgFromEvent(event);
    expect(org?.id).toBe('org_connect');
    expect(prisma.organization.findFirst).toHaveBeenCalledWith({ where: { stripe_account_id: 'acct_x' } });
    expect(prisma.deposit.findUnique).not.toHaveBeenCalled();
  });

  it('returns null when no resolution path matches', async () => {
    const event = {
      id: 'evt_6',
      type: 'unknown.event',
      account: undefined,
      data: { object: {} },
    } as any;

    expect(await resolveOrgFromEvent(event)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run src/__tests__/stripe-lib.test.ts
```

Expected: FAIL — `resolveOrgFromEvent` not exported.

- [ ] **Step 3: Implement `resolveOrgFromEvent` in `webhook.controller.ts`**

Add at the top of the file (above `handleStripeWebhook`):

```typescript
export async function resolveOrgFromEvent(event: any): Promise<{ id: string; stripe_account_id: string | null } | null> {
  // 9C2 path — Connect Direct charges populate event.account
  const accountId = event.account;
  if (accountId) {
    const found = await prisma.organization.findFirst({ where: { stripe_account_id: accountId } });
    if (found) return found;
    logger.warn(`Webhook for unknown connected account ${accountId}`);
    return null;
  }

  const obj = event.data?.object as any;
  const depositId = obj?.metadata?.depositId;
  const invoiceId = obj?.metadata?.invoiceId;
  const paymentIntentId = obj?.payment_intent;

  if (depositId) {
    const dep = await prisma.deposit.findUnique({
      where: { id: depositId },
      select: { estimate: { select: { organization: true } } },
    });
    return dep?.estimate?.organization ?? null;
  }
  if (invoiceId) {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { organization: true },
    });
    return inv?.organization ?? null;
  }
  if (paymentIntentId) {
    const payment = await prisma.payment.findFirst({
      where: { stripe_payment_intent_id: paymentIntentId },
      select: { invoice: { select: { organization: true } } },
    });
    if (payment) return payment.invoice.organization;
    const deposit = await prisma.deposit.findFirst({
      where: { stripe_payment_intent_id: paymentIntentId },
      select: { estimate: { select: { organization: true } } },
    });
    return deposit?.estimate?.organization ?? null;
  }

  return null;
}
```

- [ ] **Step 4: Run test — expect pass**

```bash
npx vitest run src/__tests__/stripe-lib.test.ts
```

Expected: all 6 tests pass.

### Task 2.5: Run full test suite to confirm refactor doesn't break anything

- [ ] **Step 1: Full test run**

```bash
cd backend && npm test
```

Expected: all 605+ existing tests pass + 9 new tests (3 getStripeForOrg + 6 resolveOrgFromEvent) = 614+.

- [ ] **Step 2: Commit**

```bash
git add backend/src/lib/stripe.ts backend/src/controllers/ backend/src/__tests__/stripe-lib.test.ts
git commit -m "feat(payments): sync getStripeForOrg + resolveOrgFromEvent — Connect-ready seam (9C)"
```

---

## Phase 3 — Idempotency Tightening (P2002 catch + first-statement positioning)

**Acceptance criteria:** Concurrent webhook deliveries return 200 (not 500), `stripeEvent.create` is the FIRST statement in each transaction, all existing tests pass.

### Task 3.1: Write failing test for DuplicateWebhookError → 200

- [ ] **Step 1: Add test to `webhook.test.ts`**

Find the duplicate-event test in `backend/src/__tests__/webhook.test.ts` and add a sibling test:

```typescript
it('returns 200 (not 500) when P2002 fires inside the transaction (concurrent duplicate race)', async () => {
  mockPrisma.deposit.findUnique.mockResolvedValue(DEPOSIT_FIXTURE);

  // Top-of-handler findUnique returns null (looks like a fresh event)
  mockPrisma.stripeEvent.findUnique.mockResolvedValue(null);

  // But inside the transaction, P2002 fires (concurrent insert won the race)
  mockPrisma.$transaction.mockImplementation(async (fn: any) => {
    const tx = {
      deposit: { update: vi.fn() },
      estimate: { update: vi.fn() },
      lead: { updateMany: vi.fn() },
      timelineEvent: { create: vi.fn() },
      stripeEvent: {
        create: vi.fn().mockRejectedValue(
          Object.assign(new Error('Unique constraint failed'), {
            code: 'P2002',
            // Match Prisma.PrismaClientKnownRequestError shape
            constructor: { name: 'PrismaClientKnownRequestError' },
          }),
        ),
      },
    };
    await fn(tx);
    return tx;
  });

  const res = await postWebhook(makeEvent('checkout.session.completed', VALID_SESSION));

  expect(res.status).toBe(200);
  expect(res.body).toEqual({ received: true, duplicate: true });
});
```

- [ ] **Step 2: Run test — expect failure**

```bash
npx vitest run src/__tests__/webhook.test.ts -t "P2002"
```

Expected: FAIL — currently the generic catch returns 500.

### Task 3.2: Refactor `webhook.controller.ts` for idempotency

- [ ] **Step 1: Add `DuplicateWebhookError` class at top of file**

```typescript
import { Prisma } from '@prisma/client';

class DuplicateWebhookError extends Error {
  constructor() {
    super('Webhook event already processed (concurrent duplicate)');
    this.name = 'DuplicateWebhookError';
  }
}
```

- [ ] **Step 2: Move `tx.stripeEvent.create` to FIRST in each transaction body**

In `handleStripeWebhook`, find each `prisma.$transaction(async (tx) => {...})` block. At the top of each (currently the create is at the end), reorder so `stripeEvent.create` is FIRST and is wrapped in try/catch:

```typescript
await prisma.$transaction(async (tx) => {
  // FIRST — atomic idempotency claim (R8)
  try {
    await tx.stripeEvent.create({
      data: { stripe_event_id: event.id, event_type: event.type },
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new DuplicateWebhookError();
    }
    throw err;
  }

  // THEN — actual state changes (deposit/invoice update, timeline event, etc.)
  await tx.deposit.update({ /* ... */ });
  // ...
});
```

Apply this to BOTH the deposit path AND the invoice path inside `case 'checkout.session.completed'`.

- [ ] **Step 3: Add explicit DuplicateWebhookError catch in the outer handler**

Wrap the existing logic so it catches `DuplicateWebhookError` BEFORE the generic 500 fallback:

```typescript
try {
  // ... existing event processing ...
  res.json({ received: true });
} catch (err) {
  if (err instanceof DuplicateWebhookError) {
    res.json({ received: true, duplicate: true });  // 200, not 500
    return;
  }
  logger.error('Webhook processing error:', err);
  res.status(500).json({ error: 'Webhook handler failed' });
}
```

- [ ] **Step 4: Run the new test — expect pass**

```bash
npx vitest run src/__tests__/webhook.test.ts -t "P2002"
```

Expected: PASS.

- [ ] **Step 5: Run full webhook test suite to ensure existing tests still pass after reordering**

```bash
npx vitest run src/__tests__/webhook.test.ts
```

Expected: all tests pass. **If existing duplicate-event tests fail**, they were asserting the OLD ordering (stripeEvent.create at end). Update assertions to match the new ordering — `expect(capturedTx.stripeEvent.create).toHaveBeenCalledBefore(capturedTx.deposit.update)`.

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/webhook.controller.ts backend/src/__tests__/webhook.test.ts
git commit -m "fix(payments): tighten webhook idempotency — P2002 catch + first-statement claim (9C R8)"
```

---

## Phase 4 — Invoice Refund Endpoint (TDD)

**Acceptance criteria:** New `POST /api/invoices/:id/refund` endpoint exists, ADMIN-only, validates multi-payment rejection (R5), calls Stripe with `metadata.source='in_app'`, updates Invoice + Payment + Timeline. New unit tests pass.

### Task 4.1: Write Zod schema + first failing test (happy path)

- [ ] **Step 1: Add tests to `backend/src/__tests__/invoices.test.ts`**

Add a `describe('refundInvoice', () => {...})` block with the first happy-path test. (Skeleton — full assertions per spec §2 Flow D):

```typescript
describe('POST /api/invoices/:id/refund', () => {
  const INVOICE_PAID = {
    id: 'inv_1',
    invoice_number: 'I00001',
    status: 'PAID',
    amount_due: 0,
    total_amount: 1000,
    organization: { id: 'org_1', stripe_account_id: null },
    payments: [{
      id: 'pay_1',
      method: 'CARD',
      amount: 1000,
      stripe_payment_intent_id: 'pi_test_invoice_1',
      refunded_at: null,
    }],
    job: { customer: { email: 'c@x.com', first_name: 'C', last_name: 'X' } },
  };

  it('refunds a PAID invoice with one CARD payment (happy path)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(INVOICE_PAID);
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        payment: { update: vi.fn().mockResolvedValue({}) },
        invoice: { update: vi.fn().mockResolvedValue({}) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      };
      capturedTx = tx;
      await fn(tx);
      return tx;
    });

    // Mock Stripe createRefund
    const { createRefund } = await import('../lib/stripe');
    (createRefund as any).mockResolvedValue({ id: 're_test_1' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set('Authorization', 'Bearer admin-token')
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'Customer changed mind' });

    expect(res.status).toBe(200);
    expect(createRefund).toHaveBeenCalledWith(
      'pi_test_invoice_1',
      expect.objectContaining({ stripe: expect.anything(), stripeAccount: undefined }),
      undefined,
      { metadata: { source: 'in_app', invoiceId: 'inv_1' } },
    );
    expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'inv_1' },
      data: expect.objectContaining({
        status: 'REFUNDED',
        total_refunded: 1000,
        refund_reason: 'Customer changed mind',
        refund_reason_category: 'CUSTOMER_REQUEST',
      }),
    }));
    expect(capturedTx.payment.update).toHaveBeenCalled();
    expect(capturedTx.timelineEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        event_type: 'INVOICE_REFUNDED',
        metadata: expect.objectContaining({ source: 'in_app' }),
      }),
    }));
  });

  it('rejects multi-payment invoice with R5 message', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({
      ...INVOICE_PAID,
      payments: [
        { ...INVOICE_PAID.payments[0] },
        { id: 'pay_2', method: 'CARD', amount: 500, stripe_payment_intent_id: 'pi_2' },
      ],
    });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set('Authorization', 'Bearer admin-token')
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'multi pay test' });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/multi-?payment|stripe dashboard/i);
  });

  it('rejects non-PAID invoice', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({ ...INVOICE_PAID, status: 'SENT' });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set('Authorization', 'Bearer admin-token')
      .send({ reason_category: 'ERROR', reason: 'not paid' });

    expect(res.status).toBe(400);
  });

  it('rejects invoice with no Stripe payment_intent_id', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue({
      ...INVOICE_PAID,
      payments: [{ ...INVOICE_PAID.payments[0], stripe_payment_intent_id: null, method: 'CHECK' }],
    });

    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set('Authorization', 'Bearer admin-token')
      .send({ reason_category: 'OTHER', reason: 'no stripe' });

    expect(res.status).toBe(400);
  });

  it('returns 403 for non-ADMIN role', async () => {
    const res = await request(app)
      .post('/api/invoices/inv_1/refund')
      .set('Authorization', 'Bearer dispatcher-token')
      .send({ reason_category: 'OTHER', reason: 'forbidden' });

    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run src/__tests__/invoices.test.ts -t "refundInvoice"
```

Expected: 5 tests fail — endpoint doesn't exist yet (404 or route not found).

### Task 4.2: Implement `refundInvoice` in `invoice.controller.ts`

- [ ] **Step 1: Add Zod schema + handler**

In `backend/src/controllers/invoice.controller.ts`:

```typescript
import { getStripeForOrg, createRefund } from '../lib/stripe';

export const refundInvoiceSchema = z.object({
  reason_category: z.enum(['CUSTOMER_REQUEST', 'ERROR', 'CHARGEBACK', 'OTHER']),
  reason: z.string().min(1).max(500),
});

export async function refundInvoice(req: Request, res: Response) {
  const { id } = req.params;
  const { reason_category, reason } = req.body as z.infer<typeof refundInvoiceSchema>;

  const invoice = await prisma.invoice.findUnique({
    where: { id },
    include: {
      organization: true,
      payments: { where: { method: 'CARD' } },
      job: { include: { customer: true } },
    },
  });

  if (!invoice) {
    res.status(404).json({ error: 'Invoice not found' });
    return;
  }
  if (invoice.status !== 'PAID') {
    res.status(400).json({ error: `Invoice must be PAID to refund (current: ${invoice.status})` });
    return;
  }
  if (invoice.payments.length === 0) {
    res.status(400).json({ error: 'No CARD payment to refund' });
    return;
  }
  if (invoice.payments.length > 1) {
    res.status(400).json({
      error: 'Multi-payment invoices cannot be refunded in-app. Refund via Stripe dashboard; the charge.refunded webhook will sync the state automatically.',
    });
    return;
  }
  const payment = invoice.payments[0];
  if (!payment.stripe_payment_intent_id) {
    res.status(400).json({ error: 'Payment has no Stripe payment_intent_id (manual payment? cannot refund automatically)' });
    return;
  }

  const ctx = getStripeForOrg(invoice.organization);

  try {
    await createRefund(
      payment.stripe_payment_intent_id,
      ctx,
      undefined,
      { metadata: { source: 'in_app', invoiceId: invoice.id } },
    );
  } catch (stripeErr: any) {
    logger.error('Stripe refund failed:', stripeErr);
    res.status(500).json({ error: 'Stripe refund failed. Please retry or refund manually in Stripe dashboard.' });
    return;
  }

  const now = new Date();
  // Note: no tx.stripeEvent.create here — this is a non-webhook flow (admin-initiated HTTP request).
  // Idempotency is enforced at the HTTP layer via auth + the status check above (already-REFUNDED rejected).
  // Webhooks are the only path that needs the StripeEvent idempotency claim (see Phase 3).
  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { id: payment.id },
      data: { refunded_at: now, refunded_amount: payment.amount },
    });
    await tx.invoice.update({
      where: { id: invoice.id },
      data: {
        status: 'REFUNDED',
        total_refunded: payment.amount,
        refunded_at: now,
        refunded_by: req.user!.id,
        refund_reason: reason,
        refund_reason_category: reason_category,
      },
    });
    await tx.timelineEvent.create({
      data: {
        entity_type: 'INVOICE',
        entity_id: invoice.id,
        event_type: 'INVOICE_REFUNDED',
        description: `Invoice ${invoice.invoice_number} refunded $${Number(payment.amount).toFixed(2)} (${reason_category})`,
        metadata: { source: 'in_app', refunded_by: req.user!.id, reason_category, reason },
      },
    });
  });

  // Fire-and-forget refund email (R9 — accepted silent failure if Resend is down)
  sendRefundNotification({
    to: invoice.job.customer.email,
    customerName: `${invoice.job.customer.first_name} ${invoice.job.customer.last_name}`,
    invoiceNumber: invoice.invoice_number,
    refundAmount: Number(payment.amount),
  }).catch((err) => logger.error('Refund email failed:', err));

  res.json({ success: true });
}
```

- [ ] **Step 2: Add route in `backend/src/routes/invoice.routes.ts`**

```typescript
router.post(
  '/:id/refund',
  authorize('ADMIN'),
  validate(refundInvoiceSchema),
  invoiceController.refundInvoice,
);
```

- [ ] **Step 3: Add `sendRefundNotification` import (mirror deposit pattern)**

If Resend `sendRefundNotification` exists for deposits, the same function will work for invoices (it accepts `invoiceNumber` instead of `estimateNumber`). If signature differs, add a new email function or extend the existing one — match the pattern in `lib/email.ts`.

- [ ] **Step 4: Run tests — expect pass**

```bash
npx vitest run src/__tests__/invoices.test.ts -t "refundInvoice"
```

Expected: all 5 new tests pass.

- [ ] **Step 5: Run full backend suite**

```bash
npm test
```

Expected: all tests pass (no regressions).

- [ ] **Step 6: Commit**

```bash
git add backend/src/controllers/invoice.controller.ts backend/src/routes/invoice.routes.ts backend/src/__tests__/invoices.test.ts backend/src/lib/email.ts
git commit -m "feat(payments): invoice refund endpoint (ADMIN, single CARD payment, in_app metadata) (9C R5)"
```

---

## Phase 5 — `charge.refunded` Webhook Handler (TDD)

**Acceptance criteria:** New `case 'charge.refunded':` exists, reads `metadata.source` to skip in_app refunds, processes dashboard refunds for both invoice and deposit paths, idempotent.

### Task 5.1: Write failing tests for charge.refunded

- [ ] **Step 1: Add tests to `webhook.test.ts`**

Add a new `describe('charge.refunded webhook', () => {...})` block. Five core tests (per spec §2 Flow E):

```typescript
describe('charge.refunded webhook', () => {
  const PAYMENT_FIXTURE = {
    id: 'pay_1',
    invoice_id: 'inv_1',
    amount: 1000,
    stripe_payment_intent_id: 'pi_test_refund_1',
    invoice: {
      id: 'inv_1',
      organization: { id: 'org_1', stripe_account_id: null },
    },
  };

  function makeChargeRefundedEvent(
    paymentIntentId: string,
    refundedCents: number,
    refundMetadata?: Record<string, string>,
  ) {
    return {
      id: 'evt_charge_refunded_1',
      type: 'charge.refunded',
      data: {
        object: {
          payment_intent: paymentIntentId,
          amount_refunded: refundedCents,
          refunds: { data: [{ id: 're_1', metadata: refundMetadata ?? {} }] },
        },
      },
    };
  }

  it('skips state changes when refund metadata.source === "in_app" (records event only)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000, { source: 'in_app' }));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();  // no state change
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();  // event recorded
  });

  it('processes dashboard refund for invoice path (no in_app metadata)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(PAYMENT_FIXTURE);
    let capturedTx: any;
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },  // FIRST per §3.7
        payment: { update: vi.fn() },
        invoice: { update: vi.fn() },
        timelineEvent: { create: vi.fn() },
      };
      capturedTx = tx;
      await fn(tx);
      return tx;
    });

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

    expect(res.status).toBe(200);
    expect(capturedTx.invoice.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'REFUNDED',
        total_refunded: 1000,
        refund_reason: 'Refunded via Stripe dashboard',
      }),
    }));
    expect(capturedTx.timelineEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        metadata: expect.objectContaining({ source: 'stripe_dashboard' }),
      }),
    }));
  });

  it('processes dashboard refund for deposit path (no payment match)', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);
    mockPrisma.deposit.findFirst.mockResolvedValue({
      id: 'dep_1',
      amount: 500,
      estimate: { id: 'est_1', organization: { id: 'org_1', stripe_account_id: null } },
    });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => {
      const tx = {
        stripeEvent: { create: vi.fn() },
        deposit: { update: vi.fn() },
        estimate: { update: vi.fn() },
        timelineEvent: { create: vi.fn() },
      };
      await fn(tx);
      return tx;
    });

    const res = await postWebhook(makeChargeRefundedEvent('pi_unknown_invoice', 50000));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).toHaveBeenCalledOnce();
  });

  it('logs warning and records event when neither payment nor deposit matches', async () => {
    mockPrisma.payment.findFirst.mockResolvedValue(null);
    mockPrisma.deposit.findFirst.mockResolvedValue(null);

    const res = await postWebhook(makeChargeRefundedEvent('pi_truly_unknown', 100000));

    expect(res.status).toBe(200);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(mockPrisma.stripeEvent.create).toHaveBeenCalledOnce();
  });

  it('is idempotent (replay returns duplicate:true)', async () => {
    mockPrisma.stripeEvent.findUnique.mockResolvedValue({ id: 'evt_charge_refunded_1' });

    const res = await postWebhook(makeChargeRefundedEvent('pi_test_refund_1', 100000));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true, duplicate: true });
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests — expect failure**

```bash
npx vitest run src/__tests__/webhook.test.ts -t "charge.refunded webhook"
```

Expected: 5 tests fail (handler doesn't exist).

### Task 5.2: Implement `charge.refunded` case in `webhook.controller.ts`

> **Note re: spec §3.4:** Spec says "every event handler calls `resolveOrgFromEvent` at the top." For `charge.refunded` specifically, the handler resolves entity (Payment / Deposit) directly via `stripe_payment_intent_id` lookup — the org is implicit in those entities and we don't need to call Stripe back during processing. So `resolveOrgFromEvent` is **not invoked** in this branch. The `event.account` check is preserved within the entity lookups (a connected-account event would surface a Payment/Deposit owned by that org). This is intentional and correct.

- [ ] **Step 0: Verify `eventRecorded` flag exists in scope**

Open `backend/src/controllers/webhook.controller.ts` and confirm `let eventRecorded = false;` is declared near the top of the `try` block (it should be — see line 54 of the existing controller). The new `case 'charge.refunded':` reuses this flag.

- [ ] **Step 1: Add the case branch**

Inside `handleStripeWebhook`'s `switch (event.type)`, after the existing `'checkout.session.completed':` case, add:

```typescript
case 'charge.refunded': {
  const charge = event.data.object as any;
  const paymentIntentId = charge.payment_intent as string;
  const refundedCents = charge.amount_refunded;
  const latestRefund = charge.refunds?.data?.[0];
  const isInAppRefund = latestRefund?.metadata?.source === 'in_app';

  if (isInAppRefund) {
    logger.info(`charge.refunded for in-app refund ${latestRefund?.id}; recording event only`);
    await prisma.stripeEvent.create({
      data: { stripe_event_id: event.id, event_type: event.type },
    });
    eventRecorded = true;
    break;
  }

  // Dashboard-initiated — try invoice path first
  const payment = await prisma.payment.findFirst({
    where: { stripe_payment_intent_id: paymentIntentId },
    include: { invoice: { include: { organization: true } } },
  });

  if (payment) {
    const refundedAmount = refundedCents / 100;
    await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({
        data: { stripe_event_id: event.id, event_type: event.type },
      });
      await tx.payment.update({
        where: { id: payment.id },
        data: { refunded_at: new Date(), refunded_amount: refundedAmount },
      });
      await tx.invoice.update({
        where: { id: payment.invoice_id },
        data: {
          status: 'REFUNDED',
          total_refunded: refundedAmount,
          refunded_at: new Date(),
          refund_reason: 'Refunded via Stripe dashboard',
        },
      });
      await tx.timelineEvent.create({
        data: {
          entity_type: 'INVOICE',
          entity_id: payment.invoice_id,
          event_type: 'INVOICE_REFUNDED',
          description: `Invoice refunded $${refundedAmount.toFixed(2)} via Stripe dashboard`,
          metadata: { source: 'stripe_dashboard', refund_id: latestRefund?.id },
        },
      });
    });
    eventRecorded = true;
    break;
  }

  // Fall through to deposit path
  const deposit = await prisma.deposit.findFirst({
    where: { stripe_payment_intent_id: paymentIntentId },
    include: { estimate: { include: { organization: true } } },
  });
  if (deposit) {
    const refundedAmount = refundedCents / 100;
    await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({
        data: { stripe_event_id: event.id, event_type: event.type },
      });
      await tx.deposit.update({
        where: { id: deposit.id },
        data: {
          status: 'REFUNDED',
          total_refunded: refundedAmount,
          refunded_at: new Date(),
          refund_reason: 'Refunded via Stripe dashboard',
        },
      });
      await tx.estimate.update({
        where: { id: deposit.estimate.id },
        data: { status: 'CANCELLED', cancelled_reason: 'Deposit refunded via Stripe dashboard' },
      });
      await tx.timelineEvent.create({
        data: {
          entity_type: 'ESTIMATE',
          entity_id: deposit.estimate.id,
          event_type: 'DEPOSIT_REFUNDED',
          description: `Deposit refunded $${refundedAmount.toFixed(2)} via Stripe dashboard`,
          metadata: { source: 'stripe_dashboard', refund_id: latestRefund?.id },
        },
      });
    });
    eventRecorded = true;
    break;
  }

  logger.warn(`charge.refunded for unknown payment_intent ${paymentIntentId}`);
  break;
}
```

- [ ] **Step 2: Run tests — expect pass**

```bash
npx vitest run src/__tests__/webhook.test.ts -t "charge.refunded webhook"
```

Expected: all 5 tests pass.

- [ ] **Step 3: Run full webhook test suite**

```bash
npx vitest run src/__tests__/webhook.test.ts
```

Expected: all webhook tests still pass.

- [ ] **Step 4: Commit**

```bash
git add backend/src/controllers/webhook.controller.ts backend/src/__tests__/webhook.test.ts
git commit -m "feat(payments): charge.refunded webhook handler — invoice + deposit paths, in_app metadata skip (9C R2)"
```

---

## Phase 6 — Frontend `RefundInvoiceDialog`

**Acceptance criteria:** Admin sees a "Refund" button on `InvoiceDetailPage` for PAID invoices with a card payment; clicking it opens a dialog mirroring `RefundDepositDialog`; submitting calls the new endpoint and updates the UI.

### Task 6.1: Clone the deposit dialog

- [ ] **Step 1: Copy file**

```bash
cp frontend/src/components/estimates/RefundDepositDialog.tsx \
   frontend/src/components/invoices/RefundInvoiceDialog.tsx
```

- [ ] **Step 2: Edit `RefundInvoiceDialog.tsx`**

Replace strings:
- `RefundDepositDialog` → `RefundInvoiceDialog`
- `RefundDepositDialogProps` → `RefundInvoiceDialogProps`
- `estimateId: string` → `invoiceId: string`
- `depositAmount: number` → `paymentAmount: number`
- API endpoint: `/api/estimates/${estimateId}/refund-deposit` → `/api/invoices/${invoiceId}/refund`
- Dialog title: `Refund Deposit` → `Refund Invoice`
- Helper text: `Refund amount` referring to deposit → invoice
- Replace `hasStripePayment` prop with always-true (component is only mounted when CARD payment exists)
- TanStack Query invalidation: invalidate the invoice detail query key (mirror existing pattern in `InvoiceDetailPage`)

### Task 6.2: Mount in `InvoiceDetailPage`

- [ ] **Step 1: Edit `frontend/src/pages/InvoiceDetailPage.tsx`**

Add import:

```typescript
import { RefundInvoiceDialog } from '@/components/invoices/RefundInvoiceDialog';
```

Add state:

```typescript
const [refundOpen, setRefundOpen] = useState(false);
```

In the action area (mirror the deposit Refund button pattern from `EstimateDetailPage.tsx:901-906`), add:

```tsx
{user.role === 'ADMIN' && invoice.status === 'PAID' && hasCardPayment(invoice) && (
  <Button size="sm" variant="destructive" onClick={() => setRefundOpen(true)}>
    <CreditCard className="mr-2 h-4 w-4" /> Refund
  </Button>
)}
```

Where `hasCardPayment(invoice)` checks `invoice.payments?.some(p => p.method === 'CARD' && p.stripe_payment_intent_id)`.

Mount the dialog at the bottom of the page:

```tsx
<RefundInvoiceDialog
  open={refundOpen}
  onOpenChange={setRefundOpen}
  invoiceId={invoice.id}
  paymentAmount={paidPayment.amount}
/>
```

- [ ] **Step 2: Type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 3: Manual smoke test**

Start backend + frontend, log in as ADMIN, navigate to a PAID invoice with a card payment. Click Refund, fill the form, submit. Verify the invoice status flips to REFUNDED in the UI.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/invoices/RefundInvoiceDialog.tsx frontend/src/pages/InvoiceDetailPage.tsx
git commit -m "feat(payments): RefundInvoiceDialog UI mounted on InvoiceDetailPage (9C)"
```

---

## Phase 7 — Verification Harness

**Acceptance criteria:** `npm run verify:stripe` runs against local backend, executes ~10 flow tests including signed webhook delivery, real Stripe sandbox refund calls, idempotency under parallel fire, and exits 0.

### Task 7.1: Add npm script + harness skeleton

- [ ] **Step 1: Add to `backend/package.json` scripts**

```json
"verify:stripe": "tsx scripts/verify-stripe.ts"
```

- [ ] **Step 2: Create `backend/scripts/verify-stripe.ts`**

```typescript
#!/usr/bin/env tsx
import { preflight } from './verify-stripe/preflight';
import { setupFixtures, teardownFixtures } from './verify-stripe/fixtures';

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const preflightOnly = args.includes('--preflight');
const live = args.includes('--live');

async function main() {
  console.log('Stripe Verification Harness — sandbox mode');

  if (live && !args.includes('--confirm-i-mean-it')) {
    console.error('Refusing to run in live mode without --confirm-i-mean-it');
    process.exit(2);
  }

  const pf = await preflight();
  if (!pf.ok) {
    console.error('Preflight failed:', pf.errors);
    process.exit(1);
  }
  if (preflightOnly) {
    console.log('✓ Preflight passed (--preflight, exiting)');
    return;
  }

  let fixtures;
  let assertions = 0;
  let failures: string[] = [];
  try {
    fixtures = await setupFixtures();
    // Each test module exports { name, run(fixtures) → assertion count }
    const tests = [
      'flow-A-deposit-checkout',
      'flow-B-invoice-checkout',
      'flow-C-deposit-refund-realapi',
      'flow-D-invoice-refund-realapi',
      'flow-E-charge-refunded-sync',
      'idempotency-double-fire',
      'signature-mismatch',
      'amount-mismatch',
      'missing-metadata',
      'connect-infra',
    ];
    for (const t of tests) {
      const mod = await import(`./verify-stripe/tests/${t}`);
      try {
        const n = await mod.run(fixtures, { verbose });
        assertions += n;
        console.log(`✓ ${t} (${n} assertions)`);
      } catch (err: any) {
        failures.push(`${t}: ${err.message}`);
        console.log(`✗ ${t}: ${err.message}`);
      }
    }
  } finally {
    if (fixtures) await teardownFixtures(fixtures);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} failure(s):`);
    failures.forEach((f) => console.error('  -', f));
    process.exit(1);
  }
  console.log(`\n${assertions} assertions passed`);
}

main().catch((err) => {
  console.error('Harness crashed:', err);
  process.exit(2);
});
```

### Task 7.2: Implement preflight

- [ ] **Step 1: Create `backend/scripts/verify-stripe/preflight.ts`**

```typescript
import { env } from '../../src/config/env';
import Stripe from 'stripe';

export async function preflight(): Promise<{ ok: boolean; errors: string[] }> {
  const errors: string[] = [];

  // Env vars present
  if (!env.STRIPE_SECRET_KEY) errors.push('STRIPE_SECRET_KEY is not set');
  if (!env.STRIPE_WEBHOOK_SECRET) errors.push('STRIPE_WEBHOOK_SECRET is not set');

  // Format checks (R3)
  if (env.STRIPE_SECRET_KEY && !env.STRIPE_SECRET_KEY.startsWith('sk_test_')) {
    errors.push('STRIPE_SECRET_KEY must start with sk_test_ in non-live mode');
  }
  if (env.STRIPE_WEBHOOK_SECRET && !env.STRIPE_WEBHOOK_SECRET.startsWith('whsec_')) {
    errors.push('STRIPE_WEBHOOK_SECRET must start with whsec_');
  }

  // Backend reachable
  try {
    const res = await fetch('http://localhost:3000/api/health');
    if (!res.ok) errors.push(`backend health check failed: ${res.status}`);
  } catch {
    errors.push('backend not reachable at http://localhost:3000');
  }

  // Stripe API version drift (R6)
  const codeVersion = '2025-02-24.acacia';
  const sdkVersion = (Stripe as any).LatestApiVersion ?? codeVersion;
  if (codeVersion !== sdkVersion) {
    errors.push(`Stripe API version drift: code=${codeVersion}, SDK=${sdkVersion}`);
  }

  return { ok: errors.length === 0, errors };
}
```

### Task 7.3: Implement fixture setup/teardown

- [ ] **Step 1: Create `backend/scripts/verify-stripe/fixtures.ts`**

```typescript
import { prisma } from '../../src/lib/prisma';

export interface Fixtures {
  orgId: string;
  customerId: string;
  leadId: string;
  estimateId: string;
  invoiceId: string;
  prefix: string;
}

export async function setupFixtures(): Promise<Fixtures> {
  const prefix = `9C-VERIFY-${Date.now()}`;
  const org = await prisma.organization.create({
    data: { name: `${prefix}-Org`, /* ... required fields ... */ },
  });
  const customer = await prisma.customer.create({
    data: { organization_id: org.id, first_name: 'Verify', last_name: 'Test', email: `${prefix}@test.invalid` },
  });
  // ... lead, estimate, deposit, invoice fixtures ...
  return { orgId: org.id, customerId: customer.id, /* ... */ prefix };
}

export async function teardownFixtures(f: Fixtures): Promise<void> {
  // Cascade delete via org (in order: payments, invoices, deposits, estimates, leads, customers, org)
  await prisma.payment.deleteMany({ where: { invoice: { organization_id: f.orgId } } });
  await prisma.invoice.deleteMany({ where: { organization_id: f.orgId } });
  await prisma.deposit.deleteMany({ where: { estimate: { organization_id: f.orgId } } });
  await prisma.estimate.deleteMany({ where: { organization_id: f.orgId } });
  await prisma.lead.deleteMany({ where: { organization_id: f.orgId } });
  await prisma.customer.deleteMany({ where: { organization_id: f.orgId } });
  await prisma.organization.delete({ where: { id: f.orgId } });
}
```

### Task 7.4: Implement webhook signing helper

- [ ] **Step 1: Create `backend/scripts/verify-stripe/sign.ts`**

```typescript
import Stripe from 'stripe';
import { env } from '../../src/config/env';

const stripe = new Stripe(env.STRIPE_SECRET_KEY!, { apiVersion: '2025-02-24.acacia' });

export function signEvent(event: object): { payload: string; signature: string } {
  const payload = JSON.stringify(event);
  const signature = stripe.webhooks.generateTestHeaderString({
    payload,
    secret: env.STRIPE_WEBHOOK_SECRET!,
    timestamp: Math.floor(Date.now() / 1000),
  });
  return { payload, signature };
}

export async function postWebhook(event: object): Promise<{ status: number; body: any }> {
  const { payload, signature } = signEvent(event);
  const res = await fetch('http://localhost:3000/api/webhooks/stripe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': signature },
    body: payload,
  });
  return { status: res.status, body: await res.json() };
}
```

### Task 7.5: Implement individual flow tests

- [ ] **Step 1: Implement each test module**

Create one file per test under `backend/scripts/verify-stripe/tests/`. Each exports `async function run(fixtures, opts): Promise<number>` returning the count of assertions made.

Per spec §4.4, test modules to create:
- `flow-A-deposit-checkout.ts` — synthesize `checkout.session.completed` for deposit, assert deposit/estimate/lead state, timeline, idempotency on replay
- `flow-B-invoice-checkout.ts` — same for invoice; PARTIAL variant; non-payable status variant
- `flow-C-deposit-refund-realapi.ts` — call our refund endpoint, then verify the refund actually exists in Stripe sandbox
- `flow-D-invoice-refund-realapi.ts` — same for invoice; multi-payment rejection; no-Stripe rejection
- `flow-E-charge-refunded-sync.ts` — fire `charge.refunded` for invoice and deposit paths; in_app metadata skip variant
- `idempotency-double-fire.ts` — fire same event 5x in parallel
- `signature-mismatch.ts` — POST with bad signature → expect 400
- `amount-mismatch.ts` — tamper amount_total → expect no state change
- `missing-metadata.ts` — no depositId/invoiceId → expect no state change
- `connect-infra.ts` — grep + invariants on indirection seam

Pattern (example for `flow-A`):

```typescript
import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

export async function run(f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const event = {
    id: `evt_verify_${Date.now()}`,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_verify_1',
        payment_intent: 'pi_verify_1',
        amount_total: 51750,  // (deposit + surcharge) * 100
        metadata: { depositId: f.depositId },
      },
    },
  };

  const res = await postWebhook(event);
  assert(res.status === 200, 'webhook responds 200');
  count++;

  const deposit = await prisma.deposit.findUnique({ where: { id: f.depositId } });
  assert(deposit?.status === 'PAID', 'deposit status PAID');
  count++;
  assert(deposit?.payment_method === 'CARD', 'deposit payment_method CARD');
  count++;
  // ... 11 more assertions per spec §2 Flow A ...

  // Replay → idempotent
  const replay = await postWebhook(event);
  assert(replay.body.duplicate === true, 'replay returns duplicate:true');
  count++;

  return count;
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
```

**Special case — `idempotency-double-fire.ts` (R8 mitigation, spec §6.6):**

```typescript
import { Fixtures } from '../fixtures';
import { postWebhook } from '../sign';
import { prisma } from '../../../src/lib/prisma';

export async function run(f: Fixtures): Promise<number> {
  let count = 0;
  const eventId = `evt_idempotent_${Date.now()}`;
  const event = {
    id: eventId,
    type: 'checkout.session.completed',
    data: {
      object: {
        id: 'cs_idempotent_1',
        payment_intent: 'pi_idempotent_1',
        amount_total: 51750,
        metadata: { depositId: f.depositId },
      },
    },
  };

  // Fire 5 simultaneous deliveries of the SAME event ID
  const results = await Promise.all([
    postWebhook(event),
    postWebhook(event),
    postWebhook(event),
    postWebhook(event),
    postWebhook(event),
  ]);

  const fresh = results.filter((r) => r.body.duplicate !== true);
  const duplicates = results.filter((r) => r.body.duplicate === true);

  assert(fresh.length === 1, `exactly one delivery processed as fresh (got ${fresh.length})`);
  count++;
  assert(duplicates.length === 4, `four deliveries returned duplicate:true (got ${duplicates.length})`);
  count++;
  assert(results.every((r) => r.status === 200), 'all 5 deliveries returned HTTP 200 (no 500s)');
  count++;

  // Exactly one StripeEvent row
  const evRows = await prisma.stripeEvent.findMany({ where: { stripe_event_id: eventId } });
  assert(evRows.length === 1, `exactly one StripeEvent row exists for the event ID (got ${evRows.length})`);
  count++;

  return count;
}

function assert(cond: any, msg: string) {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}
```

### Task 7.6: Run the harness end-to-end

- [ ] **Step 1: Make sure backend is running with `stripe listen` forwarding**

```bash
# Terminal 1
cd backend && npm run dev

# Terminal 2
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

**⚠️ Webhook secret rotates per `stripe listen` session.** Each time you restart `stripe listen` (terminal 2), it prints a NEW `whsec_*` value. The harness signs events using the value from `backend/.env`, so:

1. Note the `whsec_*` from the `stripe listen` startup message
2. If different from `STRIPE_WEBHOOK_SECRET` in `backend/.env`: update `.env` to match
3. Restart the backend (terminal 1) so the new `.env` value is picked up

Otherwise the harness will sign events with the stale secret and the backend's signature verification will fail with confusing 400s.

- [ ] **Step 2: Run preflight**

```bash
cd backend && npm run verify:stripe -- --preflight
```

Expected: `✓ Preflight passed`.

- [ ] **Step 3: Run full harness**

```bash
npm run verify:stripe
```

Expected: all flow tests green, total assertion count ~50+, exit code 0. **Iterate here**: failures from this run inform fixes in Phases 1–6 (or in the harness itself).

- [ ] **Step 4: Commit harness**

```bash
git add backend/scripts/verify-stripe* backend/package.json
git commit -m "feat(payments): verification harness — 10 flow tests + preflight + sandboxed fixtures (9C)"
```

---

## Phase 8 — Browser Runbook Execution

**Acceptance criteria:** Live verification checklist filled out, all 5 flows in §2 walked manually with screenshots/notes attached.

### Task 8.1: Create the live checklist

- [ ] **Step 1: Create `md_files/plans/payments/2026-04-29-stripe-test-mode-verification.md`**

Copy the verification matrix from spec §2 verbatim, formatted as a checklist. Add a "Browser Runbook" header with date + tester name + environment (local sandbox).

### Task 8.2: Walk Flow A — deposit checkout

- [ ] **Step 1: Create a test estimate via the app**

Log in as ADMIN, create a customer + lead, generate an estimate with a deposit, send to a test email you control.

- [ ] **Step 2: Approve as customer**

Open the public estimate link, click Pay, use card `4242 4242 4242 4242`, exp any future date, CVC any 3 digits.

- [ ] **Step 3: Tick assertions in the checklist**

Verify each item per §2 Flow A:
- Deposit → PAID
- Estimate → APPROVED
- Lead → WON
- Timeline event present
- Customer received deposit confirmation email
- Creator received deposit paid email
- Customer received estimate approved email with PDF

Note any failures in the checklist with details.

### Task 8.3: Walk Flow B — invoice checkout

- [ ] **Step 1: Generate invoice from a job**

Same flow but for an invoice. Send to test email, click Pay with Card on the public link, complete checkout.

- [ ] **Step 2: Tick Flow B assertions**

### Task 8.4: Walk Flow C — deposit refund (in-app)

- [ ] **Step 1: As ADMIN, click Refund on a PAID deposit**

Fill reason category + reason, submit. Verify status flip to REFUNDED.

### Task 8.5: Walk Flow D — invoice refund (in-app, NEW)

- [ ] **Step 1: As ADMIN, click Refund on a PAID invoice**

New `RefundInvoiceDialog`. Same dialog UX as deposit. Verify invoice → REFUNDED.

### Task 8.6: Walk Flow E — dashboard refund sync

- [ ] **Step 1: In Stripe dashboard (test mode), find a recent charge → click Refund**

This fires `charge.refunded` to the local backend (via `stripe listen`).

- [ ] **Step 2: Verify CRM reflects the refund**

Open the relevant invoice/estimate in the CRM. Verify status → REFUNDED, timeline entry says "via Stripe dashboard".

### Task 8.7: Commit the completed checklist

- [ ] **Step 1: Commit**

```bash
git add md_files/plans/payments/2026-04-29-stripe-test-mode-verification.md
git commit -m "docs(payments): browser runbook complete — all 5 flows verified (9C)"
```

---

## Phase 9 — Documentation (env config runbook + vault notes + PRE-LAUNCH-CHECKLIST)

**Acceptance criteria:** `stripe-environment-config.md` exists with all 10 sections per spec §5; `Stripe-Integration.md` vault note rewritten; `PRE-LAUNCH-CHECKLIST.md` Stripe section updated.

### Task 9.1: Write the Stripe environment configuration runbook

- [ ] **Step 1: Create `md_files/plans/payments/stripe-environment-config.md`**

Use the structure from spec §5.2 (10 sections). Each section needs:
- Section 1: Stripe account setup (one-time)
- Section 2: Local dev (stripe-cli + .env)
- Section 3: Staging environment setup
- Section 4: Production environment setup
- Section 5: $1 production smoke transaction (CRITICAL — risk callouts for R3)
- Section 6: Rollback procedure
- Section 7: Where to watch (observability)
- Section 8: Key rotation procedure
- Section 9: Connect mode (Phase 1 — extended in 9C2)
- Section 10: Common failure modes (FAQ)

Include the Quick Reference table from spec §5.1 at the top.

### Task 9.2: Update PRE-LAUNCH-CHECKLIST.md

- [ ] **Step 1: Replace Stripe section**

Find the `## Payments (Stripe)` section. Replace the stale TODO list with:

```markdown
## Payments (Stripe)

- [x] Stripe integration production-ready in single-tenant mode (9C complete YYYY-MM-DD)
- [ ] Production environment configured per [stripe-environment-config.md](md_files/plans/payments/stripe-environment-config.md)
- [ ] $1 production smoke transaction passes (see runbook §5)
- [ ] Connect Standard onboarding (9C2) — separate step
```

### Task 9.3: Rewrite vault `Architecture/Stripe-Integration.md`

- [ ] **Step 1: Update to reflect production-ready + Connect-ready architecture**

Replace the existing content (mainly the Lib Functions table) with the post-9C state:
- 7 lib functions now: `_platformStripe` (private), `getStripeForOrg`, `isStripeConfigured`, `getSurchargeRate`, `createCheckoutSession`, `createRefund`, `constructWebhookEvent`
- Webhook events handled: `checkout.session.completed`, `charge.refunded`
- Idempotency: P2002 catch with first-statement claim
- Org resolution: metadata-based via `resolveOrgFromEvent`
- Connect-readiness: `Organization.stripe_account_id` + sync indirection
- Out of scope items: `payment_intent.succeeded` (with the card-only constraint), disputes, partial refunds
- Cross-link to `[[Stripe-Environment-Configuration]]` runbook (link to the markdown file)

### Task 9.4: Update vault status + memory

- [ ] **Step 1: Update `Status/Build-Progress.md`**

Find the 9C row in the timeline table. Change `⬜ Not started` → `✅ Complete` and fill in the date.

- [ ] **Step 2: Update `Status/Current-Focus.md`**

Replace "Next step: Step 9B" → "Next step: Step 9D Notifications (per priority order)" and update the Completed section with 9C.

- [ ] **Step 3: Update `MEMORY.md`**

Update `Build Progress` section: change `[ ] Step 9C: Stripe Test-Mode Verification` → `[x] Step 9C: Stripe production-ready` (with date). Update `Current Focus` accordingly.

- [ ] **Step 4: Append to vault `log.md`**

Add a session entry summarizing 9C completion: schema migration, invoice refund flow, charge.refunded handler, idempotency tightening, Connect infrastructure, harness, runbook.

### Task 9.5: Commit docs

- [ ] **Step 1: Commit**

```bash
git add md_files/plans/payments/stripe-environment-config.md PRE-LAUNCH-CHECKLIST.md
# Vault files are outside the repo; commit those separately if vault is its own git repo
git commit -m "docs(payments): Stripe environment config runbook + PRE-LAUNCH-CHECKLIST update (9C)"
```

---

## Phase 10 — Final Review + Merge

**Acceptance criteria:** Code-review pass, exit gates ticked, branch merged to main.

### Task 10.1: Run full test suite once more

- [ ] **Step 1: Backend**

```bash
cd backend && npm test
```

Expected: all 605 + new tests pass (614+).

- [ ] **Step 2: Frontend type-check**

```bash
cd frontend && npx tsc --noEmit
```

Expected: 0 errors.

- [ ] **Step 3: Run harness once more**

```bash
cd backend && npm run verify:stripe
```

Expected: green.

### Task 10.2: Code review (self-dispatched)

- [ ] **Step 1: Invoke `superpowers:requesting-code-review`**

Use the skill to dispatch a code-reviewer agent. Provide:
- Branch: `feat/stripe-9c-production-ready`
- Spec: `md_files/plans/payments/2026-04-29-stripe-test-mode-verification-design.md`
- Plan: `md_files/plans/payments/2026-04-29-stripe-test-mode-verification-plan.md`
- Ask: review against spec, identify any deviations, check test coverage of the 9 risks

- [ ] **Step 2: Address review findings**

Apply fixes per reviewer feedback. Re-dispatch if needed (max 3 iterations per skill rules).

### Task 10.3: Tick exit gates from spec §6.3

- [ ] **Step 1: Walk through each hard gate**

In the live checklist, tick each item per spec §6.3:
- Every row in §2 verification matrix V1 ticked
- All 605+ existing backend tests pass
- New unit tests added (invoice refund, charge.refunded, getStripeForOrg, P2002, resolveOrgFromEvent)
- Browser runbook completed
- Stripe environment config runbook reviewed
- `Architecture/Stripe-Integration.md` rewritten
- `PRE-LAUNCH-CHECKLIST.md` updated
- `Build-Progress.md` flipped 9C to ✅
- `Current-Focus.md` shifted to 9D
- Spec passed code review

### Task 10.4: Merge to main

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/stripe-9c-production-ready
```

- [ ] **Step 2: Create PR**

```bash
gh pr create --title "feat: Stripe 9C — production-ready single-tenant + Connect infrastructure" --body "$(cat <<'EOF'
## Summary
- Schema migration: Invoice/Payment refund fields, REFUNDED enum, Organization.stripe_account_id
- Invoice refund flow (endpoint + admin UI dialog) — mirrors deposit refund pattern
- charge.refunded webhook handler with metadata.source race resolution (R2)
- Idempotency tightening: P2002 catch + first-statement positioning + DuplicateWebhookError → 200 (R8)
- Connect infrastructure seam: sync getStripeForOrg(org), resolveOrgFromEvent metadata-based routing
- Verification harness: 10 flow tests + preflight + sandboxed fixtures
- Stripe environment configuration runbook (staging + production, no key swapping)
- Vault notes + PRE-LAUNCH-CHECKLIST updated

## Test plan
- [x] Full backend suite (605 + new tests) green
- [x] Frontend type-check clean
- [x] Harness `npm run verify:stripe` green
- [x] Browser runbook all 5 flows ticked
- [x] Code review passed
EOF
)"
```

- [ ] **Step 3: Merge after CI green**

(Squash or merge per repo convention.)

- [ ] **Step 4: Clean up worktree (per CLAUDE.md, do NOT delete the branch)**

```bash
cd C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm
git worktree remove C:/Users/ranro/Documents/ALPHA_CRM/alpha_crm-worktrees/stripe-9c
```

(Branch stays — see `feedback_branch_deletion.md` in memory.)

---

## Risk Coverage Recap

Every load-bearing risk from spec §6.1 is covered:

| Risk | Phase(s) covering it |
|---|---|
| R1 (refactor breakage) | Phase 0.5 baseline, Phase 2.5 full suite re-run, Phase 10.1 final |
| R2 (charge.refunded race) | Phase 4 metadata flag, Phase 5 handler reads metadata, harness tests |
| R3 (signing secret copy-paste) | Phase 7 preflight format check, Phase 9 runbook §5.5 production smoke |
| R4 (perf regression) | Closed by design — sync helper |
| R5 (multi-payment invoice refund) | Phase 4 endpoint validation + test |
| R6 (deprecated API version) | Phase 7 preflight static check |
| R7 (fixture leakage) | Phase 7 namespace prefix + try/finally teardown |
| R8 (concurrent idempotency race) | Phase 3 P2002 catch, Phase 5 in handler, harness double-fire test |
| R9 (Resend silent failure) | Phase 4 documented as accepted MVP limitation |

---

## Appendix — Commands Reference (quick lookup during execution)

```bash
# Worktree
git worktree add ../alpha_crm-worktrees/stripe-9c -b feat/stripe-9c-production-ready

# Stripe CLI (Windows)
scoop install stripe
stripe login
stripe listen --forward-to localhost:3000/api/webhooks/stripe

# Prisma (from backend/)
npx prisma validate
npx prisma migrate dev --name stripe_9c
npx prisma generate
npx prisma studio

# Tests
npm test                                              # full suite
npx vitest run src/__tests__/<file>.test.ts          # single file
npx vitest run -t "<test name pattern>"               # by name

# Type-check
npx tsc --noEmit                                      # frontend or backend

# Harness
npm run verify:stripe -- --preflight                  # quick check
npm run verify:stripe                                 # full
npm run verify:stripe -- --verbose                    # debug

# Frontend
npm run dev:frontend                                  # vite

# Backend
npm run dev:backend                                   # express
```
