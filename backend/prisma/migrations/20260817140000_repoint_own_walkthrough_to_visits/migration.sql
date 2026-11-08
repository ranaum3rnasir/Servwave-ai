-- Multi-visit spec slice S1 follow-through: repoint the stored OWN_WALKTHROUGH row-scope
-- condition onto the renamed relations.
--
-- WHY THIS IS A SEPARATE STEP: TECHNICIAN's `read Lead` and `perform_walkthrough Lead`
-- grants carry their row-scope as JSONB in role_permissions.conditions, naming the Prisma
-- relation path by string. 20260817130000 renamed walkthroughs -> visits and
-- lead_walkthrough_performers -> visit_assignees, but an ALTER TABLE ... RENAME cannot
-- reach inside a JSONB value, so those rows kept pointing at relations that no longer
-- exist on Lead - scopeWhereFor would build a Prisma `where` against a dead path and
-- throw. Same class as the saved-filter rewrite in 20260817120000, and the same repair
-- shape as 20260729095000, which fixed this identical drift for the previous rename.
--
-- Caught by check-role-permission-drift.ts --strict in CI, not by the unit suites, which
-- read DEFAULT_GRANTS from code rather than the seeded rows.
--
-- NOT FILTERED BY ROLE, unlike 20260729095000: staging also holds CUSTOM roles cloned
-- from TECHNICIAN carrying the byte-identical dead path. The drift checker only compares
-- the built-in roles, so those rows would have stayed broken and silent. Matching on the
-- condition value alone is safe here precisely because this is a pure relation-path
-- rename: any row holding that exact path means the same thing before and after, and a
-- genuinely customized condition does not match and is left untouched.
--
-- IDEMPOTENT: matches the exact historical value, so an already-repaired row no longer
-- matches. PORTABLE: plain UPDATE, no Supabase-only constructs.

UPDATE role_permissions
SET conditions = '{"visits":{"some":{"assignees":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb,
    updated_at = NOW()
WHERE conditions = '{"walkthroughs":{"some":{"performers":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb;
