-- Drop job_source from leads (no backfill per design decision)
ALTER TABLE "leads" DROP COLUMN "job_source";

-- Add per-org editable dropdown lists to organizations
ALTER TABLE "organizations"
  ADD COLUMN "source_options" JSONB NOT NULL DEFAULT '["Google","Referral","Facebook","Instagram","Yelp","Direct Mail","Door Hanger","Other"]',
  ADD COLUMN "job_type_options" JSONB NOT NULL DEFAULT '["HVAC Service","HVAC Install","Plumbing","Electrical","General Maintenance","Other"]';
