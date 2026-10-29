-- Logistic Orders v1 (spec 2026-07-20 §3/§14/§15, plan LO-1 §1.1): the goods-issue
-- document that becomes the only office path consuming stock. Ships the WHOLE
-- program's schema in one migration (LO + LO lines + service-plan materials
-- template + StockMovement drill-through + org numbering) so LO-2…LO-5 are
-- code-only.
--
-- Notable stances captured here:
--   * `RETURNED` is in the status enum from day one (§14 H1) — CANCELLED means
--     never deducted, RETURNED means deducted then unwound. Adding it later would
--     be an enum migration on a live status column.
--   * All six anchors are SET NULL: "it's just a link." An LO whose job/invoice is
--     deleted survives unanchored as a historical document (§14 C1).
--   * `seq` is an INT, not a substring of `number` — string sort puts `-10` before
--     `-2` (§11 build note b). It is ALSO the authoritative flat/anchored
--     discriminator (NULL = flat), which is what the flat counter's self-heal
--     subquery keys off. It describes how the NUMBER was shaped, NOT what the row
--     links to — those are independent axes, and no CHECK ties them (see the
--     "DELIBERATELY NO CHECK" note below before adding one).
--   * `logistic_order_prefix` defaults to 'LO', so the flat standalone number is
--     `LO00001` and anchored numbers (`LO-J00042-1`) bypass the flat counter. Note
--     an admin MAY set a prefix containing a hyphen (PREFIX_REGEX allows it), so
--     "contains a hyphen" is NOT a usable flat/anchored discriminator — use `seq`.
--
-- IDEMPOTENT: IF NOT EXISTS everywhere; enum + FKs inside guarded DO blocks
--   (may run twice on the shared staging DB).
-- PORTABLE: vanilla postgres:16 — RLS policies are TO-public/current_setting
--   (core Postgres); the only Supabase-role objects are the anon/authenticated
--   REVOKEs, guarded behind pg_roles existence checks.

-- ─── Enum ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'LogisticOrderStatus') THEN
    CREATE TYPE "LogisticOrderStatus" AS ENUM ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PROCESSED', 'CANCELLED', 'RETURNED');
  END IF;
END $$;

-- ─── logistic_orders ─────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS "logistic_orders" (
  "id"               UUID NOT NULL,
  "number"           TEXT NOT NULL,
  "seq"              INTEGER,
  "status"           "LogisticOrderStatus" NOT NULL DEFAULT 'DRAFT',
  "job_id"           UUID,
  "invoice_id"       UUID,
  "estimate_id"      UUID,
  "lead_id"          UUID,
  "customer_id"      UUID,
  "service_plan_id"  UUID,
  "notes"            TEXT,
  "created_by"       UUID NOT NULL,
  "submitted_at"     TIMESTAMP(3),
  "submitted_by"     UUID,
  "approved_at"      TIMESTAMP(3),
  "approved_by"      UUID,
  "processed_at"     TIMESTAMP(3),
  "processed_by"     UUID,
  "cancelled_at"     TIMESTAMP(3),
  "cancelled_reason" TEXT,
  "created_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"       TIMESTAMP(3) NOT NULL,
  "organization_id"  UUID NOT NULL,
  CONSTRAINT "logistic_orders_pkey" PRIMARY KEY ("id")
);

-- Per-org number uniqueness is the race backstop for allocateAnchoredNumber
-- (anchor-row FOR UPDATE + MAX(seq)+1, no retry loop).
CREATE UNIQUE INDEX IF NOT EXISTS "logistic_orders_organization_id_number_key" ON "logistic_orders"("organization_id", "number");

