-- Lead service location is OPTIONAL (a lead may have no location; a job still requires one).
-- Idempotent: DROP NOT NULL is a no-op if the column is already nullable. On prod the
-- column never gets NOT NULL because D2 line 20 is skipped during cutover (see Part B);
-- this still runs there (recorded, no-op) so prod and staging migration history match.
ALTER TABLE "leads" ALTER COLUMN "service_location_id" DROP NOT NULL;
