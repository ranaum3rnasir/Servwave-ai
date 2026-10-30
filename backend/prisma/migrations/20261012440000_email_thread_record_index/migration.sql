-- Roles & Permissions, PRD 10 (S10.9 fix): the record a record conversation is about, found by the record.
--
-- The Email page lists a record conversation to the people of its job or lead (lib/communication/recordPeopleThreads.ts).
-- That read starts from the records the person is on and asks the conversations of those records, so it looks a
-- conversation up by (record_type, record_id). Without an index the database reads every conversation of the company
-- for each poll of the Email menu badge; with it, one probe per record. Measured on a seeded company of 200,000
-- conversations: 24 ms -> 4 ms for the whole read.
--
-- An index only. No column, no row and no foreign key changes: record_id names a row of whichever table record_type
-- says, so it can never carry a foreign key.
--
-- IDEMPOTENT + portable plain PostgreSQL. Runs on CI's vanilla postgres:16, on the Render deploy, and possibly twice
-- against the shared staging DB. NEVER run `prisma migrate` from a worktree.

CREATE INDEX IF NOT EXISTS "email_threads_record_type_record_id_idx" ON "email_threads"("record_type", "record_id");
