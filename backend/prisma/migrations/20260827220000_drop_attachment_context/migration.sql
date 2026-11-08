-- Retire `attachments.context` -- 2026-08-27. Phase 2b, the CONTRACT half.
--
-- WHY.
--
-- `context` was very nearly a restatement of `entity_type`. Measured on production across all
-- 2,820 rows, each entity type carried exactly one context value -- JOB/`JOB_WORK` 829,
-- INVOICE/`OTHER` 955, LEAD/`OTHER` 604 plus `WALKTHROUGH` 20 -- and the lead, the only entity
-- with a split, already rendered every value of it through `showAllContexts`. So the column
-- never distinguished anything a reader acted on. What it DID do was drive a per-context upload
-- control on a generic panel, which is how files came to be filed under contexts belonging to
-- other surfaces (#1834, and the estimate rows moved in 20260827120000).
--
-- The four photo contexts -- BEFORE_PHOTO / DURING_PHOTO / AFTER_PHOTO / ISSUE_PHOTO -- have
-- ZERO rows in production and never had any. `deriveJobInsights` keyed a warning on
-- `context = 'AFTER_PHOTO'`, so that warning was pinned ON for every IN_PROGRESS/COMPLETED job
-- (7,399 of them) and no upload could ever clear it; being ANDed into the photos check, it also
-- denied those same jobs credit for the photos they did have. #1862 removed it rather than
-- repairing it: once `context` is gone an after-photo is indistinguishable from any other image.
--
-- ORDER OF OPERATIONS -- THIS IS THE HALF THAT CAN BREAK A DEPLOY.
--
-- Expand/contract across two releases. #1862 (the EXPAND half) stopped every code path reading
-- or writing this column and shipped on its own; it reached `main` in #1867. This file is the
-- CONTRACT half and must NOT reach an environment whose backend still SELECTs `context`.
-- Render's startCommand is `prisma migrate deploy && node dist/index.js`, so the migration lands
-- while the PREVIOUS instance is still serving -- and that instance would 500 on every
-- attachment read. Confirm the target environment is already running #1862's code before
-- promoting this. See memory `learning-staging-enum-drift-breaks-untyped-and-typed-queries`.
--
-- ROLLBACK.
--
-- Every row's value is copied into `_attachment_context_backup` BEFORE the column is dropped,
-- so the column is restorable:
--
--     CREATE TYPE "AttachmentContext" AS ENUM
--       ('WALKTHROUGH','JOB_WORK','ESTIMATE','OTHER',
--        'BEFORE_PHOTO','DURING_PHOTO','AFTER_PHOTO','ISSUE_PHOTO');
--     ALTER TABLE attachments ADD COLUMN context "AttachmentContext" NOT NULL DEFAULT 'OTHER';
--     UPDATE attachments a SET context = b.prior_context::"AttachmentContext"
--     FROM _attachment_context_backup b WHERE b.attachment_id = a.id;
--
-- The captured value is the enum label verbatim, so that cast round-trips exactly.
--
-- NOT DROPPED HERE: `_attachment_estimate_repoint_backup`, the Phase 1 artifact. Its own header
-- says to drop it in Phase 2, but it is the only record of where those 412 files used to hang
-- and it costs one small table to keep. Removing it is a separate, deliberate decision.
--
-- IDEMPOTENCE. Re-running is a no-op: the capture is guarded on the column still existing and is
-- `ON CONFLICT DO NOTHING`; the DROP COLUMN and DROP TYPE are both `IF EXISTS`.
-- PORTABILITY. No Supabase-only objects, roles or `auth.*`. On CI's vanilla postgres:16 the
-- table is empty, so the capture inserts nothing and the drops still run.

-- 1. Capture the rollback artifact BEFORE dropping anything. Guarded on the column still being
--    present, so a second run does not error against a table that no longer has it.
CREATE TABLE IF NOT EXISTS "_attachment_context_backup" (
  "attachment_id" uuid PRIMARY KEY,
  "prior_context" text NOT NULL,
  "captured_at"   timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'attachments'
      AND column_name = 'context'
  ) THEN
    EXECUTE '
      INSERT INTO "_attachment_context_backup" ("attachment_id", "prior_context")
      SELECT "id", "context"::text FROM "attachments"
      ON CONFLICT ("attachment_id") DO NOTHING
    ';
  END IF;
END $$;

-- 2. Drop the column, then the enum type it was the only user of.
ALTER TABLE "attachments" DROP COLUMN IF EXISTS "context";

DROP TYPE IF EXISTS "AttachmentContext";
