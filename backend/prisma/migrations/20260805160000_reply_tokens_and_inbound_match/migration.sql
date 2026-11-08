-- Email slice 6 (inbound reply capture) - the reply-token table that turns
-- `<token>@reply.servwave.com` back into a thread, plus the two columns on
-- `emails` that record how a RECEIVED message resolved against our records.
--
-- WHY A LOOKUP KEY, NOT A SIGNED TOKEN. An earlier draft specified an
-- HMAC-signed token carrying org/entity/customer/issued-at inline. RFC 5321
-- 4.5.3.1.1 caps an email local part at 64 OCTETS, and three UUIDs alone are 48
-- raw bytes = 64 base64url characters before any MAC, prefix or separator - so
-- a self-contained payload does not fit. Given that, a MAC buys nothing either:
-- a MAC makes a SELF-DESCRIBING payload tamper-evident, and we are already
-- hitting the database to resolve the thread. 128 bits from a CSPRNG is 22
-- base64url characters and unguessable by construction, which is the only
-- property actually required. The token IS the primary key - no separate id,
-- because every lookup is by token and a second key could only ever disagree.
--
-- NO PII IN THE ADDRESS. Reply addresses are logged by every intermediate MTA,
-- echoed in DSNs and bounce bodies, and stored in the recipient's mail client.
-- An opaque key leaks nothing; a name-derived slug or encoded customer id leaks
-- on every hop.
--
-- expires_at IS NULLABLE AND NOTHING SETS IT. Settled 2026-08-05: reply tokens
-- never expire, consistent with the standing decision that access does not
-- expire when a job closes. The column exists only so a per-token expiry can be
-- imposed later without invalidating addresses already sitting in customers'
-- mailboxes. Revocation is `revoked_at`, not a clock.
--
-- NO UNIQUE CONSTRAINT on (thread_id, expected_from), deliberately. Postgres
-- treats NULLs as DISTINCT in a unique index, and thread_id/entity_id/
-- customer_id are all nullable here, so such a constraint would silently fail
-- to constrain exactly the rows it appears to cover. Reuse is enforced in the
-- minting helper instead; the race it leaves open is benign, since two tokens
-- for the same (thread, recipient) both resolve to the same thread.
--
-- IDEMPOTENT: enum creation swallows duplicate_object (matching
--   20260804180000_email_provider_message_id_and_delivery_state); every table,
--   column and index statement is IF NOT EXISTS-guarded; every FK sits behind a
--   pg_constraint existence check; DROP POLICY IF EXISTS precedes CREATE POLICY.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - the only Supabase-role
--   touches are the anon/authenticated REVOKEs, guarded behind pg_roles checks.

