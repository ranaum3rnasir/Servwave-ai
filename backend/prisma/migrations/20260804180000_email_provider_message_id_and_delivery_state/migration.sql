-- Capture the Resend provider message id on emails, plus the delivery-state
-- columns the webhook slice will fill.
--
-- WHY. dispatchEmail (backend/src/lib/email.ts) threw away the id Resend returns
-- for every accepted message. That id is the ONLY correlation key a Resend
-- delivery webhook carries, so without storing it no delivery, bounce or
-- complaint event could ever be matched back to the row it belongs to. This
-- migration adds the column, plus the state the webhook handler will write into.
--
-- NULLABLE, NOT DEFAULTED. delivery_status is deliberately left nullable with no
-- default. Null means "nothing has ever reported on this row", which is the
-- truth for every row that predates the column - all of them, since the sending
-- code has never had an id to record. Defaulting them to QUEUED would assert
-- tracking that never happened, and would be flatly wrong for inbound rows.
-- Nullable also keeps this an instant catalog-only ALTER with no table rewrite.
--
-- INDEXES. provider_message_id is UNIQUE, which creates the index the webhook
-- handler looks rows up by, so no separate index is added. Unique also makes a
-- replayed webhook update one row rather than fan out across duplicates.
--
-- bounce_kind is DERIVED, not provider-verbatim: Resend reports bounce.type as
-- Permanent/Temporary and has no hard/soft field: we map it. It ships in this
-- migration rather than a later one so acting on a bounce needs no second DDL.
--
-- IDEMPOTENT: the enum creations are wrapped in DO $$ blocks that swallow
--   duplicate_object (matching 20260613130000_org_deposit_default), and every
--   column and index statement is IF NOT EXISTS-guarded, so a second application
--   against the shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - CREATE TYPE, ALTER TABLE
--   ADD COLUMN IF NOT EXISTS and CREATE UNIQUE INDEX IF NOT EXISTS are all core
--   Postgres. No Supabase-only objects, and no role grants to guard: the new
--   columns inherit the existing table's RLS policies and grants.

-- ─── Enums ───────────────────────────────────────────────────────────────────
-- Delivery lifecycle as OURS, mapped from provider events, so a provider adding
-- an event type cannot silently widen what the UI has to render:
--   QUEUED -> SENT -> [DEFERRED] -> DELIVERED | BOUNCED | FAILED
-- with COMPLAINED the one post-delivery terminal.
DO $$ BEGIN
  CREATE TYPE "EmailDeliveryStatus" AS ENUM (
    'QUEUED', 'SENT', 'DEFERRED', 'DELIVERED', 'BOUNCED', 'FAILED', 'COMPLAINED'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Whether a bounce is worth retrying: Permanent -> HARD, Temporary -> SOFT.
DO $$ BEGIN
  CREATE TYPE "EmailBounceKind" AS ENUM ('HARD', 'SOFT');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── emails columns ──────────────────────────────────────────────────────────
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "provider_message_id" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "delivery_status" "EmailDeliveryStatus";
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "delivery_status_reason" TEXT;
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "delivery_status_at" TIMESTAMP(3);
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "bounce_kind" "EmailBounceKind";

-- ─── Webhook correlation key ─────────────────────────────────────────────────
-- Nulls do not collide in a Postgres unique index, so every legacy row (all of
-- which are null here) coexists under this constraint without a backfill.
CREATE UNIQUE INDEX IF NOT EXISTS "emails_provider_message_id_key"
  ON "emails" ("provider_message_id");
