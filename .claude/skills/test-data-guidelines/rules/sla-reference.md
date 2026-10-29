# SLA & Timing Constraints Reference

Authoritative inventory of all business-level timing rules in the ALPHA CRM codebase. Test data **must** respect these constraints — any fixture that violates them represents an impossible state.

> **Source of truth:** This file documents what the code enforces. If the code changes, update this file. If a value is configurable (AppSetting or env var), the default is listed here but tests should not assume it is immutable.

---

## 1. Estimate Lifecycle Timing

| Constraint | Value | Configurable | Source |
|-----------|-------|-------------|--------|
| Validity period after first send | **30 days** | Yes — AppSetting `estimate_validity_days` | `estimate.controller.ts:795` |
| Expiration cron schedule | Daily at **5 AM UTC** (midnight EST) | No | `index.ts:12` |
| Expiration targets | SENT or PENDING with `valid_until < now` | No | `estimate-expiration.ts:13` |
| Expired estimate status | CANCELLED with reason "Estimate expired" | No | `estimate-expiration.ts:22` |
| Deposit auto-void on expiry | REQUESTED deposits → VOIDED | No | `estimate-expiration.ts:38` |

**Test data implications:**
- `valid_until` must equal `sent_at + estimate_validity_days` (default 30)
- An EXPIRED/CANCELLED-by-cron estimate must have `valid_until < now` at the time of expiration
- PAID deposits are NOT voided on expiry — only REQUESTED ones
- Lead reverts to ESTIMATED only if no other active estimates remain (and lead is not WON/LOST/CANCELLED)

---

## 2. Deposit & Payment Configuration

| Constraint | Value | Configurable | Source |
|-----------|-------|-------------|--------|
| Default deposit percentage | **50%** | Yes — AppSetting `deposit_percentage` | `seed.ts:55` |
| Deposit required by default | **true** | Yes — AppSetting `deposit_required_default` | `seed.ts:54` |
| Credit card surcharge rate | **3.5%** | Yes — env `CREDIT_CARD_SURCHARGE_RATE` | `env.ts:25` |
| Accepted payment methods | CARD, BANK_TRANSFER, CHECK, CASH | Yes — AppSetting `available_payment_methods` | `seed.ts:56` |

**Test data implications:**
- Deposit amount = `estimate.total_amount × (deposit_percentage / 100)`
- When testing surcharges, Stripe checkout total = base + (base × 0.035)
- Payment method in deposit/payment records must be one of the accepted methods

---

## 3. Invoice Due Date Calculation

| Customer payment_type | Due Date Calculation | Source |
|----------------------|---------------------|--------|
| `null` / `COD` | Same day as `sent_at` | `invoice.controller.ts:64` |
| `NET 15` | `sent_at + 15 days` | `invoice.controller.ts:65` |
| `NET 30` | `sent_at + 30 days` (default fallback) | `invoice.controller.ts:66` |
| `NET 60` | `sent_at + 60 days` | `invoice.controller.ts:67` |
| `EOM` | Last day of the month containing `sent_at` | `invoice.controller.ts:69` |

**Test data implications:**
- `due_date` must match the calculation based on customer's `payment_type`
- Residential customers (no `payment_type`) → COD → due same day
- Commercial customers with `allow_billing: true` typically have NET 15/30/60
- An invoice is **overdue** when `due_date < now` AND status is SENT or PARTIAL
- No grace period — overdue is immediate once the date passes

---

## 4. Walkthrough Duration Constraints

| Constraint | Value | Source |
|-----------|-------|--------|
| Minimum duration | **15 minutes** | `lead.controller.ts:175` |
| Maximum duration | **480 minutes** (8 hours) | `lead.controller.ts:175` |
| Default duration (when not specified) | **60 minutes** | `lead.controller.ts:190` |

**Test data implications:**
- `walkthrough_duration_minutes` must be between 15 and 480 (inclusive)
- If omitted, code defaults to 60 minutes — test data should match
- Conflict detection uses this duration to calculate the walkthrough's time window

---

## 5. Job Scheduling Constraints

| Constraint | Value | Source |
|-----------|-------|--------|
| All-day job duration | **24 hours** (1440 minutes) | `job.controller.ts:592` |
| Default job duration (frontend DnD) | **2 hours** | `SchedulePage.tsx:1932` |
| Calendar display hours | **6 AM – 8 PM** | `TechnicianGridView.tsx:47` |
| Conflict detection | Overlapping SCHEDULED/IN_PROGRESS jobs + walkthroughs | `job.controller.ts:642` |
| Conflict bypass | `force: true` parameter | `job.controller.ts` |

**Test data implications:**
- `scheduled_start < scheduled_end` always
- `is_all_day: true` jobs span exactly 24 hours
- Realistic scheduling: standard residential 2-4h, commercial 4-8h, urgent 1-3h
- Two jobs for the same technician must NOT overlap unless `force` was used
- Jobs should fall within 6 AM – 8 PM for realistic display (though the system allows outside)

---

## 6. Stripe Checkout Timing

| Constraint | Value | Source |
|-----------|-------|--------|
| Checkout session expiry | **24 hours** (Stripe default, not overridden) | `stripe.ts` |
| Webhook idempotency | Infinite (stored in DB, no TTL) | `webhook.controller.ts:43` |
| Webhook processing | Immediate — no retry delay | `webhook.controller.ts:91` |

**Test data implications:**
- `stripe_checkout_session_id` values use prefix `cs_test_`
- `stripe_payment_intent_id` values use prefix `pi_test_`
- `stripe_refund_id` values use prefix `re_test_`
- Stripe payment timestamps should be within 24h of checkout session creation
- StripeEvent records are permanent — test cleanup must account for this

---

## 7. Rate Limits (Infrastructure — Affects E2E Tests)

| Limiter | Window | Prod Max | Dev Max | Test |
|---------|--------|----------|---------|------|
| API general | 15 min | 100 | 2000 | Unlimited |
| Auth (failures only) | 15 min | 5 | 50 | Unlimited |
| Public read | 15 min | 20 | 500 | Unlimited |
| Public action | 15 min | 5 | 200 | Unlimited |

**Test data implications:**
- Unit tests (vitest): rate limits are mocked, no concern
- E2E tests: run against dev server (high limits), but avoid hammering public endpoints
- If E2E tests hit rate limits, increase dev limits or add delays between public actions

---

## 8. Auth & Token Timing (Infrastructure)

| Constraint | Value | Source |
|-----------|-------|--------|
| Token cache TTL | 60 seconds | `authenticate.ts:17` |
| Cache eviction interval | 5 minutes | `authenticate.ts:18` |
| React Query staleTime | 5 minutes (global default) | `App.tsx:36` |
| Reference data staleTime | Infinity (technicians, sales users) | `SchedulePage.tsx:836` |

**Test data implications:**
- Backend unit tests mock auth entirely — no timing concern
- E2E tests: if testing token refresh, wait > 60s for cache expiry
- E2E tests: if testing stale data scenarios, wait > 5min or invalidate queries manually
