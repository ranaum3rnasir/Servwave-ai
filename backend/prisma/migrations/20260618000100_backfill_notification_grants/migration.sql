-- Backfill Notification CASL grants for every existing organization.
-- The Notification subject ships in this feature; ADMIN reaches it via code-level "manage all",
-- but SALES/DISPATCHER/TECHNICIAN need explicit role_permissions rows (own-row inbox access).
-- Canonical grant set lives in defaultGrants.ts; this SQL must mirror it (pinned by
-- backend/src/__tests__/permissions-notification-backfill.test.ts).
-- Idempotent via ON CONFLICT DO NOTHING -- safe to re-run on the shared staging DB. Apply out-of-band (staging -> prod).
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
  ('SALES','read','Notification','{"recipient_id":"{{userId}}"}'),
  ('SALES','update','Notification','{"recipient_id":"{{userId}}"}'),
  ('SALES','delete','Notification','{"recipient_id":"{{userId}}"}'),
  ('DISPATCHER','read','Notification','{"recipient_id":"{{userId}}"}'),
  ('DISPATCHER','update','Notification','{"recipient_id":"{{userId}}"}'),
  ('DISPATCHER','delete','Notification','{"recipient_id":"{{userId}}"}'),
  ('TECHNICIAN','read','Notification','{"recipient_id":"{{userId}}"}'),
  ('TECHNICIAN','update','Notification','{"recipient_id":"{{userId}}"}'),
  ('TECHNICIAN','delete','Notification','{"recipient_id":"{{userId}}"}')
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
