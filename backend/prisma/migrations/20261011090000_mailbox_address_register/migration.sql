-- Roles & Permissions Overhaul, PRD 10, slice S10.1: the mailbox address register and a frozen, unique
-- main address per company.
--
-- Two new tables. `mailboxes` holds a company's main mailbox (one per org; user mailboxes arrive with
-- S10.3). `mailbox_addresses` is the register: every address ever issued, globally unique, never
-- deleted, keyed by local part (each environment has one database and one mailbox domain, so the local
-- part is unique exactly when the address is). It is seeded with the reserved local parts, which belong
-- to nobody and are never issued.
--
-- Then, once, every company is put through the register:
--   1. its EFFECTIVE company part is taken: the chosen one (organizations.email_sender_local_part) else
--      the one derived from its name (lowercase letters and digits, at most 40);
--   2. a company whose effective part is reserved (postmaster, abuse, bounce, bounces, no-reply,
--      noreply), or whose name gave nothing usable (the no-reply fallback), gets a generated neutral
--      part (company1, company2, ...);
--   3. where two companies share an effective part, the one with a CHOSEN part keeps it (it was already
--      unique among chosen parts); otherwise the company created first keeps it; the rest get the next
--      free variant with a number added (acme2, acme3, ...). A part already held by a company that went
--      through the register earlier is kept by that company;
--   4. the part is FROZEN on the company (email_sender_local_part, so a later rename no longer moves
--      it), one main mailbox is created, and its address is issued in the register.
--
-- A DRY RUN lists every company whose main address changes and why, and writes nothing:
--   SET s10_1.dry_run = 'on';  then run this file in the same session.
-- A real run prints the same list before it writes (company ids and parts only, never names), prints
-- per-environment counts after it writes, and stops with an error (rolling the migration back) if any
-- company is left without a main mailbox or a primary address. A company that already has a main
-- mailbox is never touched, so a second run changes nothing.
--
-- IDEMPOTENT + portable plain PostgreSQL (the Supabase-only roles sit behind a pg_roles guard). Runs on
-- CI's vanilla postgres:16, on the Render deploy, and possibly twice against the shared staging DB.
-- NEVER run `prisma migrate` from a worktree.

CREATE TABLE IF NOT EXISTS "mailboxes" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "kind"            TEXT NOT NULL,
  "user_id"         UUID,
  "holder_user_id"  UUID,
  "status"          TEXT NOT NULL DEFAULT 'active',
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "mailboxes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "mailbox_addresses" (
  "id"              UUID NOT NULL,
  "local_part"      TEXT NOT NULL,
  "kind"            TEXT NOT NULL DEFAULT 'issued',
  "organization_id" UUID,
  "mailbox_id"      UUID,
  "is_primary"      BOOLEAN NOT NULL DEFAULT false,
  "issued_at"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "mailbox_addresses_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_addresses_local_part_key" ON "mailbox_addresses"("local_part");
CREATE INDEX IF NOT EXISTS "mailbox_addresses_organization_id_idx" ON "mailbox_addresses"("organization_id");
CREATE INDEX IF NOT EXISTS "mailbox_addresses_mailbox_id_idx" ON "mailbox_addresses"("mailbox_id");
CREATE INDEX IF NOT EXISTS "mailboxes_organization_id_idx" ON "mailboxes"("organization_id");
-- Exactly one main mailbox per company, and at most one primary address per mailbox. Partial, so Prisma's
-- schema cannot express them; the database is where they are enforced.
CREATE UNIQUE INDEX IF NOT EXISTS "mailboxes_one_main_per_org" ON "mailboxes"("organization_id") WHERE "kind" = 'main';
CREATE UNIQUE INDEX IF NOT EXISTS "mailbox_addresses_one_primary" ON "mailbox_addresses"("mailbox_id") WHERE "is_primary";

