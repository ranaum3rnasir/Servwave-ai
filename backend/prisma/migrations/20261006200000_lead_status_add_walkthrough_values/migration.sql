-- Adds the two walkthrough lead statuses back, in pipeline position, before ESTIMATED.
-- Nothing in this file uses the new values, so it is safe inside the deploy transaction.
-- The July drop migration (20260729100000_lead_status_drop_walkthrough_values) removed them; this
-- re-adds them. Moving existing leads onto them is a separate, later migration, because a new enum
-- value cannot be used in the same transaction that adds it.
-- Idempotent (IF NOT EXISTS) and portable to plain PostgreSQL 16.
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'WALKTHROUGH_SCHEDULED' BEFORE 'ESTIMATED';
ALTER TYPE "LeadStatus" ADD VALUE IF NOT EXISTS 'WALKTHROUGH_COMPLETED' BEFORE 'ESTIMATED';