-- DELIBERATELY NO CHECK COUPLING `seq` TO THE ANCHOR FKs. Do not re-add one.
--
-- An earlier draft carried `logistic_orders_anchored_seq_present`:
--   CHECK (seq IS NOT NULL OR (all six anchor FKs IS NULL))
-- i.e. "if it links to an anchor it must carry a seq". That is not an invariant of
-- this model, and neither is its converse. Both directions have legal counterexamples:
--
--   * `anchor FK set => seq NOT NULL` is FALSE. A standalone LO is `LO00001` with
--     seq NULL. Attaching a job to it later sets job_id and CANNOT set seq, because
--     "the number is stamped at creation and is immutable — re-linking later never
--     renumbers" (spec §4 rules, line 61). The row then satisfies neither disjunct
--     and the write dies on SQLSTATE 23514. Spec §11 amendment 5 (line 145) defers
--     only the re-link *UI* — "schema links ship" — so the constraint forbade the
--     exact path these six FKs are being shipped for.
--   * `seq NOT NULL => anchor FK set` is FALSE too, for the reason the anchors are
--     all SET NULL (§14 C1): an anchored LO whose anchor is deleted keeps its seq
--     and nulls its FKs, and must stay legal.
--
-- The two axes are simply independent by design: `seq` records how the NUMBER was
-- SHAPED at creation; the FKs record what the document links to NOW. numbering.ts
-- says so directly — a document may carry several anchors at once, "only the winner
-- shapes the number; the rest stay plain links". A flat number that later gains a
-- link is just that same "plain link" case with a flat winner.
--
-- The genuine invariant — `seq IS NULL` iff `number` is a flat number — is NOT
-- expressible as a CHECK. Deciding whether `number` is flat means parsing it against
-- that org's `logistic_order_prefix`, and PREFIX_REGEX (/^[A-Za-z0-9-]{1,10}$/,
-- organization.controller.ts:25) permits a hyphen, so no regex on `number` alone can
-- do it: under prefix 'LO-' the FLAT number `LO-00001` ends in `-00001` and apes an
-- anchored one. That needs a subquery into `organizations`, which CHECK constraints
-- cannot contain. A trigger could, but that is strictly more machinery than the
-- constraint it would replace — see CLAUDE.md rule 4.
--
-- Nothing is lost by its absence. The hazard it was reaching for (a NULL-seq row
-- making `COALESCE(MAX(seq),0)+1` re-mint an already-used number forever, which the
-- unique index above would turn into a permanently un-creatable anchor) is already
-- fixed at the source: allocateAnchoredNumber takes GREATEST(MAX(seq), MAX(trailing
-- digits of number)), so a NULL seq self-heals off the number instead of corrupting
-- the series. Two tests in numbering-logistic-order.test.ts pin that. The flat
-- counter's `WHERE t.seq IS NULL` also stays correct across a re-link: the re-linked
-- row keeps a flat number, so it belongs in the flat domain, which is where a NULL
-- seq puts it.

CREATE INDEX IF NOT EXISTS "logistic_orders_organization_id_idx" ON "logistic_orders"("organization_id");
CREATE INDEX IF NOT EXISTS "logistic_orders_status_idx"          ON "logistic_orders"("status");
CREATE INDEX IF NOT EXISTS "logistic_orders_job_id_idx"          ON "logistic_orders"("job_id");
CREATE INDEX IF NOT EXISTS "logistic_orders_invoice_id_idx"      ON "logistic_orders"("invoice_id");
CREATE INDEX IF NOT EXISTS "logistic_orders_estimate_id_idx"     ON "logistic_orders"("estimate_id");
CREATE INDEX IF NOT EXISTS "logistic_orders_lead_id_idx"         ON "logistic_orders"("lead_id");
CREATE INDEX IF NOT EXISTS "logistic_orders_customer_id_idx"     ON "logistic_orders"("customer_id");
CREATE INDEX IF NOT EXISTS "logistic_orders_service_plan_id_idx" ON "logistic_orders"("service_plan_id");

