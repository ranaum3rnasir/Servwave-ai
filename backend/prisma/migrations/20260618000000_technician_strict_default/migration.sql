-- RBAC Phase B — TECHNICIAN strict default + `perform_walkthrough` capability.
--
-- ⚠️ OWNER-APPLIED OUT OF BAND. This is a DATA migration that rewrites persisted
--    role_permissions rows for EXISTING organizations. The conductor/agents NEVER run it.
--    Apply to STAGING first, verify, then to PROD on promotion. Co-deployed with the code
--    that re-gates the two walkthrough-performer routes to `perform_walkthrough`
--    (backend/src/routes/lead.routes.ts) and the strict TECHNICIAN block in
--    backend/src/lib/permissions/defaultGrants.ts (the source of truth this SQL mirrors).
--
-- WHY a data migration: effective grants are persisted role_permissions rows, NOT the
--    DEFAULT_GRANTS constant. Editing defaultGrants.ts only changes NEW orgs (org-create seed)
--    and explicit role-resets. Existing orgs keep their persisted rows until a migration like
--    this catches them up.
--
-- CONDITION SHAPE: after 20260610120100_assignment_backfill_supersede_drop, every existing
--    org's conditions use the crew/join shape (walkthrough_performers / lead_assignees /
--    assignees), matching defaultGrants.ts. This file mirrors that shape verbatim.
--
-- IDEMPOTENT + re-runnable on the shared staging DB:
--    * Part 1 DELETE is naturally idempotent (re-run removes nothing — rows already gone) and
--      is GATED to orgs still on the OLD technician default so hand-customized orgs are left
--      untouched.
--    * Part 2 INSERT uses ON CONFLICT DO NOTHING.

-- ─── Part 1: remove the now-dropped TECHNICIAN grants from orgs still on the OLD default ───
-- Phase B strips these capabilities from the TECHNICIAN role default (each is now an opt-in
-- per-user toggle, never a role default):
--   update Lead, create Job, update Job, en_route/arrive/start/complete Job,
--   create Invoice, read Invoice, record_payment Invoice, update Attachment, delete Attachment.
--
-- "Still on the OLD default" = the org's TECHNICIAN grant set still contains BOTH legacy
-- signature rows that Phase B removes and that no strict/customized setup would keep:
--   (TECHNICIAN, update, Lead)  AND  (TECHNICIAN, create, Job).
-- Gating on these two protects deliberately hand-customized orgs (which would have already
-- dropped the broad lead-write / job-create grants) from being clobbered. The DELETE keys on
-- (organization_id, role, action, subject) — conditions are intentionally NOT matched, because
-- the unique key is (org, role, action, subject) and the condition JSON has drifted across the
-- migration history; matching the key alone is exact and safe.
DELETE FROM role_permissions rp
WHERE rp.role = 'TECHNICIAN'
  AND (rp.action, rp.subject) IN (
    ('update',         'Lead'),
    ('create',         'Job'),
    ('update',         'Job'),
    ('en_route',       'Job'),
    ('arrive',         'Job'),
    ('start',          'Job'),
    ('complete',       'Job'),
    ('create',         'Invoice'),
    ('read',           'Invoice'),
    ('record_payment', 'Invoice'),
    ('update',         'Attachment'),
    ('delete',         'Attachment')
  )
  AND EXISTS (
    SELECT 1 FROM role_permissions sig
    WHERE sig.organization_id = rp.organization_id
      AND sig.role = 'TECHNICIAN' AND sig.action = 'update' AND sig.subject = 'Lead'
  )
  AND EXISTS (
    SELECT 1 FROM role_permissions sig
    WHERE sig.organization_id = rp.organization_id
      AND sig.role = 'TECHNICIAN' AND sig.action = 'create' AND sig.subject = 'Job'
  );

-- ─── Part 2: add the new `perform_walkthrough Lead` grants for every existing org ───
-- The two walkthrough-performer routes (POST /:id/walkthrough, POST /:id/walkthrough/complete)
-- now require `perform_walkthrough` instead of the broad `update Lead`. Seed the capability for
-- the three non-admin roles so they keep walkthrough access (ADMIN passes via code-level
-- "manage all", so it gets no row). Conditions mirror defaultGrants.ts (crew/join shape):
--   TECHNICIAN -> own walkthrough  (walkthrough_performers ∋ me)
--   SALES      -> own lead         (lead_assignees ∋ me)
--   DISPATCHER -> unconditional
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
  ('TECHNICIAN','perform_walkthrough','Lead','{"walkthrough_performers":{"some":{"user_id":"{{userId}}"}}}'),
  ('SALES','perform_walkthrough','Lead','{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}'),
  ('DISPATCHER','perform_walkthrough','Lead',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
