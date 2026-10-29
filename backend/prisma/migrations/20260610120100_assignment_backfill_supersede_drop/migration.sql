-- PR A — backfill the M2M joins + commission_owner from the legacy FK columns, supersede the
-- redesign_11 CASL JSONB to the crew shape, THEN drop the 4 FK columns. Idempotent + nullable-safe.
-- Co-deployed with the new CASL/controller code (which already reads the crew shape).
-- Runs AFTER 20260610120000_assignment_m2m_additive (which creates the join tables).
-- Verified 2026-06-10 against the live shared-staging role_permissions rows: the bare
-- {"assigned_to":"{{userId}}"} shape exists on BOTH Lead and Job subjects, so the two Owned
-- UPDATEs MUST be subject-qualified (or the first would consume the other's rows).

-- ── 1. Backfill the joins from the single FKs (NOT EXISTS guards = re-runnable) ──
INSERT INTO job_assignees (id, job_id, user_id, organization_id, created_at)
SELECT gen_random_uuid(), j.id, j.assigned_to, j.organization_id, NOW()
FROM jobs j
WHERE j.assigned_to IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM job_assignees ja WHERE ja.job_id = j.id AND ja.user_id = j.assigned_to);

INSERT INTO lead_assignees (id, lead_id, user_id, organization_id, created_at)
SELECT gen_random_uuid(), l.id, l.assigned_to, l.organization_id, NOW()
FROM leads l
WHERE l.assigned_to IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM lead_assignees la WHERE la.lead_id = l.id AND la.user_id = l.assigned_to);

INSERT INTO lead_walkthrough_performers (id, lead_id, user_id, organization_id, created_at)
SELECT gen_random_uuid(), l.id, l.walkthrough_assigned_to, l.organization_id, NOW()
FROM leads l
WHERE l.walkthrough_assigned_to IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM lead_walkthrough_performers lp WHERE lp.lead_id = l.id AND lp.user_id = l.walkthrough_assigned_to);

-- Job.walkthrough_assigned_to is DROPPED WITH NO DESTINATION (urgent flow retired — intentional data loss).

-- ── 2. Backfill commission_owner_id from the old lead owner (Decision #5 — data continuity) ──
UPDATE leads SET commission_owner_id = assigned_to
WHERE assigned_to IS NOT NULL AND commission_owner_id IS NULL;

-- ── 3. Supersede redesign_11's CASL JSONB → crew shape, ALL orgs (idempotent: re-run is a no-op
--       because the post-state row no longer matches the WHERE). Mirror defaultGrants.ts verbatim. ──
-- OWN_LEAD vs OWN_JOB share the bare {"assigned_to":"{{userId}}"} value (the JSONB has no
-- subject discriminator) → BOTH UPDATEs MUST be subject-qualified or the first consumes the other's rows.
UPDATE role_permissions SET conditions = '{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb
  WHERE conditions = '{"assigned_to":"{{userId}}"}'::jsonb AND subject = 'Lead';
UPDATE role_permissions SET conditions = '{"assignees":{"some":{"user_id":"{{userId}}"}}}'::jsonb
  WHERE conditions = '{"assigned_to":"{{userId}}"}'::jsonb AND subject = 'Job';
UPDATE role_permissions SET conditions = '{"estimate":{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}}'::jsonb
  WHERE conditions = '{"estimate":{"lead":{"assigned_to":"{{userId}}"}}}'::jsonb;
UPDATE role_permissions SET conditions = '{"job":{"assignees":{"some":{"user_id":"{{userId}}"}}}}'::jsonb
  WHERE conditions = '{"job":{"assigned_to":"{{userId}}"}}'::jsonb;
UPDATE role_permissions SET conditions = '{"job":{"estimate":{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}}}'::jsonb
  WHERE conditions = '{"job":{"estimate":{"lead":{"assigned_to":"{{userId}}"}}}}'::jsonb;
UPDATE role_permissions SET conditions = '{"walkthrough_performers":{"some":{"user_id":"{{userId}}"}}}'::jsonb
  WHERE conditions = '{"walkthrough_assigned_to":"{{userId}}"}'::jsonb;
-- Delete the now-removed eligibility grant rows (be_assigned / perform) for every org.
DELETE FROM role_permissions WHERE action IN ('be_assigned','perform');

-- ── 4. DROP the four FK columns (irreversible) — AFTER the backfill above ──
DROP INDEX IF EXISTS "leads_assigned_to_idx";
DROP INDEX IF EXISTS "leads_walkthrough_assigned_to_idx";
DROP INDEX IF EXISTS "jobs_assigned_to_idx";
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_assigned_to_fkey";
ALTER TABLE "leads" DROP CONSTRAINT IF EXISTS "leads_walkthrough_assigned_to_fkey";
ALTER TABLE "jobs"  DROP CONSTRAINT IF EXISTS "jobs_assigned_to_fkey";
ALTER TABLE "jobs"  DROP CONSTRAINT IF EXISTS "jobs_walkthrough_assigned_to_fkey";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "assigned_to";
ALTER TABLE "leads" DROP COLUMN IF EXISTS "walkthrough_assigned_to";
ALTER TABLE "jobs"  DROP COLUMN IF EXISTS "assigned_to";
ALTER TABLE "jobs"  DROP COLUMN IF EXISTS "walkthrough_assigned_to";
