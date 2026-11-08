-- Per-visit location (spec md_files/specs/scheduling/2026-09-10-visit-location-and-performer-phone.md,
-- slice 1). A visit gains a location of its own so a walkthrough can be held at the showroom
-- rather than at the customer's house, and the confirmation automation can say so.
--
-- THREE STATES, DERIVED, NEVER STORED (D3):
--
--   location_id set             -> one of the organisation's own Locations (a POINTER, D2, so a
--                                  corrected address flows into an unsent reminder).
--   location_address_line1 set  -> a one-off address, frozen on the visit because it has no row
--                                  behind it to stay in step with.
--   both null                   -> the parent's service address, which is today's behaviour and
--                                  what every existing row means.
--
-- No mode enum: it would be a third source of truth able to disagree with the columns it
-- describes. "Not both" is the CHECK below, the idiom this table already carries in
-- `visits_exactly_one_parent`.
--
-- PURE EXPAND. Every column is ADDITIVE and nullable, which is the safe half of expand/contract:
-- Prisma enumerates its BUILD-TIME column list on every select-less query, so a DROP during the
-- deploy overlap 500s the old instance (see 20260831120000_drop_manual_comm_outcome's header at
-- length). Adding is the inverse and is invisible to the instance still running the old client -
-- it simply never names the new columns. The CHECK cannot fail on data either: every existing row
-- has both new columns NULL, so num_nonnulls(...) = 0, which satisfies "<= 1".
--
-- COLUMN TYPES match `service_locations` (TEXT), not `locations` (VARCHAR + `postal_code`): this
-- is the same five-field structured address every customer-facing address in the product uses,
-- and the one-off has to read and map identically to a service address (D4). No latitude /
-- longitude - nothing in this codebase stores coordinates; the map geocodes the formatted address
-- at render time, so the one-off inherits that for free.
--
-- IDEMPOTENT: every add is IF NOT EXISTS, the constraint and the FK are guarded on pg_constraint
-- (Postgres has no ADD CONSTRAINT IF NOT EXISTS), the index is IF NOT EXISTS. PORTABLE: plain DDL
-- plus the Postgres builtin num_nonnulls - no Supabase-only objects, no auth.* helpers, no
-- TO authenticated / anon / service_role. So it runs unchanged in all three places: CI's vanilla
-- postgres:16, Render's `prisma migrate deploy`, and by hand.
--
-- NO RLS CHANGE. `visits` already carries the canonical tenant_isolation policy on
-- organization_id (inherited through the walkthroughs -> visits rename in
-- 20260817130000_visits_multi_visit_s1, which carries policies with the table). A new column is
-- inside that policy's reach automatically; the location is not what the policy filters on.
-- Tenant-scoping of `location_id` itself is an APPLICATION check on write (D8) - the FK below
-- constrains the id to a real location, not to a location in the writer's own organisation.

-- ─── 1. The company-location pointer ──────────────────────────────────────────

ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "location_id" UUID;

-- ─── 2. The one-off address: the same five structured fields ──────────────────

ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "location_address_line1" TEXT;
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "location_address_line2" TEXT;
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "location_city" TEXT;
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "location_state" TEXT;
ALTER TABLE "visits" ADD COLUMN IF NOT EXISTS "location_zip" TEXT;

-- ─── 3. Not-both CHECK (D3) ───────────────────────────────────────────────────
--
-- The invariant Prisma cannot express, mirroring `visits_exactly_one_parent` one table over.
-- `<= 1`, not `= 1`: both-null is the legal third state (the service address), and it is what
-- every row written before this migration means.
--
-- Keyed off `location_address_line1` alone - the one field of a structured address that is never
-- optional, so it is the only honest witness for "a one-off address is set". Keying off the whole
-- five would make a visit with only a city look like the service address.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_location_not_both') THEN
    ALTER TABLE "visits"
      ADD CONSTRAINT "visits_location_not_both"
      CHECK (num_nonnulls("location_id", "location_address_line1") <= 1);
  END IF;
END $$;

-- ─── 4. Foreign key: RESTRICT, deliberately (D9) ──────────────────────────────
--
-- NOT SetNull and NOT Cascade. SetNull would silently move a booked visit back to the customer's
-- address after the customer has already been told to come to the showroom; Cascade would delete
-- the trip along with the branch. Restricting instead surfaces in the delete handler as a 409
-- naming the count, the same guard it already applies to users assigned to that location.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'visits_location_id_fkey') THEN
    ALTER TABLE "visits"
      ADD CONSTRAINT "visits_location_id_fkey"
      FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── 5. Index ─────────────────────────────────────────────────────────────────
--
-- The delete guard's access pattern: "does any visit point at this location". Without it that
-- count is a sequential scan of every visit in the database on an ordinary admin action.

CREATE INDEX IF NOT EXISTS "visits_location_id_idx" ON "visits"("location_id");
