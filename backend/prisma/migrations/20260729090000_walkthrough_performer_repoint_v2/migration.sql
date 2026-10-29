-- Walkthrough-as-entity redesign, PR-B2 (spec md_files/specs/leads/2026-07-28-walkthrough-as-entity.md,
-- plan md_files/plans/leads/2026-07-28-walkthrough-as-entity-phase-2.md). Completes the
-- lead_walkthrough_performers repoint that PR-A2 (20260728150000) deliberately deferred - see that
-- migration's header note: "walkthrough_id column only ... The full repoint (swap the unique
-- constraint to (walkthrough_id, user_id), drop lead_id) must co-deploy with the controller change
-- that starts keying performers by walkthrough_id (PR-B2)".
--
-- This is the LOAD-BEARING half only: walkthrough_id becomes required and the unique constraint
-- moves from (lead_id, user_id) to (walkthrough_id, user_id) so the same performer can be assigned
-- to a SECOND visit on the same lead (D1 - a lead has many walkthroughs; the old constraint would
-- reject exactly that). lead_id itself is KEPT (not dropped) - PR-B2's controllers dual-write both
-- columns on every performer-set write, same "dual-write, drop later" shape as the 9 legacy
-- Lead.walkthrough_* columns elsewhere in this rollout. The column, its FK, and every read site
-- still keyed off it are removed together in PR-D2.
--
-- IDEMPOTENT: every backfill is guarded by "walkthrough_id IS NULL"; DROP INDEX / constraint
--   changes use IF EXISTS / IF NOT EXISTS so a second run on the shared staging DB is a no-op.
-- PORTABLE: no Supabase-only objects touched by this migration at all.

-- ─── Backfill any walkthrough_id still NULL ──────────────────────────────────
-- PR-A2's own comment: rows created by app code between that migration and PR-B2's deploy still
-- write lead_id only - that interim window is expected. Same join PR-A2 used (at most one
-- walkthrough row per lead still holds at this point, since PR-B2's own multi-visit code path has
-- not run against this data yet).
UPDATE "lead_walkthrough_performers" lwp
SET "walkthrough_id" = w."id"
FROM "walkthroughs" w
WHERE w."lead_id" = lwp."lead_id"
  AND lwp."walkthrough_id" IS NULL;

-- Defensive: a performer row whose lead somehow still has NO walkthrough row at all (shouldn't
-- happen given PR-A2's own orphan-crew backfill, but guard rather than let the NOT NULL below fail).
INSERT INTO "walkthroughs" ("id", "organization_id", "lead_id", "status", "created_at", "updated_at")
SELECT gen_random_uuid(), lwp."organization_id", lwp."lead_id", 'REQUESTED'::"WalkthroughStatus", NOW(), NOW()
FROM "lead_walkthrough_performers" lwp
WHERE lwp."walkthrough_id" IS NULL
GROUP BY lwp."organization_id", lwp."lead_id";

UPDATE "lead_walkthrough_performers" lwp
SET "walkthrough_id" = w."id"
FROM "walkthroughs" w
WHERE w."lead_id" = lwp."lead_id"
  AND lwp."walkthrough_id" IS NULL;

-- ─── walkthrough_id: nullable → required ─────────────────────────────────────
ALTER TABLE "lead_walkthrough_performers" ALTER COLUMN "walkthrough_id" SET NOT NULL;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'lead_walkthrough_performers_walkthrough_id_fkey') THEN
    ALTER TABLE "lead_walkthrough_performers" ADD CONSTRAINT "lead_walkthrough_performers_walkthrough_id_fkey"
      FOREIGN KEY ("walkthrough_id") REFERENCES "walkthroughs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

-- ─── Unique constraint: (lead_id, user_id) → (walkthrough_id, user_id) ───────
-- Both sides of this swap were originally materialized by Prisma as plain unique INDEXES (see
-- 20260610120000_assignment_m2m_additive), not named table constraints, so they are dropped/created
-- as indexes here too.
DROP INDEX IF EXISTS "lead_walkthrough_performers_lead_id_user_id_key";
CREATE UNIQUE INDEX IF NOT EXISTS "lead_walkthrough_performers_walkthrough_id_user_id_key"
  ON "lead_walkthrough_performers" ("walkthrough_id", "user_id");

-- ─── Plain index housekeeping (so `prisma migrate diff` sees no drift vs schema.prisma) ──────────
-- The standalone walkthrough_id index PR-A2 created is now redundant (the new unique index above
-- covers a leftmost walkthrough_id lookup); schema.prisma drops the bare @@index([walkthrough_id])
-- in favor of @@index([lead_id]), which lost its own covering index when the unique constraint
-- moved off (lead_id, user_id).
DROP INDEX IF EXISTS "lead_walkthrough_performers_walkthrough_id_idx";
CREATE INDEX IF NOT EXISTS "lead_walkthrough_performers_lead_id_idx" ON "lead_walkthrough_performers" ("lead_id");
