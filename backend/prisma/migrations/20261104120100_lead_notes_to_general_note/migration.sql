-- #3104 (B7 follow-up): the text saved in a lead's own Notes field (leads.notes) becomes that lead's general note. DATA ONLY.
--
-- For every lead whose leads.notes holds text (anything but blanks) and that has no general note yet, one note is written:
--   content          the saved text, with the blanks (spaces, tabs, line breaks) at either end removed, as the form
--                    trims what it saves
--   created_at       the lead's creation time
--   created_by       the first of, in this order:
--                      1. the lead's creator (leads.created_by_id);
--                      2. the company's Owner (organizations.owner_user_id), for a lead with no creator (old imports:
--                         Ran's build ruling 1, 2026-11-04);
--                      3. the company's longest-standing ACTIVE Admin, for a company with no Owner either (Ran's build
--                         ruling 5): a person of the company with the Admin flag (users.is_admin, the one "is an Admin"
--                         check, schema P15), active (is_active) and not erased (erased_at IS NULL), who joined first
--                         (users.created_at), ties broken by id;
--   is_general       true
-- A lead with none of the three is LEFT WITHOUT a note: nothing else is guessed. The run reports per company, before it
-- writes (RAISE NOTICE), how many leads get a note and by which fallback, and how many are left; then how many it wrote.
--
-- leads.notes is NOT cleared or dropped: the app stops writing it with this change, and dropping it is a later, separate
-- migration.
--
-- IDEMPOTENT: a lead that already has a general note is skipped (and the partial unique index notes_one_general_per_record
-- refuses a second one), so a second run writes nothing. SET-BASED. Portable plain PostgreSQL. NEVER run `prisma migrate`
-- from a worktree.

DO $general_note$
DECLARE
  r record;
  written integer;
BEGIN
  -- leads and notes carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM set_config('statement_timeout', '0', true);

  -- The text each lead would move, blanks at either end removed. Text that is only blanks is no text.
  IF to_regclass('pg_temp.gn3104_text') IS NOT NULL THEN DROP TABLE pg_temp.gn3104_text; END IF;
  CREATE TEMP TABLE gn3104_text ON COMMIT DROP AS
  SELECT l.id AS lead_id, l.organization_id AS org_id, l.created_at, l.created_by_id, o.owner_user_id, a.senior_admin_id,
         regexp_replace(l.notes, '^[[:space:]]+|[[:space:]]+$', '', 'g') AS content
    FROM "leads" l
    JOIN "organizations" o ON o.id = l.organization_id
    LEFT JOIN LATERAL (
      SELECT u.id AS senior_admin_id
        FROM "users" u
       WHERE u.organization_id = l.organization_id AND u.is_admin AND u.is_active AND u.erased_at IS NULL
       ORDER BY u.created_at ASC, u.id ASC
       LIMIT 1
    ) a ON true
   WHERE l.notes IS NOT NULL
     AND regexp_replace(l.notes, '^[[:space:]]+|[[:space:]]+$', '', 'g') <> ''
     AND NOT EXISTS (
       SELECT 1 FROM "notes" n
        WHERE n.entity_type = 'LEAD' AND n.entity_id = l.id AND n.is_general = true
     );

  -- REPORT, before anything is written: per company, the leads that get a note and those left without one.
  FOR r IN
    SELECT t.org_id,
           count(*) FILTER (WHERE COALESCE(t.created_by_id, t.owner_user_id, t.senior_admin_id) IS NOT NULL) AS to_write,
           count(*) FILTER (WHERE t.created_by_id IS NULL AND t.owner_user_id IS NOT NULL) AS by_owner,
           count(*) FILTER (WHERE t.created_by_id IS NULL AND t.owner_user_id IS NULL AND t.senior_admin_id IS NOT NULL) AS by_admin,
           count(*) FILTER (WHERE COALESCE(t.created_by_id, t.owner_user_id, t.senior_admin_id) IS NULL) AS no_author
      FROM gn3104_text t
     GROUP BY t.org_id
     ORDER BY t.org_id
  LOOP
    RAISE NOTICE '#3104 report: org %: % leads get a general note (% by the company Owner, % by its longest-standing active Admin), % left without one (no creator, no Owner, no active Admin).',
      r.org_id, r.to_write, r.by_owner, r.by_admin, r.no_author;
  END LOOP;

  INSERT INTO "notes" (id, entity_type, entity_id, content, created_by, created_at, organization_id, is_general)
  SELECT gen_random_uuid(), 'LEAD', t.lead_id, t.content, COALESCE(t.created_by_id, t.owner_user_id, t.senior_admin_id),
         t.created_at, t.org_id, true
    FROM gn3104_text t
   WHERE COALESCE(t.created_by_id, t.owner_user_id, t.senior_admin_id) IS NOT NULL
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS written = ROW_COUNT;
  RAISE NOTICE '#3104: % general notes written.', written;
END
$general_note$;
