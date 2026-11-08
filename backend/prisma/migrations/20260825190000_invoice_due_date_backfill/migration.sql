-- Backfill `invoices.due_date` on outstanding invoices that were imported without one -- 2026-08-25.
--
-- THE DEFECT.
--
-- `loadCustomerFinancials()` splits a customer's open balance into two buckets on one predicate:
--
--     past_due_balance : status IN ('SENT','PARTIAL') AND due_date <  NOW()
--     due_balance      : status IN ('SENT','PARTIAL') AND (due_date IS NULL OR due_date >= NOW())
--
-- A NULL `due_date` therefore does not merely fail to age -- it is actively swept into the
-- NOT-yet-due bucket, and stays there for ever. Every tenant-A customer with an open invoice
-- reads "Past Due: None / Due: <balance>" no matter how old the debt is; the oldest affected
-- invoice was sent 2025-04-30, sixteen months ago. Measured on production before this file ran:
--
--     org                     open (SENT/PARTIAL)   NULL due_date   counted past due   balance
--     tenant A (11111111-...)                 190             190                  0   $688,681.73
--     tenant B                                  8               1                  0   $112,440.21
--     tenant C                                 70               0                 70    $96,580.80
--
-- Tenant C is the control: identical code, populated column, correct answer. So this is a
-- data hole, not a logic bug -- the 2026-08-05 tenant-A import (35,341 rows) carried
-- `sent_at` faithfully and never wrote `due_date`. Nothing the application has created since the
-- cutover is affected, because every send path resolves the date through `calculateDueDate()`
-- and persists it; a query for open non-DEPOSIT invoices created after 2026-08-06 returns zero
-- rows. This file closes the historical gap; it is not papering over a live writer.
--
-- The same NULL lands in `dashboard.controller.ts`, whose AR-aging loop opens with
-- `if (!inv.due_date) { arCurrent += amt; }` -- so the whole $688,681.73 is reported as
-- "Current" on the dashboard today.
--
-- WHERE THE FORMULA COMES FROM -- IT IS NOT INVENTED HERE.
--
-- `daysLateFor()` in backend/src/services/ar-aging-report.ts ALREADY ages these rows, using
-- exactly this derivation:
--
--     const anchor = row.dueDate ?? row.sentAt ?? row.createdAt;
--     if (!row.dueDate) due.setDate(due.getDate() + NET_TERMS_DAYS);   // NET_TERMS_DAYS = 30
--
-- So the AR Aging report and the dashboard KPI disagree with each other right now, on the same
-- invoices, because one has the fallback and the other does not. Rather than add the fallback to
-- a second reader (and then a third), this promotes the shipped, unit-tested convention into the
-- column itself, where every reader gets it for free and none can drift again.
--
-- Two consequences worth stating plainly, because they are how you check this file worked:
--   * the AR Aging report is INVARIANT across this migration -- it already computed these dates,
--     it now merely reads them. If its account list or DSO moves, this file is wrong.
--   * the dashboard AR KPI and the customer Past Due tile DO move, by design. After this runs the
--     three surfaces agree for the first time.
--
-- The CASE below reproduces `calculateDueDate()` (invoice.controller.ts) branch for branch so the
-- backfilled rows are indistinguishable from rows the live send path writes. Note that
-- `customers.payment_type` is NULL for all 12,507 production customers, so every row resolves
-- through the ELSE arm to NET 30 today -- identical to both `calculateDueDate()`'s own default
-- and the report's NET_TERMS_DAYS. The other arms are written out anyway: the column is
-- user-facing and will eventually be populated, and a derivation that silently disagrees with the
-- live helper is the exact failure this file exists to end.
--
-- SCOPE, AND WHAT IS DELIBERATELY LEFT NULL.
--
-- Only OUTSTANDING invoices -- `AR_OUTSTANDING_STATUSES` from backend/src/lib/ar.ts, which is the
-- widest set any reader treats as open. Kinds are NOT filtered: AR excludes DEPOSIT as a matter of
-- its own policy, but the invoice-list `overdue` facet (invoice.controller.ts) does not, and a
-- deposit that was sent and never paid is genuinely late. Excluding it here would leave the same
-- "sent, but undated" anomaly alive in a smaller population.
--
--   * DRAFT is excluded. A draft has legitimately not been issued, so it has no due date to know;
--     the send path stamps one at the moment it acquires meaning. Writing one now would invent an
--     obligation the customer has never been told about.
--   * PAID / VOIDED / REFUNDED are excluded. Nothing reads their `due_date`, and a date
--     manufactured for a settled invoice can only ever mislead a later "was this paid late?"
--     question with a number no one actually quoted.
--
-- SAFETY.
--
-- One UPDATE, guarded `due_date IS NULL`. That guard makes the file idempotent AND makes it
-- incapable of overwriting a value a human or a live writer has already set -- an explicitly
-- chosen due date is better evidence than anything derivable here, and always wins.
--
-- Verified on the production snapshot before writing: of the 194 candidate rows, 0 have a NULL
-- customer_id, 0 fail to join a customer, 0 join a customer in a different org, and 0 lack both
-- `sent_at` and `created_at` -- so the payment-type lookup below cannot silently skip a row.
-- `customer_id` is NOT NULL and FK-constrained, so that is a property of the schema, not luck.
--
-- WHY A MIGRATION AND NOT A ONE-OFF SCRIPT: a local script in this repo reads backend/.env, which
-- points at STAGING, and will report success having written to the wrong database. A migration
-- runs wherever `prisma migrate deploy` runs, exactly once per database, and is rehearsed against
-- CI's vanilla Postgres and staging before it ever reaches production.

