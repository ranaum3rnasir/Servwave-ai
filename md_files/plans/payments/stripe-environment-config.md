# Stripe Environment Configuration Runbook

> **Status:** Production-ready (9C complete 2026-05-01)
> **Scope:** Single-tenant platform-managed Stripe. Connect Standard onboarding deferred to 9C2.
> **Surcharge removed 2026-07-21** — homeowners pay face value.

## Quick Reference

| Environment | Stripe mode | Key prefix | Webhook URL |
|---|---|---|---|
| Local dev | test | `sk_test_` / `whsec_` (from `stripe listen`) | `localhost:3000/api/webhooks/stripe` via `stripe listen --forward-to` |
| Staging | test | `sk_test_` / `whsec_test_` | `https://alpha-crm-test-env.onrender.com/api/webhooks/stripe` |
| Production | **LIVE** | `sk_live_` / `whsec_live_` | `https://api.servwave.com/api/webhooks/stripe` |

> **Hostnames corrected 2026-08-25.** This table used to name `staging.alphacrm.com` and
> `app.alphacrm.com`. Neither ever carried the app — `alphacrm.com` is a parked domain that is
> currently for sale — so any endpoint registered from the old table delivered nowhere. A webhook
> is served by the **backend**, so both URLs are API hosts, not the frontend ones
> (`app.servwave.com` / `servwave-demo.vercel.app`). Both were verified returning 200 on
> `/health` on 2026-08-25.

**Key principle:** the three environments coexist forever. You never "switch" keys — each environment has its own keys in its own secret store. Moving between environments means visiting a different URL, not swapping keys.

---

## Section 1 — Stripe Account Setup (one-time)

