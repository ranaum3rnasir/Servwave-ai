-- Email slice 4 (Resend delivery webhooks): the idempotency ledger for
-- inbound Resend webhook events, plus a global TRANSACTIONAL send-suppression
-- list a hard bounce/complaint writes into and dispatchEmail (lib/email.ts)
-- reads before every business send.
--
-- IDEMPOTENT: CREATE TABLE/INDEX IF NOT EXISTS; safe to re-run against the
--   shared staging DB.
-- PORTABLE: vanilla postgres:16 — no Supabase-specific objects; the only
--   Supabase-role touches are the anon/authenticated REVOKEs, guarded behind
--   pg_roles existence checks (CI's plain Postgres has neither role).
--
-- RLS — DELIBERATELY NONE ON EITHER TABLE, and this is a design decision, not
-- an oversight:
--   - resend_events has no organization_id at all (mirrors ctm_events /
--     stripe_events — a global webhook ledger; the owning org is resolved
--     per event via emails.provider_message_id, not a tenant scope).
--   - email_suppressions DOES carry an organization_id column, but it is
--     audit-only. The suppression block is intentionally GLOBAL by address
--     (the shared mail.servwave.com sending domain means a hard-bounced
--     mailbox is broken for every org, not just the one that triggered it).
--     A standard tenant_isolation policy (organization_id = current_org_id)
--     would silently scope the suppression list per-org and defeat the whole
--     point of this table — exactly the state_tax_rates/stripe_events bug
--     fixed by 20260707000100_disable_rls_global_reference_tables (RLS
--     enabled with no matching policy denies ALL rows, even to the app's own
--     connection). Both tables stay unscoped by the pre-existing app-level
--     unscopedRequest middleware already covering /api/webhooks (see
--     backend/src/middleware/unscopedRequest.ts + app.ts), the same mechanism
--     that already covers ctm_events/stripe_events writes.

CREATE TABLE IF NOT EXISTS "resend_events" (
  "id"              UUID NOT NULL,
  "resend_event_id" TEXT NOT NULL,
  "event_type"      TEXT NOT NULL,
  "payload"         JSONB,
  "processed_at"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "resend_events_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "resend_events_resend_event_id_key" ON "resend_events"("resend_event_id");

CREATE TABLE IF NOT EXISTS "email_suppressions" (
  "id"              UUID NOT NULL,
  "address"         TEXT NOT NULL,
  "category"        TEXT NOT NULL DEFAULT 'TRANSACTIONAL',
  "kind"            TEXT NOT NULL,
  "organization_id" UUID,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_address_category_key" ON "email_suppressions"("address","category");

-- No FK to organizations: the column is a nullable audit breadcrumb, not a
-- tenant-ownership relation, and must survive the org that first surfaced the
-- bounce being deleted later.

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from both new
--     tables (ctm_events/email_attachments precedent). pg_roles guards keep
--     this valid on CI's vanilla postgres. ─────────────────────────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.resend_events, public.email_suppressions FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.resend_events, public.email_suppressions FROM authenticated';
  END IF;
END $$;