UPDATE "invoices" i
SET "due_date" = (
      CASE COALESCE(
             (SELECT c."payment_type" FROM "customers" c WHERE c."id" = i."customer_id"),
             'NET 30'
           )
        -- Due on receipt: the issue instant itself, exactly as calculateDueDate('COD') returns it.
        WHEN 'COD'    THEN COALESCE(i."sent_at", i."created_at")
        WHEN 'NET 15' THEN COALESCE(i."sent_at", i."created_at") + INTERVAL '15 days'
        WHEN 'NET 60' THEN COALESCE(i."sent_at", i."created_at") + INTERVAL '60 days'
        -- End of month: the last day of the ANCHOR's month, matching
        -- `new Date(d.getFullYear(), d.getMonth() + 1, 0)`.
        WHEN 'EOM'    THEN date_trunc('month', COALESCE(i."sent_at", i."created_at"))
                             + INTERVAL '1 month' - INTERVAL '1 day'
        -- NET 30 both explicitly and as the fallback for an unrecognised or absent term,
        -- mirroring calculateDueDate()'s `default:` arm.
        ELSE               COALESCE(i."sent_at", i."created_at") + INTERVAL '30 days'
      END
      -- `sent_at`/`created_at` are Prisma `timestamp(3)` holding UTC; `due_date` is `timestamptz`.
      -- The conversion is stated rather than inherited from the session's TimeZone, which a
      -- migration must never depend on. (Production is UTC, so this is a no-op there -- and that
      -- is precisely why it must be written down, before some other database is not.)
    ) AT TIME ZONE 'UTC'
WHERE i."due_date" IS NULL
  AND i."voided_at" IS NULL
  -- AR_OUTSTANDING_STATUSES (backend/src/lib/ar.ts). PARTIALLY_REFUNDED and DISPUTED are in the
  -- set because the AR readers treat them as open, even though the customer KPI's narrower
  -- SENT/PARTIAL pair is what surfaced the bug.
  AND i."status" IN ('SENT', 'PARTIAL', 'PARTIALLY_REFUNDED', 'DISPUTED')
  -- The anchor. Prefer `sent_at`: it is the instant the obligation was communicated, and it is
  -- what the live path uses (`calculateDueDate(payment_type, new Date())` AT SEND). `created_at`
  -- is the documented fallback for never-sent rows -- see the DSO note in getArAging() -- and is
  -- second choice on purpose, because the Workiz importer backdates it.
  AND COALESCE(i."sent_at", i."created_at") IS NOT NULL;
