-- #3104 (B7 follow-up): the lead's general note, and who last edited a note. SCHEMA ONLY, additive.
--
--   notes.is_general  true on a lead's GENERAL note (the one the new-lead form's Notes box writes and the Edit lead form
--                     edits in place), null on every other note.
--   notes.edited_by   who last edited the note (a person; set to null if that person's row is ever deleted).
--   notes.edited_at   when.
--   notes_one_general_per_record
--                     at most one general note per record. Partial, so Prisma's schema cannot express it (see
--                     leads_open_org_idx for the earlier example); this file is where it lives, and
--                     `prisma migrate diff` against the schema lists it as a drop. `prisma migrate status` (what CI
--                     checks) reads only the migration history.
--
-- No existing column is changed and nothing is dropped. Moving the text already saved in leads.notes is the NEXT migration,
-- on its own (20261104120100_lead_notes_to_general_note).
--
-- IDEMPOTENT: every step is skipped when it is already there. Portable plain PostgreSQL: no Supabase-only objects, no
-- secrets. NEVER run `prisma migrate` from a worktree.

ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "is_general" BOOLEAN;
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "edited_by" UUID;
ALTER TABLE "notes" ADD COLUMN IF NOT EXISTS "edited_at" TIMESTAMP(3);

DO $notes_edited_by_fk$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notes_edited_by_fkey') THEN
    ALTER TABLE "notes" ADD CONSTRAINT "notes_edited_by_fkey"
      FOREIGN KEY ("edited_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END
$notes_edited_by_fk$;

CREATE UNIQUE INDEX IF NOT EXISTS "notes_one_general_per_record"
  ON "notes" ("entity_type", "entity_id")
  WHERE "is_general" = true;
