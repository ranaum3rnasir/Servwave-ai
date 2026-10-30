-- S02.12 (Roles & Permissions, PRD 2, "Change log"): the change log can name the role a row is about, and carry a row
-- that is not about one switch.
--
--   role_label  The name of the role a "role assigned" row gave the person, or the role a "save as role" row made them
--               a member of, as it was called when the row was written (a log keeps the name it was written with).
--               Rows written before this column existed hold NULL and read as the reason alone.
--   switch_key  Now nullable. A "save as role" writes one row with no switch on the new role's log and on the person's
--               log, so the log shows the event even when no switch value moved.
--
-- Both statements are safe to run twice. Nothing is deleted or rewritten.
ALTER TABLE "permission_change_log" ADD COLUMN IF NOT EXISTS "role_label" TEXT;
ALTER TABLE "permission_change_log" ALTER COLUMN "switch_key" DROP NOT NULL;
