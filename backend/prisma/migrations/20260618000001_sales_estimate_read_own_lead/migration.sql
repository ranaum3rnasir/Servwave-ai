-- RBAC F-004 — converge the default SALES `read Estimate` grant onto OWN_LEAD scope.
-- Mirrors defaultGrants.ts: `{ role:'SALES', action:'read', subject:'Estimate' }` gains
--   conditions = OWN_ESTIMATE_VIA_LEAD ({ lead: { lead_assignees: { some: { user_id }}}}).
--
-- ⚠️ OWNER-APPLIED OUT OF BAND. This is a DATA migration that rewrites persisted role_permissions
--    rows for EXISTING organizations. The conductor/agents NEVER run it. Apply to STAGING first,
--    verify, then PROD on promotion.
--
-- WHY: until F-004, SALES `read Estimate` was UNCONDITIONAL and the estimate controller scoped
--    SALES to its own leads with hardcoded `role === 'SALES'` literals. F-004 moves that scope INTO
--    the grant (consistent with SALES read Lead/Job/Invoice — all already OWN-conditioned) and
--    removes the literals. Effective grants are persisted role_permissions rows, NOT the
--    DEFAULT_GRANTS constant, so editing defaultGrants.ts only changes NEW orgs; existing orgs keep
--    the UNCONDITIONAL row until this migration catches them up.
--
-- ⚠️ DEPLOY COUPLING (fail-OPEN direction — read this): with the F-004 CODE deployed but this
--    migration NOT yet applied, an existing org's SALES users would read EVERY estimate in the org
--    (the literal that used to scope them is gone, and their persisted grant is still
--    unconditional). Therefore apply this BEFORE (or together with) deploying the F-004 code.
--    It is SAFE to apply EARLY: the PRE-F-004 code tolerates a conditioned SALES read-Estimate
--    grant (its literal re-applies the identical own-lead filter, so behavior is unchanged), so
--    applying ahead of the deploy does not affect the currently-running build. Do NOT deploy the
--    code first and apply this later — that is the fail-open window.
--
-- IDEMPOTENT + re-runnable on the shared staging DB: gated to rows that are still UNCONDITIONAL.
--    ⚠️ "Unconditional" is stored TWO ways in this DB, and BOTH must be caught:
--      * SQL NULL          — e.g. rows inserted with `conditions = NULL` (the tech-default migration).
--      * jsonb 'null'      — Prisma's JsonNull, how the org-seed wrote no-`conditions` grants.
--                            Verified on staging 2026-06-18: 27/28 SALES read-Estimate rows are
--                            jsonb 'null', 0 are SQL NULL — so a `conditions IS NULL`-only gate
--                            would convert NOTHING and leave SALES fail-OPEN after the code deploys.
--    A row that already carries a REAL condition — the own-lead target, OR a deliberately customized
--    team/location scope (staging has 1 such org) — is neither NULL nor 'null', so it is left
--    untouched. Re-run is a no-op (converted rows now hold the own-lead object).
UPDATE role_permissions
SET conditions = '{"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}}'::jsonb,
    updated_at = NOW()
WHERE role = 'SALES'
  AND action = 'read'
  AND subject = 'Estimate'
  AND (conditions IS NULL OR conditions = 'null'::jsonb);

-- VERIFY after applying — every previously-unconditional SALES read-Estimate grant should now be
-- own-lead scoped (deliberately-customized scopes — e.g. the 1 staging org with a team-scoped
-- condition — are intentionally left intact):
--   SELECT organization_id, conditions
--   FROM role_permissions
--   WHERE role = 'SALES' AND action = 'read' AND subject = 'Estimate';
--   -- expect {"lead":{"lead_assignees":{"some":{"user_id":"{{userId}}"}}}} for all but customized rows;
--   -- and ZERO rows with conditions NULL or 'null'::jsonb.