1. Log in at [dashboard.stripe.com](https://dashboard.stripe.com) and ensure you are in **test mode** (toggle top-right).
2. Go to **Developers → API keys** and copy your test secret key (`sk_test_...`). Save to a password manager — you will inject it as an environment variable, never commit it to git.
3. Note the **publishable key** (`pk_test_...`) — needed only if you add embedded Stripe Elements. Currently unused (checkout.sessions redirect).
4. Create a named restricted key for production with only the permissions your app needs (Charges: Write, Refunds: Write, Webhooks: Read, Payment Intents: Write, Checkout Sessions: Write). Reduces blast radius if leaked.

---

## Section 2 — Local Dev Setup (stripe-cli + .env)

### 2.1 Install stripe-cli

```bash
# Windows via Scoop
scoop install stripe

# Mac via Homebrew
brew install stripe/stripe-cli/stripe
```

### 2.2 Authenticate

```bash
stripe login
```

Opens browser, authorises the CLI to your Stripe account.

### 2.3 Configure .env

Add to `backend/.env` (never commit this file):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...   ← from step 2.4 below
```

### 2.4 Start stripe listen

```bash
stripe listen --forward-to localhost:3000/api/webhooks/stripe
```

The CLI prints a `whsec_...` signing secret on startup. **Copy this value** and set it as `STRIPE_WEBHOOK_SECRET` in `backend/.env`.

> ⚠️ **R3 risk:** The `whsec_` value rotates each time `stripe listen` restarts. If it differs from what's in `.env`, signature verification fails with 400s. Fix: copy the new value from the CLI output → update `.env` → restart backend.

### 2.5 Restart backend

```bash
npm run dev:backend
```

The backend must restart to pick up the updated `.env`.

### 2.6 Verify

Run the harness preflight:

```bash
cd backend && npm run verify:stripe -- --preflight
```

Expected: `✓ Preflight passed`.

---

## Section 3 — Staging Environment Setup

### 3.1 Register a staging webhook endpoint

1. In Stripe dashboard (test mode) → **Developers → Webhooks → Add endpoint**
2. URL: `https://alpha-crm-test-env.onrender.com/api/webhooks/stripe`
3. Events to listen for: `checkout.session.completed`, `charge.refunded`
4. Click **Add endpoint**. Stripe shows the signing secret (`whsec_test_...`). Save it.

### 3.2 Set environment variables on staging host

Inject via your host's secret store (Railway, Render, etc.):

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_test_...   ← from step 3.1
```

> ⚠️ **R3 risk:** Verify no trailing whitespace in `STRIPE_WEBHOOK_SECRET`. Copy from the Stripe dashboard "Reveal" button, not from a re-typed note.

### 3.3 Deploy and smoke test

Run a full checkout in the staging app using test card `4242 4242 4242 4242`. Verify deposit/invoice transitions in staging CRM.

---

## Section 4 — Production Environment Setup

> ⚠️ **Do this once, carefully. Production Stripe charges real money.**

### 4.1 Switch to live mode in Stripe dashboard

Toggle the Stripe dashboard from test → live mode (top-right toggle).

### 4.2 Create live webhook endpoint

1. **Developers → Webhooks → Add endpoint**
2. URL: `https://api.servwave.com/api/webhooks/stripe`
3. Events: `checkout.session.completed`, `charge.refunded`
4. Save the `whsec_live_...` signing secret.

### 4.3 Create a live restricted key

Create a restricted API key (Charges: Write, Refunds: Write, Webhooks: Read, Payment Intents: Write, Checkout Sessions: Write). Copy the `sk_live_rk_...` value.

### 4.4 Inject into production host

```
STRIPE_SECRET_KEY=sk_live_rk_...         ← live restricted key
STRIPE_WEBHOOK_SECRET=whsec_live_...     ← from 4.2
```

> ⚠️ **R3 risk:** Double-check the `STRIPE_SECRET_KEY` prefix — must start with `sk_live_`. The preflight check (`npm run verify:stripe -- --preflight`) will warn if it's a test key.

### 4.5 Deploy and proceed to Section 5 (smoke transaction)

---

## Section 5 — The $1 Production Smoke Transaction (CRITICAL)

**This is the single most important step.** It verifies the full end-to-end loop in production before any real customer pays.

### 5.1 Create a $1 estimate

In the live CRM, create a customer + lead → estimate with a $1 total → request a $1 deposit.

### 5.2 Send the estimate link to yourself

Use your own email. Click the Stripe Checkout link.

### 5.3 Pay with a real card

Use a real card (your own). The charge will be real. Stripe will charge exactly $1 (face value — no surcharge).

### 5.4 Verify webhook received

In Stripe dashboard → **Developers → Webhooks → your production endpoint** → recent events. Confirm `checkout.session.completed` has a green ✓.

### 5.5 Verify CRM reflects payment

In the live CRM:
- Deposit → **PAID** ✓
- Estimate → **APPROVED** ✓
- Lead → **WON** ✓
- Timeline event shows deposit paid ✓

> ⚠️ **If this fails:** suspect R3 (wrong `STRIPE_WEBHOOK_SECRET` — see rollback §6) or env var not picked up (restart the backend process).

### 5.6 Issue a refund

In Stripe dashboard → find the $1 charge → Refund. Verify CRM deposit → **REFUNDED**. Confirms `charge.refunded` handler is live.

### 5.7 Sign off

Mark this step complete in `md_files/plans/payments/2026-04-29-stripe-test-mode-verification.md`.

---

## Section 6 — Rollback Procedure

If Stripe integration is causing problems in production:

### 6.1 Disable Stripe (instant, safe)

Remove or blank `STRIPE_SECRET_KEY` in the production host's secret store and redeploy.

Effect: `isStripeConfigured()` returns false → public pay buttons don't render. Existing PAID deposits/invoices are unaffected. No data loss.

### 6.2 Fix the underlying issue

Common fixes:
- Wrong `STRIPE_WEBHOOK_SECRET` → update env var to match the Stripe dashboard signing secret → redeploy
- Wrong key prefix (`sk_test_` in production) → replace with `sk_live_` key → redeploy
- Webhook endpoint URL typo → update in Stripe dashboard → no redeploy needed

### 6.3 Re-enable

Re-add `STRIPE_SECRET_KEY` → redeploy. Run the smoke transaction (§5) again.

---

## Section 7 — Where to Watch (Observability)

| Signal | Where | What to look for |
|---|---|---|
| Webhook delivery | Stripe dashboard → Developers → Webhooks → endpoint | Green ✓ per event; red ✗ opens event details with response body |
| Backend errors | Winston logs (Railway/Render log stream) | `Webhook processing error:` or `Webhook signature verification failed` |
| Email delivery | Resend dashboard → Logs | Refund/payment confirmation emails; R9 note: fire-and-forget, failures logged only |
| Payment intents | Stripe dashboard → Payments | Status, refund status, dispute flag |
| Refund latency | Stripe → Refunds | Typically 5-10 business days for card refunds to appear on customer statement |

---

## Section 8 — Key Rotation Procedure

### 8.1 Rotate the signing secret (whsec_)

1. In Stripe dashboard → Webhooks → your endpoint → **Roll signing secret**
2. Stripe gives a grace period where both old and new secrets are valid (typically 72h)
3. Update `STRIPE_WEBHOOK_SECRET` in your host's secret store
4. Redeploy backend
5. Verify with a test event from the Stripe dashboard

### 8.2 Rotate the API key (sk_live_)

1. Create a new restricted key in Stripe dashboard
2. Update `STRIPE_SECRET_KEY` in your host's secret store
3. Redeploy backend
4. Delete the old key from the Stripe dashboard
5. Run smoke transaction to confirm (§5)

---

## Section 9 — Connect Mode (Phase 1 — Extended in 9C2)

The codebase is Connect-ready but not Connect-activated. The single-seam design:

- `getStripeForOrg(org)` → returns `{ stripe: platformStripe, stripeAccount: org.stripe_account_id ?? undefined }`
- `Organization.stripe_account_id` field exists (null = platform-managed, current state)
- `resolveOrgFromEvent(event)` reads `event.account` for Connect-originated events

When 9C2 ships:
1. Run Connect Standard onboarding for each org → saves `stripe_account_id` to org
2. No webhook handler changes needed — the event.account routing is already in place
3. `createRefund` / `createCheckoutSession` pass `stripeAccount` option automatically

Until 9C2: all calls go through the platform account. No customer action required.

---

## Section 10 — Common Failure Modes (FAQ)

| Symptom | Root cause | Fix |
|---|---|---|
| Webhook returns 400 "Invalid webhook signature" | `STRIPE_WEBHOOK_SECRET` mismatch or whitespace | Compare value to Stripe dashboard → Reveal. Check for trailing space/newline. |
| Deposit stays REQUESTED after checkout | Webhook not reaching backend | Check Stripe dashboard webhook delivery. Check backend logs. |
| `stripe listen` shows 400s | `STRIPE_WEBHOOK_SECRET` in .env is stale (rotated on `stripe listen` restart) | Copy new `whsec_` from CLI output → update `.env` → restart backend |
| Preflight: `STRIPE_SECRET_KEY must start with sk_test_` | Live key in dev env | Use test key for local dev only |
| Preflight: `Stripe API version drift` | SDK updated, `STRIPE_API_VERSION` constant in `lib/stripe.ts` not updated | Update the constant to match `Stripe.LatestApiVersion` — run tests to confirm no breaking changes |
| Refund returns 400 "No stripe_payment_intent_id" | Invoice was paid via CASH/CHECK (no Stripe PI) | Expected — refund button only shows for CARD payments |
| Refund returns 400 "multiple CARD payments" | Invoice has >1 CARD payment record | Manual intervention needed — refund via Stripe dashboard directly |
| `charge.refunded` does nothing | Webhook event's `payment_intent` not found in DB | Payment may belong to a different environment (test PI in production or vice versa) |

## Section 11 — Bank (ACH) refund rules: sandbox outcome (payments go-live slice 29, D17)

Measured on the ServWave sandbox on 2026-10-08 (platform account, test keys, `2025-02-24.acacia`):

| Check | Result | What ServWave ships |
|---|---|---|
| Partial refund of a cleared ACH payment | **Accepted.** `refunds.create({ payment_intent, amount })` on a succeeded `us_bank_account` PaymentIntent returned `pending`, then `succeeded` (probe refund `pyr_1UOHS7FpxRiHraun5qqhWiCX`, $25 of $100; verification flow refund `pyr_1UOJL5FpxRiHraun7tSx2zpr`, $50 of $200). | Partial bank refunds stay on (D17). The full-only fallback is **not** needed. |
| Cancel an ACH PaymentIntent in `processing` | **Accepted.** `paymentIntents.cancel` on a processing debit (`pi_3UOHReFpxRiHraun0QedsIBa`) returned `canceled`. | A processing bank payment shows **Cancel payment** (POST `/api/invoices/:id/cancel-bank-payment`), never Refund. If the processor refuses (`payment_intent_unexpected_state`), the user is told it can be refunded once it clears. |

Rules enforced server-side (`backend/src/lib/refund-rules.ts`), with the copy users see:

- Past 180 days from the bank payment, the refund is refused before the processor is asked.
- A refund the payout balance cannot cover (`balance_insufficient` / `insufficient_funds`) is answered with the ServWave Payments balance message; nothing is recorded.
- A bank refund is PENDING until the processor confirms it (`refund.updated` → SUCCEEDED); only then does it count as refunded.
- The refund dialog warns that a customer who also disputes with their bank within 60 days could be credited twice.

Re-run: `npm run verify:stripe -- --only=flow-H-partial-ach-refund --verbose` (the backend under test running, `VERIFY_STRIPE_API_URL` and `DATABASE_URL` pointing at it and its database). Before going live, Ran repeats the partial bank refund on a live connected account (slice 40).
