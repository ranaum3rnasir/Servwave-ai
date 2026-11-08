-- CreateTable
CREATE TABLE "role_permissions" (
    "id" UUID NOT NULL,
    "organization_id" UUID NOT NULL,
    "role" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "conditions" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_permissions_organization_id_role_idx" ON "role_permissions"("organization_id", "role");

-- CreateIndex
CREATE UNIQUE INDEX "role_permissions_organization_id_role_action_subject_key" ON "role_permissions"("organization_id", "role", "action", "subject");

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill default grants for every existing organization
-- Each org gets the full default grant set for SALES, DISPATCHER, TECHNICIAN.
-- ADMIN has no rows — admin access is managed in code via manage all.
-- This is idempotent via ON CONFLICT DO NOTHING.
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
  -- SALES
  ('SALES','read','Dashboard',NULL),
  ('SALES','read','Customer',NULL),
  ('SALES','update','Customer',NULL),
  ('SALES','export','Customer',NULL),
  ('SALES','create','Lead',NULL),
  ('SALES','read','Lead','{"assigned_to":"{{userId}}"}'),
  ('SALES','update','Lead','{"assigned_to":"{{userId}}"}'),
  ('SALES','contact','Lead','{"assigned_to":"{{userId}}"}'),
  ('SALES','mark_lost','Lead','{"assigned_to":"{{userId}}"}'),
  ('SALES','cancel','Lead','{"assigned_to":"{{userId}}"}'),
  ('SALES','schedule_walkthrough','Lead','{"assigned_to":"{{userId}}"}'),
  ('SALES','be_assigned','Lead',NULL),
  ('SALES','perform','Walkthrough',NULL),
  ('SALES','create','Estimate',NULL),
  ('SALES','read','Estimate',NULL),
  ('SALES','update','Estimate',NULL),
  ('SALES','delete','Estimate',NULL),
  ('SALES','send','Estimate',NULL),
  ('SALES','cancel','Estimate',NULL),
  ('SALES','duplicate','Estimate',NULL),
  ('SALES','read','Job','{"estimate":{"lead":{"assigned_to":"{{userId}}"}}}'),
  ('SALES','read','Invoice','{"job":{"estimate":{"lead":{"assigned_to":"{{userId}}"}}}}'),
  ('SALES','read','PriceBook',NULL),
  ('SALES','create','PriceBook',NULL),
  ('SALES','update','PriceBook',NULL),
  ('SALES','delete','PriceBook',NULL),
  ('SALES','read','Tag',NULL),
  ('SALES','create','Tag',NULL),
  ('SALES','read','Department',NULL),
  ('SALES','read','StateTaxRate',NULL),
  ('SALES','read','AppSetting',NULL),
  ('SALES','read','Organization',NULL),
  ('SALES','create','Attachment',NULL),
  ('SALES','read','Attachment',NULL),
  ('SALES','update','Attachment',NULL),
  ('SALES','delete','Attachment',NULL),
  -- DISPATCHER
  ('DISPATCHER','read','Dashboard',NULL),
  ('DISPATCHER','create','Customer',NULL),
  ('DISPATCHER','read','Customer',NULL),
  ('DISPATCHER','update','Customer',NULL),
  ('DISPATCHER','delete','Customer',NULL),
  ('DISPATCHER','export','Customer',NULL),
  ('DISPATCHER','create','Lead',NULL),
  ('DISPATCHER','read','Lead',NULL),
  ('DISPATCHER','update','Lead',NULL),
  ('DISPATCHER','assign','Lead',NULL),
  ('DISPATCHER','contact','Lead',NULL),
  ('DISPATCHER','mark_lost','Lead',NULL),
  ('DISPATCHER','cancel','Lead',NULL),
  ('DISPATCHER','schedule_walkthrough','Lead',NULL),
  ('DISPATCHER','perform','Walkthrough',NULL),
  ('DISPATCHER','read','Estimate',NULL),
  ('DISPATCHER','record_payment','Estimate',NULL),
  ('DISPATCHER','waive_deposit','Estimate',NULL),
  ('DISPATCHER','reactivate_deposit','Estimate',NULL),
  ('DISPATCHER','create','Job',NULL),
  ('DISPATCHER','read','Job',NULL),
  ('DISPATCHER','update','Job',NULL),
  ('DISPATCHER','delete','Job',NULL),
  ('DISPATCHER','assign','Job',NULL),
  ('DISPATCHER','unassign','Job',NULL),
  ('DISPATCHER','en_route','Job',NULL),
  ('DISPATCHER','arrive','Job',NULL),
  ('DISPATCHER','start','Job',NULL),
  ('DISPATCHER','complete','Job',NULL),
  ('DISPATCHER','cancel','Job',NULL),
  ('DISPATCHER','create','Invoice',NULL),
  ('DISPATCHER','read','Invoice',NULL),
  ('DISPATCHER','update','Invoice',NULL),
  ('DISPATCHER','delete','Invoice',NULL),
  ('DISPATCHER','send','Invoice',NULL),
  ('DISPATCHER','record_payment','Invoice',NULL),
  ('DISPATCHER','read','PriceBook',NULL),
  ('DISPATCHER','read','Tag',NULL),
  ('DISPATCHER','create','Tag',NULL),
  ('DISPATCHER','read','Department',NULL),
  ('DISPATCHER','read','Report',NULL),
  ('DISPATCHER','read','StateTaxRate',NULL),
  ('DISPATCHER','read','AppSetting',NULL),
  ('DISPATCHER','read','Organization',NULL),
  ('DISPATCHER','create','Attachment',NULL),
  ('DISPATCHER','read','Attachment',NULL),
  ('DISPATCHER','update','Attachment',NULL),
  ('DISPATCHER','delete','Attachment',NULL),
  -- TECHNICIAN
  ('TECHNICIAN','read','Lead','{"walkthrough_assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','update','Lead','{"walkthrough_assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','perform','Walkthrough',NULL),
  ('TECHNICIAN','create','Job',NULL),
  ('TECHNICIAN','read','Job','{"assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','update','Job','{"assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','en_route','Job','{"assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','arrive','Job','{"assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','start','Job','{"assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','complete','Job','{"assigned_to":"{{userId}}"}'),
  ('TECHNICIAN','be_assigned','Job',NULL),
  ('TECHNICIAN','create','Invoice',NULL),
  ('TECHNICIAN','read','Invoice','{"job":{"assigned_to":"{{userId}}"}}'),
  ('TECHNICIAN','record_payment','Invoice','{"job":{"assigned_to":"{{userId}}"}}'),
  ('TECHNICIAN','read','Department',NULL),
  ('TECHNICIAN','read','AppSetting',NULL),
  ('TECHNICIAN','read','Organization',NULL),
  ('TECHNICIAN','create','Attachment',NULL),
  ('TECHNICIAN','read','Attachment',NULL),
  ('TECHNICIAN','update','Attachment',NULL),
  ('TECHNICIAN','delete','Attachment',NULL)
) AS g(role, action, subject, conditions)
ON CONFLICT (organization_id, role, action, subject) DO NOTHING;
