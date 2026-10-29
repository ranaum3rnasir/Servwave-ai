# Step 9C — Stripe Test-Mode Verification & Production-Readiness (Design)

> **Stale hostname, 2026-08-25:** the webhook URL below names `staging.alphacrm.com`, which never
> carried the app — `alphacrm.com` is a parked domain. Staging's API is
> `alpha-crm-test-env.onrender.com`. `stripe-environment-config.md` is the live source for
> webhook endpoints; this file is a record of the 9C design/plan.

> **Status:** Draft, pending spec review
> **Author:** Brainstorm session 2026-04-29
> **Step:** 9C (split from original — Connect onboarding moved to 9C2)
> **Estimated effort:** ~4.25 days (revised after spec review surfaced Invoice/Payment schema gap)
> **Source notes:**
> - `Vault/Ideas/MVP-Stripe-Test-Mode-Connection.md` (original MVP requirement)
> - `Vault/Architecture/Stripe-Integration.md` (current state of the integration)
> - This design supersedes the bare verification scope in the source note: 9C now also closes inline gaps and lays Connect infrastructure for 9C2.

---

## Goal

Stripe payments are **production-ready in single-tenant mode**, with the multi-tenant infrastructure scaffolding in place for a clean 9C2 (Stripe Connect Standard onboarding).

Concretely, by the end of 9C:
- Every existing Stripe flow (deposit checkout, invoice checkout, deposit refund) is verified end-to-end against sandbox Stripe with real API calls and real signed webhook events
- Two new code paths exist and are tested: invoice refund (in-app) and `charge.refunded` webhook handler (dashboard refund sync)
- The codebase has a single seam (`getStripeForOrg(orgId)`) where every Stripe API call passes through, so 9C2 can swap in connected-account routing without touching call sites
- A production-grade runbook documents the staging + production environment configuration (no key swapping, two parallel forever-environments)
- A re-runnable harness script verifies the full integration in ~5 seconds against any environment

---

## Section 1 — Scope & Deliverables

### Deliverables (artifacts produced by 9C)

| # | Artifact | Location | Purpose |
|---|---|---|---|
| 1 | Verification checklist | `md_files/plans/payments/2026-04-29-stripe-test-mode-verification.md` | Living doc, ticked through; final state = signed-off |
| 2 | Stripe verification harness | `backend/scripts/verify-stripe.ts` | Re-runnable smoke test using stripe-cli + Stripe SDK against sandbox |
| 3 | Stripe environment configuration runbook | `md_files/plans/payments/stripe-environment-config.md` | Standalone procedure covering local dev / staging / production simultaneously; registering two webhook endpoints; production smoke transaction; rollback steps |
| 4 | Invoice refund flow (new code + new schema fields) | `backend/src/controllers/invoice.controller.ts` + `frontend/src/components/invoices/RefundInvoiceDialog.tsx` + Prisma migration adding refund fields to Invoice + Payment, plus `REFUNDED` enum value (see §3.1.2) | Mirrors deposit refund pattern; required schema work was missing from original spec |
| 5 | `charge.refunded` webhook handler (new code) | `backend/src/controllers/webhook.controller.ts` | Syncs dashboard-initiated refunds back into CRM (deposit + invoice paths) |
| 6 | Idempotency tightening (small fix) | `backend/src/controllers/webhook.controller.ts` | Add Prisma `P2002` catch around `stripeEvent.create` to close the findUnique→create race |
| 7 | Schema migration: `Organization.stripe_account_id` + Invoice/Payment refund fields + `InvoiceStatus.REFUNDED` (combined into one migration file) | `backend/prisma/schema.prisma` + new migration | Connect-readiness + invoice refund support; see §3.1 for full delta |
| 8 | `getStripeForOrg(orgId)` indirection | `backend/src/lib/stripe.ts` (extended) | Today returns platform Stripe; future returns connected-account Stripe. Single seam for 9C2 swap. |
| 9 | Refactor: every Stripe call site uses the indirection | `estimate.controller.ts`, `invoice.controller.ts`, `webhook.controller.ts` | One-time refactor; 9C2 won't touch these files |
| 10 | Webhook handler reads `event.account` | `webhook.controller.ts` | Identifies which org the event belongs to (today: always platform; future: connected account ID) |
| 11 | Tests for new code | `backend/src/__tests__/invoices.test.ts`, `webhook.test.ts` | Unit coverage; existing 605 tests still pass after refactor |
| 12 | Updated `PRE-LAUNCH-CHECKLIST.md` | repo root | Replaces stale Stripe TODOs with pointers to runbooks |
| 13 | Updated `Stripe-Integration` vault note | `Architecture/Stripe-Integration.md` | Reflects production-ready single-tenant + Connect-ready architecture |

### Out of scope for 9C (each documented in §6.4 with rationale)

- `payment_intent.succeeded` webhook — redundant with `checkout.session.completed` for our Checkout Session flow **while we restrict to `card` payment methods** (verified: `payment_method_types: ['card']` in `stripe.ts`). If we ever enable Link, ACH, SEPA, or Klarna, those complete asynchronously and `checkout.session.completed` may fire with `payment_status: 'unpaid'` before money arrives — at that point we MUST add `payment_intent.succeeded`. A code comment near `payment_method_types` will pin this constraint.
- `charge.dispute.created` and dispute handling — rare, post-MVP
- Apple Pay / Google Pay — Stripe Checkout enables these by default; no extra work needed
- Connect onboarding UI / OAuth flow — explicit 9C2 scope
- Application fees / platform fees — confirmed not part of business model (subscription-only revenue)
- Partial invoice refunds — full only in MVP
- Multi-payment invoice refund — single-CARD-payment refundable in MVP

### Exit criteria

See §6.3 for the complete exit gate checklist.

---

## Section 2 — Verification Matrix

Five flows + cross-cutting concerns. Each line is a row in the checklist file, ticked as verified.

**Notation:** **B** = browser runbook, **H** = harness, **U** = unit test. Risk tags (R1–R9) reference §6.1.

### Flow A — Estimate deposit checkout (customer pays via Stripe Checkout)

