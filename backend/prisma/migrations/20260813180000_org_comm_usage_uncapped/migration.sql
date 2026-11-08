-- Per-org exemption from the included calling/texting allowance
-- (backend/src/lib/comm-usage.ts). When true the Phone usage meters report
-- usage with no limit, no percentage and no "approaching limit" banner, and any
-- future enforcement skips the org.
--
-- Defaults to false so every existing org keeps the standard allowance; the
-- house orgs are switched on deliberately as a data step after deploy, never
-- from this file (a migration that names specific organizations would not be
-- portable across staging, prod and CI's empty database).
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "comm_usage_uncapped" BOOLEAN NOT NULL DEFAULT false;
