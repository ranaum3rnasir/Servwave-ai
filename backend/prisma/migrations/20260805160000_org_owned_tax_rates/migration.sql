-- Org-owned tax rates with per-rate dropdown visibility.
--
-- Every org gets its own copy of the 52 global `state_tax_rates` rows, and owns them outright:
-- rename, re-rate, hide or delete. Only the org's home state is left visible, so the tax picker in
-- estimates/invoices/jobs stops listing 51 irrelevant states. Hiding is a UI filter only - tax
-- derivation still reads hidden rows, so an out-of-state job can never be silently under-charged.
--
-- Behaviour change on live data: an existing org goes from 52 visible rates to 1. Nothing is
-- deleted; the other 51 stay in its list as hidden rows and can be switched back on in Settings.

-- 1. New columns. `is_visible` defaults true so the hand-made custom rates orgs already created
--    (e.g. Northwind Services' two Workiz rates) stay visible - only the rows seeded in step 3 are hidden.
ALTER TABLE "org_tax_rates" ADD COLUMN IF NOT EXISTS "state_code" VARCHAR(2);
ALTER TABLE "org_tax_rates" ADD COLUMN IF NOT EXISTS "is_visible" BOOLEAN NOT NULL DEFAULT true;

-- 2. One seeded row per state per org. Partial, so hand-made rows (state_code NULL) are unbounded.
--    This also makes step 3 idempotent under ON CONFLICT.
CREATE UNIQUE INDEX IF NOT EXISTS "org_tax_rates_org_state_code_key"
  ON "org_tax_rates" ("organization_id", "state_code")
  WHERE "state_code" IS NOT NULL;

CREATE INDEX IF NOT EXISTS "org_tax_rates_organization_id_is_visible_idx"
  ON "org_tax_rates" ("organization_id", "is_visible");

-- 3. Seed every existing org with the full global list, visible only for its home state.
--    `organizations.state` is VARCHAR(50): today every row holds a 2-letter code, but the second
--    arm matches a full state name defensively in case that ever changes.
INSERT INTO "org_tax_rates" ("id", "organization_id", "name", "rate", "state_code", "is_visible", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  o."id",
  s."state_name",
  s."tax_rate",
  s."state_code",
  (
    s."state_code" = upper(btrim(coalesce(o."state", '')))
    OR lower(s."state_name") = lower(btrim(coalesce(o."state", '')))
  ),
  now(),
  now()
FROM "organizations" o
CROSS JOIN "state_tax_rates" s
ON CONFLICT ("organization_id", "state_code") WHERE "state_code" IS NOT NULL DO NOTHING;
