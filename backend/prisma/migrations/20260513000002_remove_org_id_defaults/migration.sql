-- Remove DB DEFAULT on organization_id from 6 tenant-scoped tables.
-- After this migration, a missing organization_id in a CREATE will throw NOT NULL
-- instead of silently defaulting to Alpha. Forces every controller/seeder to set it
-- explicitly via req.user.organization_id (multi-tenant safety).
ALTER TABLE "users"     ALTER COLUMN "organization_id" DROP DEFAULT;
ALTER TABLE "customers" ALTER COLUMN "organization_id" DROP DEFAULT;
ALTER TABLE "leads"     ALTER COLUMN "organization_id" DROP DEFAULT;
ALTER TABLE "estimates" ALTER COLUMN "organization_id" DROP DEFAULT;
ALTER TABLE "jobs"      ALTER COLUMN "organization_id" DROP DEFAULT;
ALTER TABLE "invoices"  ALTER COLUMN "organization_id" DROP DEFAULT;
