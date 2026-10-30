-- Job cancel reason (Roles & Permissions, PRD 6, S06.15): the code of the reason a cancelled job was given.
--
-- One nullable text column on "jobs", beside cancelled_reason (which stays, as the optional note). The code is the stable
-- key of a row in the org's job cancel-reasons list (job_cancel_reason_options, or one of the six built-ins an org that
-- never edited the list resolves to in code), so there is no foreign key: a built-in has no row to point at. Reads resolve
-- the label from the code at read time.
--
-- No backfill, on purpose (PRD 6): a job cancelled before this release keeps its written reason as the note and gets no
-- code; no old cancel is re-labelled. A reopen (S06.16) clears the column with the other cancel fields.
--
-- Safe while the PREVIOUS backend is still serving for the few minutes after Render applies this file: the column is only
-- added, nullable, with no default, and that backend never reads or writes it.
--
-- Idempotent and portable per .claude/skills/writing-migrations: ADD COLUMN IF NOT EXISTS, nothing Supabase-only.

ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "cancel_reason_code" TEXT;
