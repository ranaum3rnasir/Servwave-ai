-- #2030 slice 1 — the send-time snapshot becomes a complete document record.
--
-- Two ADDITIVE nullable columns. Safe across a deploy overlap in both directions: the old
-- instance's queries enumerate the old column list, which still exists, and the new instance
-- tolerates a null `document` on every row written before this (they are summary-only snapshots
-- that predate a reader, so there is nothing to backfill and no version anybody can open).
--
-- `document` holds the whole VersionSnapshotDocument — the view-model as it read, the branding
-- and template as they stood at send time, the addressee, and the Storage paths behind the
-- version's own copies of the photos.
--
-- `trigger` records WHICH customer-facing event minted the version (#2030 slice 2 adds
-- mark-sent and copy-to-invoice alongside send), so the re-send count is derivable from the
-- versions rather than from a separate counter that can disagree with them.

ALTER TABLE "estimate_version_snapshots"
  ADD COLUMN IF NOT EXISTS "document" JSONB;

ALTER TABLE "estimate_version_snapshots"
  ADD COLUMN IF NOT EXISTS "trigger" TEXT;
