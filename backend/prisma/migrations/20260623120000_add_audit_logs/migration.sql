-- Idempotent on purpose: the ServWave test-env redeploys against the SHARED
-- staging Supabase DB. NEVER run `prisma migrate` from a worktree (it mutates
-- staging silently). Apply out-of-band via the Supabase SQL editor / MCP:
-- STAGING first, then PROD. Safe to re-run.
--
-- Org-wide security/compliance audit trail. Append-only, no foreign keys (audit
-- rows must outlive deletion of the actor / referenced entity, and we keep the
-- raw actor_id for forensics). Written ONLY by the backend via Prisma over a
-- direct Postgres connection (an RLS-bypassing role) — so there is deliberately
-- no INSERT/UPDATE/DELETE policy. RLS below is defense-in-depth for the (today
-- unused) direct-PostgREST read path.

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id"            UUID        NOT NULL DEFAULT gen_random_uuid(),
  "org_id"        UUID        NOT NULL,
  "actor_id"      UUID,
  "actor_email"   TEXT,
  "action"        TEXT        NOT NULL,
  "resource_type" TEXT,
  "resource_id"   TEXT,
  "metadata"      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  "ip_address"    TEXT,
  "user_agent"    TEXT,
  "created_at"    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_logs_org_id_created_at_idx"
  ON "audit_logs" ("org_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_actor_id_created_at_idx"
  ON "audit_logs" ("actor_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_action_idx"
  ON "audit_logs" ("action");
CREATE INDEX IF NOT EXISTS "audit_logs_resource_type_resource_id_idx"
  ON "audit_logs" ("resource_type", "resource_id");

-- Row-Level Security (defense-in-depth) ------------------------------------------------
-- Org scoping in this app lives on public.users.organization_id, keyed by the
-- Supabase auth uid (auth.uid() == users.id). The backend (Prisma / service role)
-- bypasses RLS, so only the SELECT path needs a policy. Any authenticated Supabase
-- client querying PostgREST directly can read ONLY its own org's audit rows.
--
-- ENABLE works on any Postgres. The SELECT policy, however, references the
-- Supabase-only `authenticated` role + auth.uid(), neither of which exists on a
-- vanilla Postgres (e.g. the migration-check CI shadow DB, which would otherwise
-- 42704 "role authenticated does not exist"). Guard the policy so the table +
-- indexes apply everywhere and the policy is created only where Supabase's auth
-- stack is present. Idempotent — safe to re-run.
ALTER TABLE "audit_logs" ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'DROP POLICY IF EXISTS "audit_logs_select_own_org" ON "audit_logs"';
    EXECUTE 'CREATE POLICY "audit_logs_select_own_org" ON "audit_logs"
      FOR SELECT
      TO authenticated
      USING ("org_id" = (SELECT "organization_id" FROM "public"."users" WHERE "id" = (SELECT auth.uid())))';
  END IF;
END
$$;
