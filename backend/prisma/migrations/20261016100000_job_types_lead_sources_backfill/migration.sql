-- V7-03 (Lists backend), Migration B: copy each organization's JSON list into rows. DATA ONLY: no DDL.
--
-- One INSERT ... SELECT per table, run for ALL organizations. It is the statement the fill helper runs for one org
-- (listRowsFromOrgJsonSql in backend/src/lib/org-list-sql.ts) with the `o.id = <org>` filter dropped; a test compares the two.
--   - only string elements count; each is trimmed, its whitespace collapsed, cut to 50 characters and trimmed again;
--   - empties are skipped, names that match case-insensitively collapse to the first occurrence;
--   - sort_order is the 0-based position among the survivors; a column that is not a JSON array gives no rows;
--   - an organization that already has ANY row in the table (active or archived) is left alone, so a re-run never
--     duplicates or overwrites a list an admin already renamed. ON CONFLICT DO NOTHING covers the race NOT EXISTS cannot.
-- The JSON columns stay (deploy overlap). Idempotent: running it again inserts nothing.
--
-- RLS: organizations, job_types and lead_sources are all FORCE ROW LEVEL SECURITY. Applied by a role without BYPASSRLS,
-- both statements would read zero organizations and write "INSERT 0 0" SILENTLY (a green ledger row, no rows anywhere).
-- So the file turns on the tenant policy's own escape hatch, app.bypass_rls, TRANSACTION-LOCAL (set_config's third
-- argument; the deploy runs a file in one transaction): it ends with this migration and never reaches a pooled session.
-- Same convention as 20260928080000_task_categories. A green ledger row is still not evidence: run the before/after
-- count per organization after every apply.

SELECT set_config('app.bypass_rls', 'on', true);

INSERT INTO "job_types" ("id", "organization_id", "name", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", n."name", (row_number() OVER (PARTITION BY o."id" ORDER BY n."ord") - 1)::int, now(), now()
FROM "organizations" o
CROSS JOIN LATERAL (
  SELECT DISTINCT ON (lower(c."name")) c."name", c."ord"
  FROM (
    SELECT btrim(left(btrim(regexp_replace(e."value" #>> '{}', '\s+', ' ', 'g')), 50)) AS "name", e."ord"
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o."job_type_options") = 'array' THEN o."job_type_options" ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e("value", "ord")
    WHERE jsonb_typeof(e."value") = 'string'
  ) c
  WHERE c."name" <> ''
  ORDER BY lower(c."name"), c."ord"
) n
WHERE NOT EXISTS (SELECT 1 FROM "job_types" t WHERE t."organization_id" = o."id")
ON CONFLICT DO NOTHING;

INSERT INTO "lead_sources" ("id", "organization_id", "name", "sort_order", "created_at", "updated_at")
SELECT gen_random_uuid(), o."id", n."name", (row_number() OVER (PARTITION BY o."id" ORDER BY n."ord") - 1)::int, now(), now()
FROM "organizations" o
CROSS JOIN LATERAL (
  SELECT DISTINCT ON (lower(c."name")) c."name", c."ord"
  FROM (
    SELECT btrim(left(btrim(regexp_replace(e."value" #>> '{}', '\s+', ' ', 'g')), 50)) AS "name", e."ord"
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(o."source_options") = 'array' THEN o."source_options" ELSE '[]'::jsonb END)
      WITH ORDINALITY AS e("value", "ord")
    WHERE jsonb_typeof(e."value") = 'string'
  ) c
  WHERE c."name" <> ''
  ORDER BY lower(c."name"), c."ord"
) n
WHERE NOT EXISTS (SELECT 1 FROM "lead_sources" t WHERE t."organization_id" = o."id")
ON CONFLICT DO NOTHING;