-- Foreign keys. A company's mailboxes go with the company (an org purge removes mailbox content). The
-- register's rows do NOT: an address row outlives its company and mailbox (its links are emptied, the
-- row stays), because an address, once issued, is never issued again.
DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_holder_user_id_fkey"
    FOREIGN KEY ("holder_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailbox_addresses" ADD CONSTRAINT "mailbox_addresses_organization_id_fkey"
    FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "mailbox_addresses" ADD CONSTRAINT "mailbox_addresses_mailbox_id_fkey"
    FOREIGN KEY ("mailbox_id") REFERENCES "mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Tenant RLS backstop, the same fail-closed pattern every org-scoped table carries
-- (20260703000100_tenant_rls). A reserved row has no company, so only an unscoped (bypass) session sees
-- it; the register reads and writes through such a session because it has to see every company.
ALTER TABLE "mailboxes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailboxes" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mailboxes";
CREATE POLICY "tenant_isolation" ON "mailboxes"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

ALTER TABLE "mailbox_addresses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "mailbox_addresses" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "mailbox_addresses";
CREATE POLICY "tenant_isolation" ON "mailbox_addresses"
  USING (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid)
  WITH CHECK (current_setting('app.bypass_rls', true) = 'on' OR "organization_id" = NULLIF(current_setting('app.current_org_id', true), '')::uuid);

-- Strip PostgREST role grants. Guarded - anon/authenticated exist only on Supabase.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.mailboxes FROM anon';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.mailbox_addresses FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.mailboxes FROM authenticated';
    EXECUTE 'REVOKE ALL PRIVILEGES ON public.mailbox_addresses FROM authenticated';
  END IF;
END $$;

-- The register and the organizations table are written below; both carry RLS.
SELECT set_config('app.bypass_rls', 'on', true);

-- The reserved local parts: never issued to anyone, as a company part or as an address.
INSERT INTO "mailbox_addresses" ("id", "local_part", "kind", "is_primary")
SELECT gen_random_uuid(), r.local_part, 'reserved', false
FROM (VALUES ('postmaster'), ('abuse'), ('bounce'), ('bounces'), ('no-reply'), ('noreply')) AS r(local_part)
ON CONFLICT ("local_part") DO NOTHING;

DO $$
DECLARE
  dry_run boolean := coalesce(current_setting('s10_1.dry_run', true), '') = 'on';
  reserved text[] := ARRAY['postmaster', 'abuse', 'bounce', 'bounces', 'no-reply', 'noreply'];
  taken text[];
  rec record;
  stem text;
  n integer;
  candidate text;
  org_total integer;
  pending_total integer;
  changed_total integer;
  main_total integer;
  primary_total integer;
  missing integer;
BEGIN
  DROP TABLE IF EXISTS pg_temp.s10_1_plan;
  -- Every company that has not been through the register yet: no main mailbox.
  CREATE TEMP TABLE s10_1_plan ON COMMIT DROP AS
  SELECT o.id AS org_id,
         o.created_at,
         NULLIF(lower(btrim(o.email_sender_local_part)), '') AS chosen,
         NULLIF(left(regexp_replace(lower(o.name), '[^a-z0-9]', '', 'g'), 40), '') AS derived,
         NULL::text AS effective,
         NULL::text AS reason,
         NULL::text AS assigned
  FROM "organizations" o
  WHERE NOT EXISTS (
    SELECT 1 FROM "mailboxes" m WHERE m.organization_id = o.id AND m.kind = 'main'
  );

  -- 1. The effective part, chosen else derived; and the two reasons that need no comparison.
  UPDATE s10_1_plan
  SET effective = coalesce(chosen, derived),
      reason = CASE
        WHEN coalesce(chosen, derived) IS NULL THEN 'fallback'
        WHEN coalesce(chosen, derived) = ANY (reserved) THEN 'reserved'
        ELSE NULL
      END;

  -- 2. Collisions on the effective part: with a company already through the register, with any issued
  -- address, or with a stronger claim among the companies still to be done (a chosen part beats a
  -- derived one; otherwise the company created first wins).
  UPDATE s10_1_plan p
  SET reason = 'collision'
  WHERE p.reason IS NULL
    AND (
      EXISTS (SELECT 1 FROM "mailbox_addresses" a WHERE a.local_part = p.effective)
      OR EXISTS (
        SELECT 1 FROM "organizations" o
        WHERE o.id <> p.org_id AND lower(btrim(o.email_sender_local_part)) = p.effective
          AND EXISTS (SELECT 1 FROM "mailboxes" m WHERE m.organization_id = o.id AND m.kind = 'main')
      )
      OR EXISTS (
        SELECT 1 FROM s10_1_plan q
        WHERE q.org_id <> p.org_id
          AND q.effective = p.effective
          AND q.effective <> ALL (reserved)
          AND (
            (q.chosen IS NOT NULL AND p.chosen IS NULL)
            OR ((q.chosen IS NULL) = (p.chosen IS NULL) AND (q.created_at, q.org_id) < (p.created_at, p.org_id))
          )
      )
    );

  -- 3. Hand out the parts. Everything anyone holds or will keep is off the table before the first
  -- variant is chosen; oldest company first, so the outcome does not depend on row order.
  taken := ARRAY(SELECT a.local_part FROM "mailbox_addresses" a)
        || ARRAY(
             SELECT lower(btrim(o.email_sender_local_part)) FROM "organizations" o
             WHERE o.email_sender_local_part IS NOT NULL
               AND EXISTS (SELECT 1 FROM "mailboxes" m WHERE m.organization_id = o.id AND m.kind = 'main')
           )
        || ARRAY(SELECT p.effective FROM s10_1_plan p WHERE p.effective IS NOT NULL);

  FOR rec IN SELECT * FROM s10_1_plan ORDER BY created_at, org_id LOOP
    IF rec.reason IS NULL THEN
      candidate := rec.effective;
    ELSE
      stem := CASE WHEN rec.reason IN ('reserved', 'fallback') THEN 'company' ELSE rec.effective END;
      n := CASE WHEN stem = 'company' THEN 1 ELSE 2 END;
      LOOP
        candidate := left(stem, 40 - length(n::text)) || n::text;
        EXIT WHEN NOT (candidate = ANY (taken)) AND NOT (candidate = ANY (reserved));
        n := n + 1;
      END LOOP;
      taken := taken || candidate;
    END IF;
    UPDATE s10_1_plan SET assigned = candidate WHERE org_id = rec.org_id;
  END LOOP;

  SELECT count(*) INTO org_total FROM "organizations";
  SELECT count(*) INTO pending_total FROM s10_1_plan;
  SELECT count(*) INTO changed_total FROM s10_1_plan WHERE reason IS NOT NULL;

  -- The report: every company whose main address changes, and why.
  FOR rec IN SELECT * FROM s10_1_plan WHERE reason IS NOT NULL ORDER BY created_at, org_id LOOP
    RAISE NOTICE 'S10.1 org %: main address part % -> % (%)',
      rec.org_id, coalesce(rec.effective, 'no-reply'), rec.assigned, rec.reason;
  END LOOP;
  RAISE NOTICE 'S10.1 % companies, % to go through the register, % change their main address%',
    org_total, pending_total, changed_total, CASE WHEN dry_run THEN ' (DRY RUN, nothing written)' ELSE '' END;

  IF dry_run THEN
    RETURN;
  END IF;

  -- 4. Freeze the part, create the main mailbox, issue its address.
  UPDATE "organizations" o
  SET email_sender_local_part = p.assigned
  FROM s10_1_plan p
  WHERE o.id = p.org_id AND o.email_sender_local_part IS DISTINCT FROM p.assigned;

  INSERT INTO "mailboxes" ("id", "organization_id", "kind", "status", "created_at", "updated_at")
  SELECT gen_random_uuid(), p.org_id, 'main', 'active', now(), now()
  FROM s10_1_plan p
  ON CONFLICT DO NOTHING;

  INSERT INTO "mailbox_addresses" ("id", "local_part", "kind", "organization_id", "mailbox_id", "is_primary", "issued_at")
  SELECT gen_random_uuid(), p.assigned, 'issued', p.org_id, m.id, true, now()
  FROM s10_1_plan p
  JOIN "mailboxes" m ON m.organization_id = p.org_id AND m.kind = 'main'
  ON CONFLICT ("local_part") DO NOTHING;

  -- After writing: per-environment counts, and a hard stop if any company is not fully set up.
  SELECT count(*) INTO main_total FROM "mailboxes" WHERE kind = 'main';
  SELECT count(*) INTO primary_total
  FROM "mailbox_addresses" a JOIN "mailboxes" m ON m.id = a.mailbox_id AND m.kind = 'main' WHERE a.is_primary;
  RAISE NOTICE 'S10.1 done: % companies, % main mailboxes, % primary main addresses', org_total, main_total, primary_total;

  SELECT count(*) INTO missing
  FROM "organizations" o
  WHERE o.email_sender_local_part IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM "mailboxes" m
       JOIN "mailbox_addresses" a ON a.mailbox_id = m.id AND a.is_primary AND a.local_part = o.email_sender_local_part
       WHERE m.organization_id = o.id AND m.kind = 'main'
     );
  IF missing > 0 THEN
    RAISE EXCEPTION 'S10.1: % companies are missing a frozen part, a main mailbox or its primary address', missing;
  END IF;
END $$;
