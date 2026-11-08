-- Move every ESTIMATE-anchored attachment onto its originating lead -- 2026-08-27.
--
-- WHY.
--
-- An attachment belongs to a lead or to a job; the estimate is not a third home for files.
-- `AttachmentsPanel` mounted on an estimate offered a per-context upload control for every
-- context it knows ("Site Visit", "Job Documentation", "Estimate", "Other") regardless of the
-- entity it was actually on -- the same root cause as the lead defect fixed in #1834. This
-- file removes the data behind that surface; the same release removes the surface itself and
-- stops the API accepting `ESTIMATE` as an attachment entity at all.
--
-- Because the endpoint stops answering for `ESTIMATE` in this same release, any row left
-- behind with `entity_type = 'ESTIMATE'` becomes unreachable -- there is no longer a reader
-- that can return it. That is why the assertion at the bottom is a hard failure and not a
-- notice: a leftover row is a customer file that no surface can ever show again.
--
-- THE NUMBER THAT MATTERS, AND THE ONE THAT WAS WRONG.
--
-- The plan this implements said 340 of the 412 production rows were duplicates of a file the
-- lead already showed, and should therefore be DELETED. That was an artifact of the query,
-- not a property of the data: it joined estimate rows to lead rows on `file_url`, and
-- `file_url` is the EMPTY STRING on all 2,820 production attachment rows. The join was
-- `'' = ''`, so it matched every lead row that happened to exist and reported a duplicate
-- wherever the lead had any attachment at all.
--
-- `file_url` is vestigial: the column that identifies the stored object is `storage_path`
-- ("canonical bucket path; signed URLs are minted from this" -- schema.prisma), and
-- `buildAccessUrl()` mints a signed URL from it per request. Measured on production:
--
--     attachments rows                     2,820
--     rows with file_url = ''              2,820
--     rows with storage_path IS NULL           0
--     DISTINCT storage_path                2,820
--
-- Every row points at a distinct object. There are no duplicate files anywhere in the table,
-- on estimates or otherwise. So there is nothing to delete, and this migration DELETES
-- NOTHING -- it is a pure re-point. Confirmed with Ran before writing.
--
-- WHAT MOVES.
--
-- Production: 412 rows (396 `context='ESTIMATE'` from the 2026-07-10 bulk import, 16 real
-- `context='WALKTHROUGH'` uploads from 2026-08-14..18), across 317 leads, all in one tenant
-- (11111111-...). A lead gains 1.3 files on average; the most any single lead gains is 14.
-- Staging: 396 rows. On both databases every one of those rows joins an estimate that has a
-- `lead_id`, so nothing is stranded -- but see the assertion, because `estimates.lead_id` is
-- NULLABLE (relaxed in R6 for lead-less estimates) and that guarantee is data, not schema.
--
-- `context` is deliberately NOT rewritten. The lead's list mounts as
-- `<AttachmentSection ... showAllContexts />` (pages/v2/leads/LeadDetailPage.tsx), so it
-- renders every row regardless of context -- a moved row is visible the moment it lands, with
-- no normalisation needed. Leaving the value intact also keeps the backup table below a
-- complete record of the prior state, and Phase 2 retires the column outright.
--
-- A SECOND, INTENDED CONSEQUENCE.
--
-- `listAttachments` folds a job's originating LEAD's attachments into the job's own list with
-- no context filter (`include_lead=true`). So a moved file also becomes visible on that
-- lead's job. That is the point -- "attachments can either go to a lead or to a job" -- and it
-- is small in practice: only 5 of the 317 affected leads have a job today.
--
-- ROLLBACK.
--
-- The backup table below captures each moved row's id and its prior `entity_type`/`entity_id`
-- BEFORE the UPDATE, so the move is reversible with:
--
--     UPDATE attachments a
--     SET entity_type = b.prior_entity_type::"AttachmentEntity", entity_id = b.prior_entity_id
--     FROM _attachment_estimate_repoint_backup b
--     WHERE b.attachment_id = a.id;
--
-- The table is intentionally left in place after the migration; it is small (one row per moved
-- attachment) and it is the only record of where these files used to hang. Drop it in Phase 2
-- once the move has been observed to be good.
--
-- IDEMPOTENCE. Re-running is a no-op: the INSERT is `ON CONFLICT DO NOTHING` and selects only
-- rows that are still `ESTIMATE`, the UPDATE finds none, and the assertion passes on zero.
-- PORTABILITY. No Supabase-only objects, roles, or `auth.*` -- runs unchanged on CI's vanilla
-- postgres:16, where every table involved is empty and every statement is a no-op.

-- 1. Capture the rollback artifact BEFORE mutating anything.
CREATE TABLE IF NOT EXISTS "_attachment_estimate_repoint_backup" (
  "attachment_id"     uuid PRIMARY KEY,
  "prior_entity_type" text NOT NULL,
  "prior_entity_id"   uuid NOT NULL,
  "new_entity_id"     uuid NOT NULL,
  "captured_at"       timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "_attachment_estimate_repoint_backup"
  ("attachment_id", "prior_entity_type", "prior_entity_id", "new_entity_id")
SELECT a."id", a."entity_type"::text, a."entity_id", e."lead_id"
FROM "attachments" a
JOIN "estimates" e ON e."id" = a."entity_id"
WHERE a."entity_type" = 'ESTIMATE'
  AND e."lead_id" IS NOT NULL
ON CONFLICT ("attachment_id") DO NOTHING;

-- 2. Re-point. No DELETE: see the header -- there are no duplicates to collapse.
UPDATE "attachments" a
SET "entity_type" = 'LEAD',
    "entity_id"   = e."lead_id"
FROM "estimates" e
WHERE e."id" = a."entity_id"
  AND a."entity_type" = 'ESTIMATE'
  AND e."lead_id" IS NOT NULL;

-- 3. Assert the surface is empty. A survivor is an attachment on a lead-less estimate (or on
--    an estimate row that no longer exists) -- it has no lead to move to, and the API in this
--    same release stops serving `ESTIMATE`, so it would be permanently unreachable. Fail the
--    deploy rather than silently strand a customer's file. Zero such rows on production and
--    staging when this was written.
DO $$
DECLARE
  leftover integer;
BEGIN
  SELECT count(*) INTO leftover FROM "attachments" WHERE "entity_type" = 'ESTIMATE';
  IF leftover > 0 THEN
    RAISE EXCEPTION
      'estimate_attachments_to_lead: % attachment(s) still have entity_type=ESTIMATE and cannot be moved (their estimate has no lead_id, or no longer exists). Re-point them by hand before deploying -- the API no longer serves ESTIMATE attachments, so these files would be unreachable.',
      leftover;
  END IF;
END $$;
