-- Backfill the DISPATCHER `read User` grant for every existing organization (PR B / scheduler board).
--
-- Root cause: GET /api/users is guarded by canDo('read','User'); no DISPATCHER User grant ever
-- existed, so dispatchers got 403 fetching the board roster. The grant was added to
-- DEFAULT_GRANTS (covers new orgs + role-reset); this catches up existing orgs.
--
-- conditions are NULL (the dispatcher reads the whole roster, not own-scoped).
-- Idempotent via ON CONFLICT DO NOTHING. Co-deployed with the code that relies on it.
-- 'User' is not a roleViewModel module → not in MANAGED_KEYS → a roles-save will not strip it.
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
  ('DISPATCHER','read','User',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
