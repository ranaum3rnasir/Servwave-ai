-- Repair the OWN_WALKTHROUGH condition drift introduced earlier in this PR
-- (defaultGrants.ts's re-expression of OWN_WALKTHROUGH as a nested relation predicate
-- through the new Walkthrough table).
--
-- WHAT WAS WRONG: TECHNICIAN's `read Lead` and `perform_walkthrough Lead` grants were
-- seeded with the pre-redesign condition
-- {"walkthrough_performers":{"some":{"user_id":"{{userId}}"}}}, which keyed off
-- LeadWalkthroughPerformer.lead_id (dropped by
-- 20260729090000_walkthrough_performer_repoint_v2). defaultGrants.ts now expresses the
-- same ownership check through the new join: Lead -> walkthroughs[] -> performers[] ->
-- user_id. The live role_permissions rows were never backfilled to match, so
-- scopeWhereFor's Prisma `where` would build against a relation that no longer exists on
-- Lead - caught by check-role-permission-drift.ts --strict in CI.
--
-- THE FIX: repoint to the real relation path, matching the
-- notification.recipients.some idiom already used by
-- 20260722010000_repair_notification_grant_conditions for the identical class of drift.
--
-- IDEMPOTENT: matches on the exact historical condition value and the (role, subject,
-- action) tuple, so a row already repaired (or one a per-org customization deliberately
-- diverged from the default) no longer matches and is left untouched. Re-running is a
-- no-op.
-- PORTABLE: plain UPDATE, no Supabase-only constructs.

UPDATE role_permissions
SET conditions = '{"walkthroughs":{"some":{"performers":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'TECHNICIAN'
  AND subject = 'Lead'
  AND action IN ('read', 'perform_walkthrough')
  AND conditions = '{"walkthrough_performers":{"some":{"user_id":"{{userId}}"}}}'::jsonb;
