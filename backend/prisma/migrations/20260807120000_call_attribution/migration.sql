-- Marketing attribution on inbound calls (Ran's 2026-08-07 scope call).
--
-- CTM's webhook already carries a full attribution block - source, medium,
-- campaign, keyword, referrer, ad_network, ad_group/creative ids, gclid - and
-- ingest persisted exactly ONE of them (`tracking_source` <- payload.source),
-- discarding the rest. Northwind Services runs campaign numbers that forward to the
-- office, so "which campaign did this caller come from" is a reporting
-- requirement, not a nicety.
--
-- JSONB rather than a column per field on purpose: CTM's payload carries ~20
-- attribution keys and adds more over time (ad_slot, ad_targeting_type,
-- touchpoints…). A column each would mean a migration every time CTM ships a
-- field. `tracking_source` STAYS as the denormalised label reports group by -
-- this column is the full record behind it, not a replacement.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS + CREATE INDEX IF NOT EXISTS, so a
--   re-run on the shared staging DB is a no-op.
-- PORTABLE: vanilla postgres:16 (the CI migration-check job) - jsonb and a GIN
--   index are core Postgres, no Supabase-specific objects and no new RLS
--   (call_sessions already carries its tenant policy; adding a column to an
--   RLS-enabled table inherits it).

ALTER TABLE "call_sessions"
  ADD COLUMN IF NOT EXISTS "attribution" JSONB;

COMMENT ON COLUMN "call_sessions"."attribution" IS
  'Full CTM marketing attribution for the call (source, medium, campaign, keyword, referrer, ad ids, gclid). tracking_source holds the denormalised primary label.';

-- Reports will filter on individual keys (source/campaign), which is what GIN
-- on jsonb_path_ops is for. Partial: only inbound rows carry attribution, so
-- the index stays small rather than covering every outbound leg with a NULL.
CREATE INDEX IF NOT EXISTS "call_sessions_attribution_idx"
  ON "call_sessions" USING GIN ("attribution" jsonb_path_ops)
  WHERE "attribution" IS NOT NULL;