| Assertion | Verified by | Risks covered |
|---|---|---|
| `POST /api/estimates/:id/public/approve` returns Checkout URL | H | — |
| Session has correct amount (deposit + surcharge), metadata.depositId, success/cancel URLs | H | — |
| Customer-facing flow: redirects to Stripe, accepts test card `4242 4242 4242 4242`, returns to success page | B | — |
| `checkout.session.completed` webhook delivered + signature verified | H (`stripe trigger` + `stripe listen`) | R3 |
| StripeEvent row created (idempotency), inside the same transaction as state changes | H | R8 |
| Deposit → PAID, paid_at, payment_method=CARD, stripe_payment_intent_id | H | — |
| Estimate → APPROVED, approved_at | H | — |
| Lead → WON (idempotent: only if not in terminal state) | H | — |
| Timeline event `DEPOSIT_PAID` | H | — |
| Customer receives "Deposit confirmation" email | B | — |
| Creator receives "Deposit paid" email | B | — |
| Customer receives "Estimate approved" email (with signed PDF) | B | — |
| Replay same webhook → 200 `{duplicate:true}`, no state changes | H | R8 |
| Amount mismatch (tampered `amount_total`) → no state change, warning logged | H | — |

### Flow B — Invoice card payment

| Assertion | Verified by | Risks covered |
|---|---|---|
| `POST /api/invoices/:id/public/checkout` returns Checkout URL | H | — |
| Session has correct amount (amount_due + surcharge), metadata.invoiceId | H | — |
| Customer-facing flow with test card | B | — |
| Webhook delivered, signature verified | H | R3 |
| Payment row created: amount=amount_due, method=CARD, collected_by=null, stripe_payment_intent_id | H | — |
| Invoice → amount_due=0, status=PAID, paid_at | H | — |
| Timeline events `PAYMENT_RECEIVED` + `INVOICE_PAID` (both) | H | — |
| Customer + admin emails sent | B | — |
| Partial-pay path: invoice status=PARTIAL with amount_due=$X → only $X charged + recorded | H | — |
| Non-payable invoice status (DRAFT, PAID, VOID) → no state change | H | — |
| Surcharge calculation persisted on Payment row at session creation; webhook validates against the snapshot, not against env value at receipt time | U + H | — |
| Replay → idempotent | H | R8 |

### Flow C — Deposit refund (in-app, ADMIN clicks Refund button) — already-built, verify only

| Assertion | Verified by | Risks covered |
|---|---|---|
| ADMIN-only authorization (403 for other roles) | U + H | — |
| Deposit must be PAID (400 otherwise) | U | — |
| Existing job blocks refund (400 with message) | U | — |
| Stripe `refunds.create(payment_intent_id, { metadata: { source: 'in_app', depositId } })` invoked for CARD payment | H | R2 |
| Manual refund (non-Stripe) skips Stripe call | U | — |
| Deposit → REFUNDED, refunded_at, refunded_by, refund_reason, total_refunded | H | — |
| Estimate → CANCELLED, cancelled_reason | H | — |
| Timeline `DEPOSIT_REFUNDED` with `metadata.source='in_app'` | H | R2 |
| Customer receives refund email | B | — |
| Browser flow: dialog opens, reason categorization works, success state appears | B | — |

### Flow D — Invoice refund (in-app) — NEW build, then verify

| Assertion | Verified by | Risks covered |
|---|---|---|
| New endpoint `POST /api/invoices/:id/refund`, ADMIN-only | U + H | — |
| Schema check: invoice has a CARD payment with stripe_payment_intent_id | U | — |
| Multi-payment invoice rejected with clear error pointing to Stripe dashboard refund | U | R5 |
| Reason + reason_category required (mirrors deposit pattern) | U | — |
| Stripe `refunds.create(payment_intent_id, { metadata: { source: 'in_app', invoiceId } })` succeeds | H | R2 |
| Payment row → refunded markers (`refunded_at`, `refunded_amount`) | H | — |
| Invoice → REFUNDED, `total_refunded`, `refunded_at`, `refund_reason` | H | — |
| Timeline `INVOICE_REFUNDED` with `metadata.source='in_app'` | H | R2 |
| Customer receives refund email | B | — |
| New `RefundInvoiceDialog` UI mirrors `RefundDepositDialog` (consistent UX) | B | — |

### Flow E — Dashboard-initiated refund sync (`charge.refunded`) — NEW handler