-- ─── Enum ────────────────────────────────────────────────────────────────────
-- How an inbound message resolved. Two of the three states are NOT derivable
-- from the anchors alone, which is why this is stored rather than re-computed:
-- UNMATCHED_SENDER means the token DID resolve a thread and we deliberately
-- refused to attach it because the From address was not the one we sent to.
-- Without the column that is indistinguishable from UNMATCHED_NO_TOKEN.
DO $$ BEGIN
  CREATE TYPE "InboundMatchState" AS ENUM (
    'MATCHED', 'UNMATCHED_NO_TOKEN', 'UNMATCHED_SENDER'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- The DMARC verdict on an inbound message's From header, parsed from the
-- `Authentication-Results` header. Confirmed 2026-08-05 that Resend's inbound
-- (Amazon SES) does stamp that header; the plan had branched on whether it
-- would exist at all.
--
-- SEPARATE FROM InboundMatchState ON PURPOSE. That column says whether we
-- attached the message to a thread; this says what the From address was worth.
-- "Address matched, DMARC passed" and "address matched, DMARC unavailable" are
-- both MATCHED, and collapsing them would render a cryptographically verified
-- sender identically to an unverified string compare.
--
-- NO_POLICY is the sender's domain publishing no DMARC record; UNAVAILABLE is
-- us having no usable verdict (header absent, no dmarc= token, or
-- temperror/permerror). A transient DNS failure tells us exactly as much as a
-- missing header, so it does not get a stronger state.
DO $$ BEGIN
  CREATE TYPE "InboundAuthVerdict" AS ENUM (
    'PASS', 'FAIL', 'NO_POLICY', 'UNAVAILABLE'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── reply_tokens ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "reply_tokens" (
  "token"              TEXT NOT NULL,
  "organization_id"    UUID NOT NULL,
  "thread_id"          UUID,
  "entity_type"        TEXT,
  "entity_id"          UUID,
  "customer_id"        UUID,
  "expected_from"      TEXT NOT NULL,
  "created_by_user_id" UUID,
  "expires_at"         TIMESTAMP(3),
  "revoked_at"         TIMESTAMP(3),
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "reply_tokens_pkey" PRIMARY KEY ("token")
);

CREATE INDEX IF NOT EXISTS "reply_tokens_organization_id_idx" ON "reply_tokens"("organization_id");
CREATE INDEX IF NOT EXISTS "reply_tokens_thread_id_idx" ON "reply_tokens"("thread_id");
-- The minting helper's reuse lookup: "does this org already have a live token
-- for this entity?" - see the NO UNIQUE CONSTRAINT note above.
CREATE INDEX IF NOT EXISTS "reply_tokens_organization_id_entity_type_entity_id_idx"
  ON "reply_tokens"("organization_id", "entity_type", "entity_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reply_tokens_organization_id_fkey') THEN
    ALTER TABLE "reply_tokens" ADD CONSTRAINT "reply_tokens_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
  -- ON DELETE SET NULL: deleting a thread must not delete the token, or a reply
  -- already in flight would hard-bounce at the customer instead of landing in
  -- the unmatched queue.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'reply_tokens_thread_id_fkey') THEN
    ALTER TABLE "reply_tokens" ADD CONSTRAINT "reply_tokens_thread_id_fkey"
      FOREIGN KEY ("thread_id") REFERENCES "email_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── emails columns ──────────────────────────────────────────────────────────
-- Both NULL on every outbound row - these describe inbound only. Nullable with
-- no default keeps this an instant catalog-only ALTER with no table rewrite.
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "inbound_match" "InboundMatchState";
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "reply_token" TEXT;
-- Not indexed: nothing filters on the verdict alone. It is read alongside a row
-- already located by thread, by id, or by the unmatched-queue index below.
ALTER TABLE "emails" ADD COLUMN IF NOT EXISTS "inbound_auth" "InboundAuthVerdict";

-- The unmatched queue's only query - "inbound mail in this org that did not
-- resolve" - filters on exactly this pair.
CREATE INDEX IF NOT EXISTS "emails_organization_id_inbound_match_idx"
  ON "emails"("organization_id", "inbound_match");
CREATE INDEX IF NOT EXISTS "emails_reply_token_idx" ON "emails"("reply_token");

DO $$ BEGIN
  -- ON DELETE SET NULL, not CASCADE: revoking or pruning a token must never
  -- delete the customer's actual message.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'emails_reply_token_fkey') THEN
    ALTER TABLE "emails" ADD CONSTRAINT "emails_reply_token_fkey"
      FOREIGN KEY ("reply_token") REFERENCES "reply_tokens"("token") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern; fail-closed;
--     INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────────────────
ALTER TABLE "reply_tokens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "reply_tokens" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "reply_tokens";
CREATE POLICY "tenant_isolation" ON "reply_tokens"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from the new table
--     (organization_domains/email_threads precedent). The token column IS the
--     secret, so an anon SELECT here would hand out every org's reply
--     addresses. pg_roles guards keep this valid on CI's vanilla postgres. ───
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.reply_tokens FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.reply_tokens FROM authenticated';
  END IF;
END $$;
