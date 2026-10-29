-- Three trigger types the hard-coded → Automation Center migration needs: a
-- technician marked en route, a technician removed from a job, a walkthrough
-- performer removed. The removal pair need a recipient the LIVE entity can no
-- longer supply (they're off the record by the time the automation runs), so
-- event_payload carries what the triggering event captured — same mechanism
-- also used for request-time text like a cancellation reason.
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'WALKTHROUGH_PERFORMER_REMOVED';
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'TECH_UNASSIGNED';
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'JOB_EN_ROUTE';

ALTER TABLE "workflow_enrollments" ADD COLUMN IF NOT EXISTS "event_payload" JSONB;
