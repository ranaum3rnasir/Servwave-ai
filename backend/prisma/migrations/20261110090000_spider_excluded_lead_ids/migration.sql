-- Spider watches every open lead minus an exclusion list (#3434, Ran 3 Nov: every open lead is watched by default, new
-- ones included; any lead can be excluded).
--
-- Adds spider_settings.excluded_lead_ids and fills it from the old selection, so each company keeps watching exactly the
-- open leads it watched before:
--   - watch_all_leads true  -> empty (every open lead watched);
--   - watch_all_leads false -> the company's OPEN leads that are not in selected_lead_ids.
-- "Open" is the sweep's own condition (services/spider/sweep.ts, currentStageVisits): status not WON or LOST, and no
-- won_at, lost_at or cancelled_at. Closed leads are left out: they are never watched, and a lead reopened later is
-- watched (the old selection would not have known it either way).
--
-- watch_all_leads and selected_lead_ids are KEPT: the code stops reading them here, and a later ticket drops them.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the fill touches only rows still in the old shape with an empty list, so a
-- second run recomputes the same list from the same selection (or changes nothing). Portable: no Supabase-only objects,
-- no secrets.

ALTER TABLE "spider_settings" ADD COLUMN IF NOT EXISTS "excluded_lead_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

UPDATE "spider_settings" s
SET "excluded_lead_ids" = COALESCE(
  (
    SELECT array_agg(l."id" ORDER BY l."id")
    FROM "leads" l
    WHERE l."organization_id" = s."organization_id"
      AND l."status" NOT IN ('WON', 'LOST')
      AND l."won_at" IS NULL
      AND l."lost_at" IS NULL
      AND l."cancelled_at" IS NULL
      AND l."id" <> ALL (s."selected_lead_ids")
  ),
  '{}'
)
WHERE s."watch_all_leads" = false
  AND s."excluded_lead_ids" = '{}';
