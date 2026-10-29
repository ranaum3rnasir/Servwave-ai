-- Unified client creation (md_files/plans/customers/2026-07-14-unified-client-creation.md §5.6)
-- Re-derive `kind` on ALL existing customers using the SIMPLE rule now used by
-- deriveCustomerKind() at create/update time: company_name present (non-blank) → COMPANY,
-- else PERSON. This supersedes the original redesign backfill (20260604050000, which also
-- required first_name to be blank before calling a row COMPANY) — kind is now a pure
-- function of company_name alone. Portable (no Supabase-only objects) + idempotent (the
-- WHERE guard makes a re-run a no-op; safe to apply twice).
UPDATE customers
SET kind = CASE
             WHEN company_name IS NOT NULL AND TRIM(company_name) <> '' THEN 'COMPANY'::"CustomerKind"
             ELSE 'PERSON'::"CustomerKind"
           END
WHERE kind IS DISTINCT FROM (
  CASE
    WHEN company_name IS NOT NULL AND TRIM(company_name) <> '' THEN 'COMPANY'::"CustomerKind"
    ELSE 'PERSON'::"CustomerKind"
  END
);