| Assertion | Verified by | Risks covered |
|---|---|---|
| Bookkeeper clicks Refund in Stripe dashboard, our webhook receives `charge.refunded` | B | — |
| Handler looks up Payment by `stripe_payment_intent_id` (invoice path) → updates if found | H | — |
| Falls back to Deposit lookup by `stripe_payment_intent_id` (deposit path) → updates if found | H | — |
| If neither match: log warning, record StripeEvent (don't loop on Stripe retries) | H | — |
| Updates mirror in-app refund state changes (status, timestamps, total_refunded) | H | — |
| Timeline event reflects "refunded via Stripe dashboard" with `metadata.source='stripe_dashboard'` | H | R2 |
| If `charge.refunds.data[0].metadata.source === 'in_app'`, skip state changes — record event only (handler authoritative state-write happens in §3.6 endpoint) | H + U | R2 |
| No customer-facing email (admin-side action; out-of-band notification optional, default OFF for MVP) | — | — |
| Idempotent under Stripe retries | H | R8 |

### Cross-cutting: Idempotency & Error paths

| Assertion | Verified by | Risks covered |
|---|---|---|
| Duplicate webhook (same `event.id`) → 200 `{duplicate:true}`, no state change | H + U | R8 |
| Tighten findUnique→create race: wrap `stripeEvent.create` in try/catch on Prisma `P2002` (unique violation), treat as duplicate | U | R8 |
| Concurrent fire-twice (5 simultaneous deliveries of same event ID) → exactly one DB write | H | R8 |
| Webhook signature mismatch → 400 (in non-test env) | H (mutate signature) | R3 |
| Missing `stripe-signature` header → 400 (in non-test env) | H | R3 |
| DB transaction error during webhook → 500, Stripe retries automatically | U | — |
| `STRIPE_SECRET_KEY` unset → `getStripe()` throws, surfaces as 500 with clear log | U | R3 |
| Stripe API version pinned in code matches Stripe SDK current default | H (preflight static check) | R6 |

### Cross-cutting: Connect infrastructure (no behavior change)

| Assertion | Verified by | Risks covered |
|---|---|---|
| Migration adds `Organization.stripe_account_id` (nullable text, indexed) + Invoice/Payment refund fields + `InvoiceStatus.REFUNDED` | reading migration | — |
| All Stripe call sites use `getStripeForOrg(org)` (sync; greppable: `getStripe(` becomes private) | H (grep + tests) | R1 |
| `getStripeForOrg(org)` today: returns platform Stripe; `stripeAccount` field forwarded from `org.stripe_account_id` (null in 9C, populated in 9C2) | U | — |
| Webhook handler resolves org from event metadata (`depositId` / `invoiceId` / `payment_intent`); falls back to `event.account` lookup for 9C2 Direct charges | U | — |
| Unknown event (no resolvable org, no `event.account`) → 200 + `unresolved_org` flag, StripeEvent recorded so Stripe stops retrying | U | — |
| All 605 existing backend tests pass unchanged after refactor | running suite | R1 |
| New unit tests for `getStripeForOrg`, `resolveOrgFromEvent`, P2002 idempotency catch path, and DuplicateWebhookError → 200 response | U | — |

**Total: ~83 distinct assertions** across browser runbook (~12), harness (~50), and unit tests (~21). Many overlap — the same assertion is verified by both H and U where it's load-bearing.

---

## Section 3 — Architecture Changes

What code actually moves. Six surgical pieces, no rewrites.

### 3.1 — Schema migrations

**Two migrations** in 9C (combined into a single migration file):

#### 3.1.1 — Connect infrastructure field (1 field)

```prisma
model Organization {
  // ... existing fields ...
  stripe_account_id String?   @db.Text  // null = platform-managed (Phase 0); set after Connect onboarding (9C2)

  @@index([stripe_account_id])
}
```

Nullable, indexed. Defaults to null for existing orgs.

#### 3.1.2 — Invoice refund fields (NEW — corrects original spec assumption)

The original spec incorrectly assumed Invoice already had refund fields. Schema verification shows refund fields exist on `Deposit` only. We need to add them to `Invoice` and `Payment`, and extend the `InvoiceStatus` enum.

```prisma
model Invoice {
  // ... existing fields ...
  total_refunded          Decimal   @default(0) @db.Decimal(12, 2)
  refunded_at             DateTime?
  refund_reason           String?
  refund_reason_category  String?   // values constrained by refundInvoiceSchema (Zod)
  refunded_by             String?   @db.Uuid
  refunded_by_user        User?     @relation("InvoiceRefundedBy", fields: [refunded_by], references: [id])
}

model Payment {
  // ... existing fields ...
  refunded_at      DateTime?
  refunded_amount  Decimal?  @db.Decimal(12, 2)
}

enum InvoiceStatus {
  DRAFT
  SENT
  PARTIAL
  PAID
  VOIDED
  REFUNDED  // NEW
}
```

Migration is additive (all new fields nullable / defaulted). No data backfill needed. The `User` relation name `InvoiceRefundedBy` mirrors the existing `DepositRefundedBy` pattern.

### 3.2 — `getStripeForOrg(org)` indirection

Goal: every Stripe API call goes through a single function that today is a pass-through, tomorrow routes to connected accounts. **Synchronous** — accepts an Organization-shaped object so callers don't pay for a redundant DB lookup. Most call sites already load the org via `include`.

```typescript
// backend/src/lib/stripe.ts

// Internal — NOT exported. Old getStripe() is renamed and made private.
function _platformStripe(): Stripe {
  if (!env.STRIPE_SECRET_KEY) throw new Error('Stripe is not configured.');
  if (!_stripe) _stripe = new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: '...' });
  return _stripe;
}

// Public API — every call site uses this. Accepts a partial Org (just the field we need).
export function getStripeForOrg(org: { stripe_account_id: string | null }): {
  stripe: Stripe;
  stripeAccount?: string;  // undefined today; set in 9C2 when org.stripe_account_id is non-null
} {
  // Today: always platform Stripe. 9C2 will return per-account when stripe_account_id is set.
  return {
    stripe: _platformStripe(),
    stripeAccount: org.stripe_account_id ?? undefined,  // forward-compatible: 9C2 just populates the field
  };
}

// Existing helpers extended to accept the routing context
export async function createCheckoutSession(opts: {...}, ctx: { stripe: Stripe; stripeAccount?: string }): Promise<...>
export async function createRefund(paymentIntentId: string, ctx: {...}, amountInCents?: number): Promise<...>
```

The `stripeAccount` field is the seam. **Today it's already populated when `org.stripe_account_id` is non-null** — but 9C ships with all orgs having null. When 9C2 onboarding flips the field on, every existing call site routes correctly with zero refactor.

**Why sync, not async:** No DB lookup in the hot path. Caller is responsible for loading the org (which they need to do anyway to find the entity being charged/refunded). This also eliminates R4 (perf regression) entirely.

### 3.3 — Refactor pattern at every call site

| File | Function | Refactor |
|---|---|---|
| `estimate.controller.ts` | Approve estimate (creates checkout session for deposit) | Add `organization` to existing `include`; `const ctx = getStripeForOrg(estimate.organization); createCheckoutSession(opts, ctx)` |
| `estimate.controller.ts` | Refund deposit | Same pattern; org accessible via `deposit.estimate.organization` (extend include) |
| `invoice.controller.ts` | Public checkout | Org via `invoice.organization` (already an FK) |
| `invoice.controller.ts` | NEW Refund invoice | Same pattern |
| `webhook.controller.ts` | Verify webhook signature & process event | Org resolved from event metadata (see §3.4); `const ctx = getStripeForOrg(org)` after resolution |

Mechanical change. Compiler tells you every site that needs updating because `createCheckoutSession`'s signature gains a required `ctx` parameter. **Sync — no `await` on the helper itself.** Each call site already does an `await prisma.X.findUnique(...)` to load the entity being charged; we just extend the existing `include` to pull `organization` along with it.

### 3.4 — Webhook handler: org resolution from event metadata

Goal: identify which org an event belongs to *without* relying on `findFirstOrThrow` (which silently picks "first row in table" — fine for single-tenant, broken for 9C2).

The right approach: resolve the org from the event payload itself, using the metadata we already attach:
- `checkout.session.completed`: metadata has `depositId` or `invoiceId` → look up parent → org
- `charge.refunded`: lookup by `payment_intent` → finds Payment (→ Invoice → Org) or Deposit (→ Estimate → Org)
- Fallback: if `event.account` is set (Connect Direct charges in 9C2), look up org by `stripe_account_id`

```typescript
// Helper used by every event branch
async function resolveOrgFromEvent(event: Stripe.Event): Promise<Organization | null> {
  // 9C2 path — Connect Direct charges populate event.account
  const accountId = event.account;
  if (accountId) {
    const found = await prisma.organization.findFirst({ where: { stripe_account_id: accountId } });
    if (found) return found;
    logger.warn(`Webhook for unknown connected account ${accountId}`);
    return null;
  }

  // Phase 0 / platform path — resolve via metadata
  const obj = event.data.object as any;
  const depositId = obj.metadata?.depositId;
  const invoiceId = obj.metadata?.invoiceId;
  const paymentIntentId = obj.payment_intent ?? (event.type === 'charge.refunded' ? obj.payment_intent : null);

  if (depositId) {
    const dep = await prisma.deposit.findUnique({
      where: { id: depositId },
      select: { estimate: { select: { organization: true } } },
    });
    return dep?.estimate.organization ?? null;
  }
  if (invoiceId) {
    const inv = await prisma.invoice.findUnique({
      where: { id: invoiceId },
      select: { organization: true },
    });
    return inv?.organization ?? null;
  }
  if (paymentIntentId) {
    // charge.refunded — look up Payment first, then Deposit
    const payment = await prisma.payment.findFirst({
      where: { stripe_payment_intent_id: paymentIntentId },
      select: { invoice: { select: { organization: true } } },
    });
    if (payment) return payment.invoice.organization;
    const deposit = await prisma.deposit.findFirst({
      where: { stripe_payment_intent_id: paymentIntentId },
      select: { estimate: { select: { organization: true } } },
    });
    return deposit?.estimate.organization ?? null;
  }

  return null;  // Unknown event — caller decides how to handle
}
```

Each event handler calls this at the top:

```typescript
const org = await resolveOrgFromEvent(event);
if (!org) {
  // Record StripeEvent to prevent retries; log; return 200
  await prisma.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
  res.json({ received: true, unresolved_org: true });
  return;
}
const ctx = getStripeForOrg(org);
// proceed
```

**9C2 architectural assumption flagged:** the `event.account` branch above assumes 9C2 will use **Direct charges** — where each connected account's events arrive on the platform endpoint with `event.account` populated. If 9C2 instead uses Standard onboarding's *connected-account-owned webhook endpoints* (Stripe's default), this branch becomes a no-op and we resolve org by which webhook endpoint received the request (set per-deployment env var `WEBHOOK_FOR_ACCOUNT=<connected_account_id>`). Either path works; the one we pick will be a 9C2 brainstorm decision. The code in 9C is correct for either direction because metadata-based resolution always works for our own platform charges.

### 3.5 — `charge.refunded` webhook handler (NEW)

**Race resolution via Stripe Refund metadata** — the in-app refund passes `metadata: { source: 'in_app' }` when calling `stripe.refunds.create()` (see §3.6). The `charge.refunded` webhook reads that metadata back from the Refund object and skips processing — no DB-status race window.

```typescript
case 'charge.refunded': {
  const charge = event.data.object as Stripe.Charge;
  const paymentIntentId = charge.payment_intent as string;
  const refundedCents = charge.amount_refunded;

  // The most recent Refund on this charge — the one that triggered this webhook delivery
  const latestRefund = charge.refunds?.data?.[0];
  const isInAppRefund = latestRefund?.metadata?.source === 'in_app';

  if (isInAppRefund) {
    // The in-app handler is authoritative for state; it's writing the DB right now (or just did).
    // Just record the event so Stripe doesn't retry. R2 race fully resolved at the source.
    logger.info(`charge.refunded for in-app refund ${latestRefund.id}; recording event only`);
    await prisma.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });
    eventRecorded = true;
    break;
  }

  // Dashboard-initiated refund — we own state changes
  // Try invoice path first
  const payment = await prisma.payment.findFirst({
    where: { stripe_payment_intent_id: paymentIntentId },
    include: { invoice: true },
  });

  if (payment) {
    await prisma.$transaction(async (tx) => {
      // Idempotency first — see §3.7 for rationale
      await tx.stripeEvent.create({ data: { stripe_event_id: event.id, event_type: event.type } });

      await tx.payment.update({
        where: { id: payment.id },
        data: { refunded_at: new Date(), refunded_amount: refundedCents / 100 },
      });
      await tx.invoice.update({
        where: { id: payment.invoice_id },
        data: {
          status: 'REFUNDED',
          total_refunded: refundedCents / 100,
          refunded_at: new Date(),
          refund_reason: 'Refunded via Stripe dashboard',
        },
      });
      await tx.timelineEvent.create({
        data: {
          entity_type: 'INVOICE',
          entity_id: payment.invoice_id,
          event_type: 'INVOICE_REFUNDED',
          description: `Invoice refunded $${refundedCents / 100} via Stripe dashboard`,
          metadata: { source: 'stripe_dashboard', refund_id: latestRefund?.id },
        },
      });
    });
    eventRecorded = true;
    break;
  }

  // Fall through to deposit path (same pattern: deposit lookup, transaction with stripeEvent.create first)
  const deposit = await prisma.deposit.findFirst({
    where: { stripe_payment_intent_id: paymentIntentId },
    include: { estimate: true },
  });
  if (deposit) {
    // Same shape as invoice path: stripeEvent.create FIRST, then deposit + estimate updates, then timeline event
    // metadata.source = 'stripe_dashboard'
  } else {
    logger.warn(`charge.refunded for unknown payment_intent ${paymentIntentId}`);
  }
  break;
}
```

**Why metadata-on-refund (not metadata-on-charge):** The in-app refund creates a `Refund` object via `refunds.create({ payment_intent, metadata })`. That metadata is preserved on the Refund and exposed inside `charge.refunds.data[]` when `charge.refunded` fires. `charge.metadata` is set when the charge is created (during checkout) and isn't modifiable by the refund call.

### 3.6 — Invoice refund endpoint (NEW)

Mirrors deposit refund. Schema unchanged — invoice already has `total_refunded`, `refunded_at`, `refund_reason`, `refund_reason_category` fields.

```typescript
// backend/src/controllers/invoice.controller.ts

export const refundInvoiceSchema = z.object({
  reason_category: z.enum(['CUSTOMER_REQUEST', 'ERROR', 'CHARGEBACK', 'OTHER']),
  reason: z.string().min(1).max(500),
});

export async function refundInvoice(req: Request, res: Response) {
  // 1. Auth: ADMIN only (route-level via authorize('ADMIN'))
  // 2. Load invoice WITH organization and payments (single query)
  //    include: { organization: true, payments: { where: { method: 'CARD' } } }
  // 3. Validate:
  //    - invoice.status === 'PAID' (else 400)
  //    - payments.length === 1 (R5: multi-payment → 400 "Refund via Stripe dashboard; will sync via charge.refunded")
  //    - payment.stripe_payment_intent_id present (else 400)
  // 4. const ctx = getStripeForOrg(invoice.organization);
  // 5. Issue Stripe refund: createRefund(payment.stripe_payment_intent_id, ctx, undefined,
  //                                       { metadata: { source: 'in_app', invoiceId } })
  //    Note: metadata is on the Refund object (R2 race resolution — see §3.5)
  // 6. Transaction (stripeEvent NOT used here — only webhooks need idempotency):
  //    - Payment.update: refunded_at, refunded_amount
  //    - Invoice.update: status=REFUNDED, total_refunded, refunded_at, refunded_by, refund_reason, refund_reason_category
  //    - TimelineEvent.create: INVOICE_REFUNDED with metadata.source='in_app', refunded_by_user_name
  // 7. Fire-and-forget refund email (Resend may fail; logged only — see R9)
}

// Route
router.post('/:id/refund', authorize('ADMIN'), validate(refundInvoiceSchema), invoiceController.refundInvoice);
```

`createRefund` signature is extended to accept Stripe metadata as a fourth parameter:

```typescript
export async function createRefund(
  paymentIntentId: string,
  ctx: { stripe: Stripe; stripeAccount?: string },
  amountInCents?: number,
  options?: { metadata?: Record<string, string> },
): Promise<Stripe.Refund> {
  const params: Stripe.RefundCreateParams = { payment_intent: paymentIntentId };
  if (amountInCents) params.amount = amountInCents;
  if (options?.metadata) params.metadata = options.metadata;
  return ctx.stripe.refunds.create(params, ctx.stripeAccount ? { stripeAccount: ctx.stripeAccount } : undefined);
}
```

**Deposit refund also gains the metadata flag** — same one-line change to set `metadata: { source: 'in_app', depositId }` when calling `createRefund` from `estimate.controller.ts`. Otherwise the dashboard-refund webhook can't tell it apart from a real dashboard-initiated refund of a deposit.

Frontend: `RefundInvoiceDialog.tsx` cloned from `RefundDepositDialog.tsx` — same form, same UX, mounted in `InvoiceDetailPage`.

### 3.7 — Idempotency tightening

Two corrections to the existing pattern:

1. **`stripeEvent.create` runs FIRST inside each transaction**, not last. If the duplicate-key fires, no other writes have happened yet — no rollback work, simpler reasoning.
2. **`DuplicateWebhookError` must be caught explicitly outside the transaction** *before* the generic `catch (err) → 500` fallback, otherwise Stripe sees 500 and retries (the exact loop we're trying to prevent).

```typescript
import { Prisma } from '@prisma/client';

class DuplicateWebhookError extends Error {}

// Inside each transaction (every event handler):
await prisma.$transaction(async (tx) => {
  // FIRST — atomic idempotency claim
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

  // ... then the actual state changes (deposit/invoice update, timeline event, etc.)
});

// Outer handler — catch BEFORE the generic 500 path:
try {
  await processEvent(event);
  res.json({ received: true });
} catch (err) {
  if (err instanceof DuplicateWebhookError) {
    res.json({ received: true, duplicate: true });  // 200, not 500 — Stripe stops retrying
    return;
  }
  logger.error('Webhook processing error:', err);
  res.status(500).json({ error: 'Webhook handler failed' });
}
```

The `stripe_event_id` column already has `@unique` in the schema, so the constraint is enforced — we just need to interpret the error correctly **and** respond 200 to break the retry loop.

**Note:** the existing top-of-handler `findUnique` check is kept as a fast path (avoids opening a transaction for known duplicates), but is no longer the sole defense. The P2002 catch closes the race.

---

## Section 4 — Verification Harness Design

`backend/scripts/verify-stripe.ts` — a TypeScript script you run against a live local backend.

### 4.1 — Scope

**Does:**
- Verifies env config (keys present, formatted as `sk_test_*` not `sk_live_*` in dev/staging, signing secret loadable)
- Creates DB fixtures (org, customer, lead, estimate, deposit, invoice) in a sandboxed namespace
- POSTs properly-signed synthetic webhook events to `/api/webhooks/stripe` with crafted metadata
- Asserts DB state after each event (every assertion in §2's matrix)
- Tests duplicate-delivery (R8), signature mismatch (R3), amount mismatch, missing metadata
- Tests `charge.refunded` against both invoice and deposit paths (including R2 skip-when-already-refunded)
- Issues real refunds against the Stripe sandbox API to verify our `createRefund` lib call actually reaches Stripe
- Cleans up its own fixtures (R7 mitigation)
- Exits non-zero on any assertion failure (so it can run in CI eventually)

**Does NOT:**
- Drive the customer-facing browser flow (that's the runbook's job)
- Run end-to-end against live mode (refuses without `--live --confirm-i-mean-it` flag)
- Replace the unit tests — the harness exists *because* unit tests mock Stripe and don't catch wire-level bugs

### 4.2 — Why we POST signed events (not `stripe trigger` for everything)

1. **Crafted metadata.** `stripe trigger checkout.session.completed` fires Stripe's sample fixture, which has no `depositId` or `invoiceId` in metadata. Synthesizing our own payloads is faster and clearer.
2. **Determinism.** Synthetic events let us assert exact amounts, exact IDs, exact metadata.

We *do* still use `stripe-cli` for one specific case in the runbook: issuing a real refund via Stripe dashboard or `stripe-cli` to verify the dashboard-refund flow live. The harness covers it with synthetic-event assertions; the runbook covers it interactively.

### 4.3 — Webhook signing

The harness uses `stripe.webhooks.generateTestHeaderString({ payload, secret, timestamp })` to produce valid signatures, so the production signature-verification path actually runs (not the test-env bypass). Critical for production-readiness — covers R3.

### 4.4 — Script structure

```
verify-stripe.ts
├── preflight()                            # env vars present, format correct, backend reachable, Stripe API version match (R6)
├── setupFixtures()                        # create one org, customer, lead, estimate, invoice — sandboxed by name prefix "9C-VERIFY-"
├── tests/
│   ├── flow-A-deposit-checkout.ts         # synthesize checkout.session.completed for deposit, assert
│   ├── flow-B-invoice-checkout.ts         # same for invoice + PARTIAL invoice variant
│   ├── flow-C-deposit-refund-realapi.ts   # call our refund endpoint, then assert the refund actually exists in Stripe sandbox
│   ├── flow-D-invoice-refund-realapi.ts   # same for invoice; also tests R5 multi-payment rejection
│   ├── flow-E-charge-refunded-sync.ts     # fire charge.refunded, assert DB sync; R2 metadata.source='in_app' skip variant
│   ├── idempotency-double-fire.ts         # fire same event 5x in parallel — covers R8
│   ├── signature-mismatch.ts              # bad sig → 400 — covers R3
│   ├── amount-mismatch.ts                 # tampered amount → no state change
│   ├── missing-metadata.ts                # no depositId/invoiceId → no state change
│   └── connect-infra.ts                   # call sites use sync indirection (grep + tests); webhook resolves org from metadata
├── teardownFixtures()                     # delete only "9C-VERIFY-*" rows
└── report()                               # green/red summary, total assertions, failures
```

Each test is independent and self-contained. Failure in one doesn't cascade.

### 4.5 — Sandboxing fixtures (R7 mitigation)

Every fixture row has `organization.name = '9C-VERIFY-<timestamp>'` and customer/estimate/invoice records reference it. Teardown deletes by org. A failed run still cleans up via `try/finally` in the orchestrator. Even if cleanup fails, the unique timestamp prefix means each run is isolated.

The harness refuses to run if there's no `9C-VERIFY-*` org but a real org named, say, `Alpha Security` exists with payments — bailing out before mutating anything.

### 4.6 — Invocation

```bash
npm run verify:stripe -- --preflight       # no DB mutation, no API calls
npm run verify:stripe                       # full sandbox run
npm run verify:stripe -- --verbose          # shows each event sent + assertion result
npm run verify:stripe -- --live --confirm-i-mean-it  # live mode, requires explicit acknowledgement
```

### 4.7 — What this catches that unit tests don't

- Real signature verification (unit tests bypass it) — R3
- Real express raw-body middleware (unit tests use supertest with quirky Buffer encoding)
- Real Stripe SDK against sandbox API for refunds (unit tests mock `createRefund`)
- Webhook routing across event types under realistic delivery shape
- Idempotency under racing fire-twice (unit tests mock prisma) — R8

---

## Section 5 — Stripe Environment Configuration Runbook (skeleton)

Full content goes in `md_files/plans/payments/stripe-environment-config.md` — written during 9C execution. This section captures the structure and key callouts.

### 5.1 — Quick Reference (top of runbook)

| Environment | Stripe mode | Key prefix | Webhook URL |
|---|---|---|---|
| Local dev | test | sk_test_ / whsec_test_ | localhost via `stripe listen` forward |
| Staging | test | sk_test_ / whsec_test_ | https://staging.alphacrm.com/api/webhooks/stripe |
| Production | LIVE | sk_live_ / whsec_live_ | https://app.alphacrm.com/api/webhooks/stripe |

**Key principle:** the three environments coexist forever. You never "switch" — you visit a different URL. Each environment has its own forever-keys injected by the host's secret store.

### 5.2 — Section outline

1. Stripe account setup (one-time)
2. Local dev setup (stripe-cli + `.env`)
3. Staging environment setup (staging webhook endpoint, env vars on host)
4. Production environment setup (live webhook endpoint, sk_live keys on host)
5. The $1 production smoke transaction (CRITICAL — catches R3)
6. Rollback procedure
7. Where to watch (observability)
8. Key rotation procedure
9. Connect mode (Phase 1 — extended in 9C2 spec)
10. Common failure modes (FAQ — risk-tagged)

### 5.3 — Risk callouts in the runbook

Each step that's risk-bearing gets an inline note. Examples:

- **Step 5.5 (verify deposit shows PAID in production CRM):** *If this fails, suspect R3 (signing secret) or R7 (env var routing).*
- **Step 4.5 (add env vars to production host):** *Verify no trailing whitespace in `STRIPE_WEBHOOK_SECRET` — common copy-paste failure mode covered by R3.*
- **Step 6.2 (rollback by setting `STRIPE_SECRET_KEY=<empty>`):** *The app handles this gracefully — `isStripeConfigured()` returns false, public pay buttons don't render. Verified by unit test.*

### 5.4 — Living document

Checked into git. Each Stripe-related infra change updates this runbook. The vault `Stripe-Integration.md` note links to it but doesn't duplicate.

---

## Section 6 — Risks, Dependencies, Exit Plan, Post-9C State

### 6.1 — Risks (with IDs used throughout the spec)

| ID | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| **R1** | Refactoring 38 call sites breaks an existing test | Medium | Medium | Type-safe indirection so compiler catches missed sites; full suite run after each refactor commit |
| **R2** | `charge.refunded` races with in-app refund (double-update) | Low | Low | In-app refund passes `metadata: { source: 'in_app' }` on `refunds.create()`; webhook reads it back from `charge.refunds.data[0].metadata.source` and skips state changes (records event only). No DB-status race window — flag is set on the Stripe object itself before the webhook can fire. |
| **R3** | Webhook signature verification fails in production due to env var copy-paste error | Medium | High | Runbook explicit `whsec_` prefix note; harness preflight format validation; production smoke transaction catches this before real customers pay |
| **R4** | Connect indirection introduces perf regression | Eliminated | — | `getStripeForOrg(org)` is now sync and accepts an already-loaded Org. Caller's existing query simply extends `include` to pull `organization`. No new DB calls. R4 is closed by the design itself. |
| **R5** | Invoice refund mishandled when invoice has multiple CARD payments | Low | Medium | Endpoint validation rejects with 400 + clear error; unit test covers explicitly |
| **R6** | Stripe API version pinned to a deprecated value | Low | Low | Pinned in code; harness preflight static check warns on drift |
| **R7** | Harness fixtures leak into staging/prod | Low | High | `9C-VERIFY-` org name prefix; teardown in `try/finally`; refuses live mode without explicit flag |
| **R8** | Idempotency race window (concurrent webhook deliveries) | Low | Medium | StripeEvent unique constraint + Prisma P2002 catch with `stripeEvent.create` as FIRST statement in transaction; explicit `DuplicateWebhookError` returned 200 (not 500) so Stripe stops retrying; transaction-wrapped writes; emails fire post-commit only |
| **R9** | Refund email delivery fails silently if Resend is down | Low | Low | Refund emails are fire-and-forget; failures logged but not surfaced. Customer sees money returned but no email. Mitigation deferred: Resend has its own retry; manual resend possible from Stripe dashboard email tools or admin can re-send via the Resend dashboard. Acceptable for MVP; revisit if production observability shows recurring drops. |

### 6.2 — Dependencies

**External (must exist before 9C starts):**
- Stripe sandbox account (env.ts has STRIPE_SECRET_KEY in schema as optional ✓)
- stripe-cli installable via package manager
- Staging environment exists ✓
- Local backend reachable at `localhost:3000` for harness

**Internal (already exist):**
- `Organization` model in schema ✓
- `StripeEvent` table for idempotency ✓
- `Payment.stripe_payment_intent_id` ✓
- `Deposit.stripe_payment_intent_id` ✓
- `Deposit.total_refunded`, `refunded_at`, `refund_reason`, `refund_reason_category` already in schema ✓ (deposit refund flow)
- `RefundDepositDialog` component to mirror ✓
- Existing webhook test harness pattern to extend ✓

**Internal (NEW — added in 9C, not pre-existing):**
- Invoice refund fields on `Invoice` (`total_refunded`, `refunded_at`, `refund_reason`, `refund_reason_category`, `refunded_by`) and `Payment` (`refunded_at`, `refunded_amount`)
- `REFUNDED` value added to `InvoiceStatus` enum
- These were incorrectly assumed pre-existing in the original spec — schema review showed they're missing. Now part of §3.1.2.

**No blockers identified** beyond the schema work above (which is part of 9C scope).

**Things 9C2 depends on (we set them up correctly here):**
- `getStripeForOrg(org)` indirection in place (sync, takes Org)
- `Organization.stripe_account_id` field migrated
- Webhook handler reads `event.account` field
- Webhook handler is org-aware (resolves org from event before processing)

### 6.3 — Exit plan (gates before declaring 9C complete)

Hard gates:

- [ ] Every row in §2 verification matrix (V1, frozen at start of execution) ticked off — count is fragile, the matrix itself is the gate
- [ ] All 605+ existing backend tests still pass (refactor must not break anything — R1)
- [ ] New unit tests added for: invoice refund endpoint, `charge.refunded` handler (both paths), `getStripeForOrg`, idempotency P2002 catch, webhook account-routing logic
- [ ] Browser runbook completed — every flow walked through manually with notes/screenshots in the checklist
- [ ] Stripe environment configuration runbook reviewed
- [ ] `Architecture/Stripe-Integration.md` vault note rewritten to reflect production-ready single-tenant + Connect-ready architecture
- [ ] `PRE-LAUNCH-CHECKLIST.md` Stripe section updated: stale TODOs replaced with pointers to runbook
- [ ] `Status/Build-Progress.md` flips 9C from ⬜ to ✅ with completion date
- [ ] `Status/Current-Focus.md` shifts focus to next step (9D Notifications)
- [ ] Spec doc passed `superpowers:requesting-code-review` workflow

Soft gates:
- Demo of all 5 flows in browser on staging
- $1 smoke transaction once production is also configured (may be outside 9C if prod deploy is a separate step)

### 6.4 — Post-9C state

**Codebase:**
- Every Stripe API call goes through `getStripeForOrg(orgId)` — single, greppable seam
- `Organization.stripe_account_id` exists (always null today)
- Webhook handler reads `event.account` (always null/platform today)
- Invoice refund endpoint + UI mirror deposit refund
- `charge.refunded` handler exists for both paths
- Idempotency hardened with P2002 catch
- ~50 new lines of code, ~30 changed lines of refactor across 5 files

**Queued for 9C2:**
- Connect Standard OAuth onboarding flow (`OrganizationSettingsPage`)
- Disconnect / re-connect flow
- Connect-specific webhook events (`account.updated`, `account.application.deauthorized`)
- Per-account webhook signing secret resolution
- Connect-aware harness extension (multiple test connected accounts)
- Connect mode addendum to environment configuration runbook

**Stays out of MVP entirely (post-MVP backlog):**
- `payment_intent.succeeded` (only matters with Stripe Elements)
- Dispute handling (`charge.dispute.created`, `charge.dispute.closed`)
- Partial invoice refunds (full only in MVP)
- Apple Pay / Google Pay (auto-enabled)
- Multi-payment invoice refund (single CARD payment refundable in MVP)
- Stripe Tax / Stripe Billing / Stripe Issuing
- Application / platform fees (subscription-only revenue model)

### 6.5 — Open questions parking lot

Items where I've made a default choice but you may want to revisit:

| Question | Default | Alternative |
|---|---|---|
| Refund email subject for dashboard-initiated refunds | Same template as in-app refund | Different subject if you want the audit trail visible to customers |
| Production webhook events to subscribe to | `checkout.session.completed`, `charge.refunded` only | Add `charge.dispute.created` for early-warning chargeback visibility |
| Whether to retry failed in-app refunds | No automatic retry; admin sees error and retries manually | Automatic retry with exponential backoff (more complexity) |
| Whether the harness should run against staging too | Local only by default; `--target=staging` flag for manual extension | Always run against staging in CI (post-MVP — needs CI setup first) |
| Whether to add a `WebhookDeliveryLog` table for full audit | No — StripeEvent is enough; Stripe dashboard delivery log is source of truth | Add table if observability gaps surface in production |

### 6.6 — Risk Coverage Matrix

Cross-reference: every risk has at least one test pinned to it.

| Risk | Unit tests | Harness tests | Runbook step |
|---|---|---|---|
| R1 (refactor breakage) | All 605 existing tests | `connect-infra.ts` (grep + run suite) | — |
| R2 (charge.refunded race) | `webhook.test.ts` reads `metadata.source='in_app'` and skips state changes | `flow-E-charge-refunded-sync.ts` (in-app metadata variant + dashboard variant) | — |
| R3 (signing secret copy-paste) | `webhook.test.ts` malformed sig | `signature-mismatch.ts`, preflight format check | §5 step 5.5 production smoke |
| R4 (perf regression) | — | — | Closed by design (sync helper, no DB lookup) |
| R5 (multi-payment invoice refund) | `invoices.test.ts` rejection test | `flow-D-invoice-refund-realapi.ts` rejection variant | — |
| R6 (deprecated API version) | — | `preflight()` static check vs SDK constant | §10 common failure modes |
| R7 (fixture leakage) | — | `setupFixtures` + `teardownFixtures` + name prefix check | §5 (harness invocation note) |
| R8 (concurrent idempotency race) | `webhook.test.ts` P2002 catch path → 200 response (not 500) | `idempotency-double-fire.ts` (5 parallel deliveries) | — |
| R9 (Resend silent email failure) | — | — | Documented as accepted MVP limitation; observability via Resend dashboard |

**Coverage check:** every load-bearing risk has ≥1 test. R4 is closed by the design (no test needed). R9 is accepted as a known limitation, deferred to post-MVP if it surfaces.

---

## Implementation Sequence (preview — full plan in writing-plans phase)

Phase-driven (not vertical slices — see brainstorm rationale):

1. **Setup (0.5 day)** — install stripe-cli, set up local `.env`, register staging webhook, verify staging env vars
2. **Schema migration (0.25 day)** — Invoice + Payment refund fields, `Organization.stripe_account_id`, `InvoiceStatus.REFUNDED`, run `prisma migrate dev`
3. **Audit + new code (1.5 days)** — run existing tests, document gap inventory, build invoice refund endpoint + dialog, build `charge.refunded` handler with metadata-based race resolution, add P2002 idempotency catch with first-statement positioning + outer DuplicateWebhookError catch, add metadata-source flag on all `refunds.create` call sites, add new unit tests
4. **Connect infrastructure (0.5 day)** — sync `getStripeForOrg(org)`, refactor every call site (extend `include` to pull `organization`), `resolveOrgFromEvent` helper for webhook routing
5. **Verification harness (1 day)** — write `verify-stripe.ts`, sandboxed fixtures, all flow tests, signature/amount/idempotency tests
6. **Browser runbook execution (0.5 day)** — walk through every flow in §2 manually, screenshot, sign off
7. **Documentation (0.5 day)** — Stripe environment configuration runbook, vault note rewrite, PRE-LAUNCH-CHECKLIST update
8. **Spec review + final (0.5 day)** — code review, fix issues, mark exit gates green, flip Build-Progress to ✅

**Total: ~4.25 days** (revised after spec review).

---

## Appendix A — Files touched (summary)

| File | Action |
|---|---|
| `backend/prisma/schema.prisma` | Add `Organization.stripe_account_id`; add Invoice refund fields (`total_refunded`, `refunded_at`, `refund_reason`, `refund_reason_category`, `refunded_by`); add Payment refund fields (`refunded_at`, `refunded_amount`); add `REFUNDED` to `InvoiceStatus` enum; add `User.refunded_invoices` back-relation `InvoiceRefundedBy` |
| `backend/prisma/migrations/<timestamp>_stripe_9c/migration.sql` | New migration covering all schema changes above |
| `backend/src/lib/stripe.ts` | Add `getStripeForOrg`, refactor `createCheckoutSession` + `createRefund` to take `ctx` |
| `backend/src/controllers/estimate.controller.ts` | Refactor 2 call sites to use `getStripeForOrg` |
| `backend/src/controllers/invoice.controller.ts` | Refactor 1 call site + add `refundInvoice` endpoint + schema |
| `backend/src/controllers/webhook.controller.ts` | Add `charge.refunded` handler, `event.account` routing, P2002 idempotency catch |
| `backend/src/routes/invoice.routes.ts` | Add `POST /:id/refund` route |
| `backend/src/__tests__/invoices.test.ts` | New tests for `refundInvoice`, multi-payment rejection (R5) |
| `backend/src/__tests__/webhook.test.ts` | New tests for `charge.refunded` (both paths), R2 skip, P2002 idempotency |
| `backend/scripts/verify-stripe.ts` | NEW |
| `backend/package.json` | Add `verify:stripe` script |
| `frontend/src/components/invoices/RefundInvoiceDialog.tsx` | NEW |
| `frontend/src/pages/InvoiceDetailPage.tsx` | Mount Refund button + dialog (ADMIN only) |
| `md_files/plans/payments/stripe-environment-config.md` | NEW |
| `md_files/plans/payments/2026-04-29-stripe-test-mode-verification.md` | NEW (the live checklist) |
| `Architecture/Stripe-Integration.md` (vault) | Rewrite for production-ready + Connect-ready architecture |
| `PRE-LAUNCH-CHECKLIST.md` | Update Stripe section to point at runbook |
| `Status/Build-Progress.md` (vault) | Flip 9C to ✅ |
| `Status/Current-Focus.md` (vault) | Update to 9D Notifications |
