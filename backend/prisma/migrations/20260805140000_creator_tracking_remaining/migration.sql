-- Creator tracking on the remaining five entities (audit only): leads, invoices, customers,
-- payments, attachments.
--
-- WHY. PR 1 (20260805120000_job_created_by) gave `jobs` an answer to "who created this". The same
-- question is just as unanswerable on these five, and Payment is the case that forced the design:
-- "who took this money" has to separate a staff member collecting on site from the customer paying
-- themselves through Stripe. A bare nullable FK cannot say that; created_by_source can.
-- -> md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md (Part A)
--
-- NOTHING READS THESE FOR AUTHORIZATION. This migration and its PR are pure audit: no grant, no
-- CASL condition and no route consults these columns. Reading created_by_id to decide access is a
-- later, separate change.
--
-- SHAPE, identical to PR 1 on every one of the five tables:
--   created_by_source  what kind of actor: USER / CLIENT / SYSTEM / IMPORT / UNKNOWN.
--   created_by_id      the acting user, when there is one.
--   created_by_name    a denormalised snapshot written at creation time. DELETE /api/users/:id/permanent
--                      exists and the FKs below are ON DELETE SET NULL, so without this snapshot a
--                      permanent user delete would erase the audit answer precisely for the departed
--                      employee whose work is most likely to be queried. ON DELETE RESTRICT was the
--                      alternative and was rejected: it makes permanent deletion impossible for
--                      anyone who has ever created any of these rows.
--
-- IDEMPOTENT: the CreatedBySource enum already exists (PR 1 created it), so the CREATE TYPE here is
--   the same duplicate_object-swallowing block rather than a bare redeclaration - this migration has
--   to apply to a database that has never seen PR 1 as well as to one that has. Every ADD COLUMN is
--   IF NOT EXISTS-guarded, every index is IF NOT EXISTS, and each foreign key is added only when
--   pg_constraint lacks it. A second application against the shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (the CI migration-check job) - CREATE TYPE, ALTER TABLE ADD COLUMN
--   IF NOT EXISTS and ALTER TABLE ADD CONSTRAINT are all core Postgres. No Supabase-only objects,
--   no auth schema, and no role grants to guard: the new columns inherit each table's existing RLS
--   policies and grants.
-- NO BACKFILL, NO TABLE REWRITE: created_by_source lands on its default for every existing row,
--   which is the literal truth about them; the other two are nullable.
--
-- Written out per table rather than as a DO-loop over table names: the explicit form is what the
-- job migration already reads like, it is greppable, and a typo in it fails at parse time instead
-- of inside a dynamic EXECUTE.

-- ─── Enum ────────────────────────────────────────────────────────────────────
-- Created by 20260805120000_job_created_by. Repeated here, guarded, so this migration stands alone
-- on a database where that one has not run.
DO $$ BEGIN
  CREATE TYPE "CreatedBySource" AS ENUM ('USER', 'CLIENT', 'SYSTEM', 'IMPORT', 'UNKNOWN');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── leads ───────────────────────────────────────────────────────────────────
-- NOT NULL DEFAULT 'UNKNOWN' is load-bearing here and on every table below: the default is the only
-- thing that can answer for the rows that predate this migration. A nullable column would leave them
-- reading back null, which says nothing at all.
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT;
ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN';

-- SET NULL (not RESTRICT, not CASCADE) on this and every FK below: a permanent user delete must
-- neither fail nor take the row with it. created_by_name is what keeps the audit answer readable.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'leads_created_by_id_fkey') THEN
    ALTER TABLE "leads" ADD CONSTRAINT "leads_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Every "rows this user created" lookup filters on this column; without the index each one is a
-- full scan of the org's table. Same reasoning for the four indexes below.
CREATE INDEX IF NOT EXISTS "leads_created_by_id_idx" ON "leads"("created_by_id");

-- ─── invoices ────────────────────────────────────────────────────────────────
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT;
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invoices_created_by_id_fkey') THEN
    ALTER TABLE "invoices" ADD CONSTRAINT "invoices_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "invoices_created_by_id_idx" ON "invoices"("created_by_id");

-- ─── customers ───────────────────────────────────────────────────────────────
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT;
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_created_by_id_fkey') THEN
    ALTER TABLE "customers" ADD CONSTRAINT "customers_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "customers_created_by_id_idx" ON "customers"("created_by_id");

-- ─── payments ────────────────────────────────────────────────────────────────
-- Payment already has collected_by, and it is NOT the same fact. collected_by is who handled the
-- money; created_by_* is who caused the row to exist. They agree on a staff-recorded payment and
-- diverge on the two rows nobody collected: a Stripe webhook payment (CLIENT - the customer paid
-- themselves) and a deposit-credit ledger payment (SYSTEM - the platform minted it).
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT;
ALTER TABLE "payments" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_created_by_id_fkey') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "payments_created_by_id_idx" ON "payments"("created_by_id");

-- ─── attachments ─────────────────────────────────────────────────────────────
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "created_by_id" UUID;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT;
ALTER TABLE "attachments" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'attachments_created_by_id_fkey') THEN
    ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_id_fkey"
      FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "attachments_created_by_id_idx" ON "attachments"("created_by_id");