-- Anchors: SET NULL (the LO outlives its anchor). Actors: created_by RESTRICT
-- (Estimate.created_by precedent — permanentDelete already refuses users with
-- history); the three lifecycle actors SET NULL so the trail survives a hard
-- user delete (stock_movements.actor_user_id precedent).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_job_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_job_id_fkey"
      FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_invoice_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_invoice_id_fkey"
      FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_estimate_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_estimate_id_fkey"
      FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_lead_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_customer_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_customer_id_fkey"
      FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_service_plan_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_service_plan_id_fkey"
      FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_created_by_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_created_by_fkey"
      FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_submitted_by_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_submitted_by_fkey"
      FOREIGN KEY ("submitted_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_approved_by_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_approved_by_fkey"
      FOREIGN KEY ("approved_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_processed_by_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_processed_by_fkey"
      FOREIGN KEY ("processed_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_orders_organization_id_fkey') THEN
    ALTER TABLE "logistic_orders" ADD CONSTRAINT "logistic_orders_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── logistic_order_lines ────────────────────────────────────────────────────
-- item_sku/item_name are ledger snapshots: they outlive a SET NULL'd catalog item
-- so the line still renders and processing can name the sku in its 422. No
-- uniqueness on (LO, item) — the same item may be pulled from several locations.
CREATE TABLE IF NOT EXISTS "logistic_order_lines" (
  "id"                UUID NOT NULL,
  "logistic_order_id" UUID NOT NULL,
  "item_id"           UUID,
  "item_sku"          TEXT NOT NULL,
  "item_name"         TEXT NOT NULL,
  "qty"               DECIMAL(10,2) NOT NULL,
  "from_location_id"  UUID,
  "sequence"          INTEGER NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"        TIMESTAMP(3) NOT NULL,
  "organization_id"   UUID NOT NULL,
  CONSTRAINT "logistic_order_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "logistic_order_lines_logistic_order_id_idx" ON "logistic_order_lines"("logistic_order_id");
CREATE INDEX IF NOT EXISTS "logistic_order_lines_item_id_idx"           ON "logistic_order_lines"("item_id");
CREATE INDEX IF NOT EXISTS "logistic_order_lines_organization_id_idx"   ON "logistic_order_lines"("organization_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_order_lines_logistic_order_id_fkey') THEN
    ALTER TABLE "logistic_order_lines" ADD CONSTRAINT "logistic_order_lines_logistic_order_id_fkey"
      FOREIGN KEY ("logistic_order_id") REFERENCES "logistic_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_order_lines_item_id_fkey') THEN
    ALTER TABLE "logistic_order_lines" ADD CONSTRAINT "logistic_order_lines_item_id_fkey"
      FOREIGN KEY ("item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_order_lines_from_location_id_fkey') THEN
    ALTER TABLE "logistic_order_lines" ADD CONSTRAINT "logistic_order_lines_from_location_id_fkey"
      FOREIGN KEY ("from_location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'logistic_order_lines_organization_id_fkey') THEN
    ALTER TABLE "logistic_order_lines" ADD CONSTRAINT "logistic_order_lines_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── service_plan_material_lines ─────────────────────────────────────────────
-- The plan's default-materials template (§15). Plan DATA, not a TEMPLATE-status
-- LogisticOrder: a template has no number, no lifecycle and no anchors, and a
-- TEMPLATE enum value would leak into every LO list, count and report.
-- scheduleVisit instantiates these into ONE DRAFT LO per visit-job.
CREATE TABLE IF NOT EXISTS "service_plan_material_lines" (
  "id"              UUID NOT NULL,
  "service_plan_id" UUID NOT NULL,
  "item_id"         UUID,
  "item_sku"        TEXT NOT NULL,
  "item_name"       TEXT NOT NULL,
  "qty"             DECIMAL(10,2) NOT NULL,
  "position"        INTEGER NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  "organization_id" UUID NOT NULL,
  CONSTRAINT "service_plan_material_lines_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "service_plan_material_lines_service_plan_id_idx" ON "service_plan_material_lines"("service_plan_id");
CREATE INDEX IF NOT EXISTS "service_plan_material_lines_organization_id_idx"  ON "service_plan_material_lines"("organization_id");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_plan_material_lines_service_plan_id_fkey') THEN
    ALTER TABLE "service_plan_material_lines" ADD CONSTRAINT "service_plan_material_lines_service_plan_id_fkey"
      FOREIGN KEY ("service_plan_id") REFERENCES "service_plans"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_plan_material_lines_item_id_fkey') THEN
    ALTER TABLE "service_plan_material_lines" ADD CONSTRAINT "service_plan_material_lines_item_id_fkey"
      FOREIGN KEY ("item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_plan_material_lines_organization_id_fkey') THEN
    ALTER TABLE "service_plan_material_lines" ADD CONSTRAINT "service_plan_material_lines_organization_id_fkey"
      FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── stock_movements: LO drill-through (byte-for-byte the job_line_item_id
--     precedent, 20260717032601_inventory_p0_schema:40-113) ──────────────────
-- SET NULL like every other ref on this table: the movement is the permanent
-- record, and deleting an LO must never rewrite ledger history.
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "logistic_order_id" UUID;
ALTER TABLE "stock_movements" ADD COLUMN IF NOT EXISTS "logistic_order_line_id" UUID;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_logistic_order_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_logistic_order_id_fkey"
      FOREIGN KEY ("logistic_order_id") REFERENCES "logistic_orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'stock_movements_logistic_order_line_id_fkey') THEN
    ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_logistic_order_line_id_fkey"
      FOREIGN KEY ("logistic_order_line_id") REFERENCES "logistic_order_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "stock_movements_logistic_order_id_idx" ON "stock_movements"("logistic_order_id");
CREATE INDEX IF NOT EXISTS "stock_movements_logistic_order_line_id_idx" ON "stock_movements"("logistic_order_line_id");

-- ─── organizations: LO numbering triplet ─────────────────────────────────────
-- Default prefix 'LO': flat standalone numbers render as `LO00001` under the
-- existing number_padding. Anchored numbers are minted by allocateAnchoredNumber
-- and never touch this counter — its self-heal subquery must exclude them
-- (`WHERE seq IS NULL`) or an anchored seq would bump the flat series. NOT
-- `number NOT LIKE '%-%'`: PREFIX_REGEX permits a hyphen, so an org on prefix 'LO-'
-- renders FLAT numbers as `LO-00001` and that heuristic would exclude every row,
-- silently disabling the self-heal entirely.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logistic_order_prefix" VARCHAR(10) NOT NULL DEFAULT 'LO';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logistic_order_next_number" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "logistic_order_first_issued_at" TIMESTAMP(3);

-- ─── Tenant RLS backstop (exact 20260703000100_tenant_rls pattern;
--     fail-closed; INERT until non-BYPASSRLS role + DB_TENANT_GUARD=on) ───────
ALTER TABLE "logistic_orders" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistic_orders" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "logistic_orders";
CREATE POLICY "tenant_isolation" ON "logistic_orders"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "logistic_order_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "logistic_order_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "logistic_order_lines";
CREATE POLICY "tenant_isolation" ON "logistic_order_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "service_plan_material_lines" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "service_plan_material_lines" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "service_plan_material_lines";
CREATE POLICY "tenant_isolation" ON "service_plan_material_lines"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- ─── Defense-in-depth: strip Supabase PostgREST role grants from the new
--     tables (gmail precedent 20260716210000; the dynamic sweep in
--     20260708140000 only covered tables existing at its run time).
--     pg_roles guards keep this valid on CI's vanilla postgres. ───────────────
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.logistic_orders FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.logistic_order_lines FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.service_plan_material_lines FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.logistic_orders FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.logistic_order_lines FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.service_plan_material_lines FROM authenticated';
  END IF;
END $$;

-- ─── ROLE PERMISSION SEEDING (appended by CASL step) ─────────────────────────
-- Plan §1.1 item 8 / build-readiness §1.8: the LogisticOrder subject's
-- DEFAULT_GRANTS cross-join over existing organizations belongs HERE, appended
-- by the CASL wiring step after defaultGrants.ts is edited. Generate with:
--   cd backend && npx tsx src/scripts/check-role-permission-drift.ts --emit-sql
-- Template: 20260707130000_sync_role_permission_defaults (INSERT … SELECT
-- gen_random_uuid() … CROSS JOIN (VALUES …) ON CONFLICT DO NOTHING).
--
-- Generated via: cd backend && npx tsx src/scripts/check-role-permission-drift.ts --emit-sql
-- then FILTERED to subject = 'LogisticOrder' (8 of 152 rows). Deliberately scoped, NOT the
-- full DEFAULT_GRANTS sweep: 20260707130000 already did the org-wide sync, and re-running the
-- whole list here would silently re-grant unrelated permissions that admins have since removed
-- through the Roles UI — the same hazard 20260717040000_split_inventory_purchasing_subjects
-- called out in its header. This migration seeds the new subject and nothing else.
--
-- Posture (defaultGrants.ts): SALES read/create/submit; DISPATCHER read/create/update/
-- process/cancel. NO TECHNICIAN row (spec §12 rec 5, signed — no tech LO surface in v1).
-- `approve` is absent by design: it is a per-user capability (userCapabilities.ts), never a
-- role grant, so it must never appear in role_permissions. What keeps it out of the Roles UI
-- write path is viewModelToGrants' emittable surface plus putRolePermissions' isCatalogEntry
-- filter (see the gate note in catalog.ts) — NOT catalog membership on its own. ADMIN needs no
-- rows — it short-circuits to `manage all` in defineAbility.ts.
--
-- Idempotent (ON CONFLICT DO NOTHING) — safe to run more than once. Portable: no Supabase-only
-- objects, and gen_random_uuid() is core Postgres 13+.
INSERT INTO role_permissions (id, organization_id, role, action, subject, conditions, created_at, updated_at)
SELECT
  gen_random_uuid(),
  o.id,
  g.role,
  g.action,
  g.subject,
  g.conditions::jsonb,
  NOW(),
  NOW()
FROM organizations o
CROSS JOIN (VALUES
  ('SALES','read','LogisticOrder',NULL),
  ('SALES','create','LogisticOrder',NULL),
  ('SALES','submit','LogisticOrder',NULL),
  ('DISPATCHER','read','LogisticOrder',NULL),
  ('DISPATCHER','create','LogisticOrder',NULL),
  ('DISPATCHER','update','LogisticOrder',NULL),
  ('DISPATCHER','process','LogisticOrder',NULL),
  ('DISPATCHER','cancel','LogisticOrder',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
