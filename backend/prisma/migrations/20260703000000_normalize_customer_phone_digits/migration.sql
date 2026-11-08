-- #352 — One-time backfill: normalize customer phones to the digits-only canonical form.
--
-- From this migration on, the API stores customer phones as digits-only (a single
-- leading US '1' stripped from an 11-digit value). This backfill brings the existing
-- rows in line so display formatting and search behave uniformly.
--
-- Rules (all three UPDATEs):
--   * PORTABLE vanilla Postgres (CI migration-check runs on postgres:16) — no
--     Supabase-only objects.
--   * IDEMPOTENT — each WHERE only matches non-canonical rows, so a second run
--     touches 0 rows.
--   * SENTINEL CARVE-OUT — Lakeside-import placeholder phones ('bg-import-phone:%' and
--     '(000) 000-0000') are deliberately left byte-for-byte unchanged so the
--     frontend's isPlaceholderPhone() keeps hiding them (they must never become
--     real-looking dialable digits).
--
-- customers.phone / customers.secondary_phone (both NULLABLE since
-- 20260626000000_customer_phone_nullable) are additionally normalized to the new
-- Zod invariant NULL-or-7-to-20-digits: digit-less junk ('N/A'), sub-7-digit
-- normalizations ('(55) 5-5' → '555') and pre-existing short all-digit values
-- ('12345') all become NULL, so no legacy value can 400 a PATCH round-trip.
-- customer_phones.phone is NOT NULL, so it is normalize-only: digit-less values
-- are left untouched rather than violating NOT NULL (the display formatters pass
-- them through unchanged).

-- customers.phone
UPDATE customers
SET phone = CASE
  WHEN length(
    CASE WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^1[0-9]{10}$'
         THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') from 2)
         ELSE regexp_replace(phone, '[^0-9]', '', 'g')
    END
  ) BETWEEN 7 AND 20
  THEN CASE WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^1[0-9]{10}$'
            THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') from 2)
            ELSE regexp_replace(phone, '[^0-9]', '', 'g')
       END
  ELSE NULL
END
WHERE phone IS NOT NULL
  AND (phone !~ '^[0-9]{7,20}$' OR phone ~ '^1[0-9]{10}$')
  AND phone NOT LIKE 'bg-import-phone:%'
  AND phone <> '(000) 000-0000';

-- customers.secondary_phone
UPDATE customers
SET secondary_phone = CASE
  WHEN length(
    CASE WHEN regexp_replace(secondary_phone, '[^0-9]', '', 'g') ~ '^1[0-9]{10}$'
         THEN substring(regexp_replace(secondary_phone, '[^0-9]', '', 'g') from 2)
         ELSE regexp_replace(secondary_phone, '[^0-9]', '', 'g')
    END
  ) BETWEEN 7 AND 20
  THEN CASE WHEN regexp_replace(secondary_phone, '[^0-9]', '', 'g') ~ '^1[0-9]{10}$'
            THEN substring(regexp_replace(secondary_phone, '[^0-9]', '', 'g') from 2)
            ELSE regexp_replace(secondary_phone, '[^0-9]', '', 'g')
       END
  ELSE NULL
END
WHERE secondary_phone IS NOT NULL
  AND (secondary_phone !~ '^[0-9]{7,20}$' OR secondary_phone ~ '^1[0-9]{10}$')
  AND secondary_phone NOT LIKE 'bg-import-phone:%'
  AND secondary_phone <> '(000) 000-0000';

-- customer_phones.phone (NOT NULL — normalize-only, digit-less junk left untouched)
UPDATE customer_phones
SET phone = CASE
  WHEN regexp_replace(phone, '[^0-9]', '', 'g') ~ '^1[0-9]{10}$'
  THEN substring(regexp_replace(phone, '[^0-9]', '', 'g') from 2)
  ELSE regexp_replace(phone, '[^0-9]', '', 'g')
END
WHERE (phone ~ '[^0-9]' OR phone ~ '^1[0-9]{10}$')
  AND regexp_replace(phone, '[^0-9]', '', 'g') <> ''
  AND phone NOT LIKE 'bg-import-phone:%'
  AND phone <> '(000) 000-0000';
