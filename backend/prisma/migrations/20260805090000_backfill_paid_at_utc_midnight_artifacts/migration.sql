-- Backfill `paid_at` rows that are date-only artifacts rather than instants.
--
-- `payments.paid_at` and `invoices.paid_at` hold true INSTANTS: all but a handful of
-- rows are written by Stripe webhooks or the server's own `new Date()`. The estimate
-- deposit dialog was the one exception - it posted `new Date('2026-08-04')`, which
-- parses as UTC midnight. Because that is the previous evening in every US timezone,
-- those payments rendered a day early on any local-time surface.
--
-- The write site is fixed (frontend `instantFromLocalDay`). This repairs the rows it
-- already produced: 37 in each table on staging, all recording only a calendar day.
-- They take LOCAL NOON on that day - far enough from both midnights that no DST
-- transition can carry a row onto an adjacent date, and visibly approximate rather
-- than falsely precise, which a start-of-day stamp would look like.
--
-- Idempotent by construction, not by guard: a repaired row reads 16:00/17:00 UTC, so
-- the `= '00:00:00'` predicate no longer selects it. Re-running is a no-op. On a fresh
-- CI database both statements match zero rows.
--
-- Portable: no Supabase-only roles, functions or policies, so vanilla postgres:16 runs
-- it unchanged. `AT TIME ZONE` applies the correct historical DST offset per date.

-- An org whose timezone is NULL, empty, or not a recognised IANA name falls back to
-- America/New_York, matching DEFAULT_TIMEZONE in backend/src/lib/timezone.ts. Without
-- the pg_timezone_names lookup an unrecognised value would abort the whole migration.
UPDATE payments p
SET paid_at = ((p.paid_at::date + TIME '12:00')
                 AT TIME ZONE COALESCE(
                   (SELECT z.name FROM pg_timezone_names z WHERE z.name = o.timezone),
                   'America/New_York'
                 )) AT TIME ZONE 'UTC'
FROM invoices i
JOIN organizations o ON o.id = i.organization_id
WHERE i.id = p.invoice_id
  AND p.paid_at::time = TIME '00:00:00';

-- The same dialog stamps the deposit invoice with the identical value
-- (estimate.controller.ts marks the invoice PAID with the payment's paid_at).
UPDATE invoices inv
SET paid_at = ((inv.paid_at::date + TIME '12:00')
                 AT TIME ZONE COALESCE(
                   (SELECT z.name FROM pg_timezone_names z WHERE z.name = o.timezone),
                   'America/New_York'
                 )) AT TIME ZONE 'UTC'
FROM organizations o
WHERE o.id = inv.organization_id
  AND inv.paid_at IS NOT NULL
  AND inv.paid_at::time = TIME '00:00:00';
