-- Calendar Entries (Slice 02, spec §2/§4/§7/§8; user-facing "Events"): the CalendarEntry and
-- CalendarEntryParticipant tables, plus the tenant_isolation RLS backstop on BOTH in this same
-- migration - rls-coverage.test.ts is a ratchet over every table carrying organization_id and
-- would otherwise redden CI the moment these tables exist without it (issue #1276's failure
-- mode: automation_rules/automation_runs/job_line_items/org_tax_rates all reached prod with
-- relrowsecurity=false because their tables and their RLS policy shipped in different PRs).
--
-- rrule/recurrence_until ship NULL-only and are never read - see the schema.prisma header
-- comment on CalendarEntry. No FK from calendar_entry_participants.user_id/customer_id: the
-- controller enforces org membership at write time (org-validated FK guard), matching
-- notification_recipients.recipient_id, which also carries no FK.
--
-- Idempotent (IF NOT EXISTS / DROP POLICY IF EXISTS / duplicate_object guards throughout) -
-- safe to re-run on the shared staging DB. Portable - the anon/authenticated REVOKE blocks are
-- guarded behind a role-existence check so this also applies cleanly to CI's vanilla
-- postgres:16. NEVER run `prisma migrate` from a worktree; this file is applied by CI, Render
-- deploy, or by hand via the Supabase MCP.

DO $$ BEGIN
  CREATE TYPE "CalendarParticipantKind" AS ENUM ('USER','CUSTOMER');
EXCEPTION WHEN duplicate_object THEN null; END $$;

CREATE TABLE IF NOT EXISTS "calendar_entries" (
  "id"               UUID NOT NULL,
  "organization_id"  UUID NOT NULL,
  "title"            TEXT NOT NULL,
  "description"      TEXT NOT NULL DEFAULT '',
  "start"            TIMESTAMP(3) NOT NULL,
  "end"              TIMESTAMP(3) NOT NULL,
  "is_all_day"       BOOLEAN NOT NULL DEFAULT false,
  "rrule"            TEXT,
  "recurrence_until" TIMESTAMP(3),
  "created_by"       UUID NOT NULL,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  CONSTRAINT "calendar_entries_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "calendar_entry_participants" (
  "id"                UUID NOT NULL,
  "organization_id"   UUID NOT NULL,
  "calendar_entry_id" UUID NOT NULL,
  "kind"              "CalendarParticipantKind" NOT NULL,
  "user_id"           UUID,
  "customer_id"       UUID,
  "notified_at"       TIMESTAMP(3),
  CONSTRAINT "calendar_entry_participants_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "calendar_entries_organization_id_idx"
  ON "calendar_entries"("organization_id");
CREATE INDEX IF NOT EXISTS "calendar_entries_organization_id_start_end_idx"
  ON "calendar_entries"("organization_id","start","end");
CREATE INDEX IF NOT EXISTS "calendar_entry_participants_organization_id_idx"
  ON "calendar_entry_participants"("organization_id");
CREATE INDEX IF NOT EXISTS "calendar_entry_participants_calendar_entry_id_idx"
  ON "calendar_entry_participants"("calendar_entry_id");

-- Entry -> participants is the only FK this migration adds. ON DELETE CASCADE is what makes
-- DELETE /api/calendar-entries/:id a genuine hard delete (spec §7) without the controller
-- having to clean up participant rows by hand.
DO $$ BEGIN
  ALTER TABLE "calendar_entry_participants" ADD CONSTRAINT "calendar_entry_participants_calendar_entry_id_fkey"
    FOREIGN KEY ("calendar_entry_id") REFERENCES "calendar_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- ─── Tenant RLS backstop (20260807140000_custom_field_definitions_rls shape) ───
-- ENABLE + FORCE + the canonical tenant_isolation predicate, on BOTH new tables.

ALTER TABLE "calendar_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_entries" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "calendar_entries";
CREATE POLICY "tenant_isolation" ON "calendar_entries"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "calendar_entry_participants" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "calendar_entry_participants" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "calendar_entry_participants";
CREATE POLICY "tenant_isolation" ON "calendar_entry_participants"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Defense-in-depth, mirroring 20260708140000_revoke_api_roles_on_tenant_tables. Each role is
-- guarded SEPARATELY, not with one combined REVOKE ... FROM anon, authenticated - a single
-- statement naming both fails outright if only one of the two roles exists (vanilla postgres:16
-- has neither). Idempotent: REVOKE of an absent privilege is a no-op.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.calendar_entries FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.calendar_entries FROM authenticated';
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.calendar_entry_participants FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.calendar_entry_participants FROM authenticated';
  END IF;
END $$;
