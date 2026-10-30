-- Roles & Permissions AL-16 (ticket 24, H5, D1), migration M11: every company has one Owner.
--
-- 1. Storage. organizations.owner_user_id is the company's Owner: nullable (a company may have none yet), unique (a person
--    owns one company at most), and a reference to the PAIR (organizations.id, owner_user_id) -> users(organization_id, id),
--    so the Owner is always one of the company's own people. The pair needs users(organization_id, id) to be unique, which
--    it is because users.id is. NO ACTION on delete: the Owner's row cannot be deleted while they are the Owner.
--
-- 2. The first Owner of every company that has none. FIRST it reports every company and the person it picks (RAISE NOTICE,
--    one line per company, before anything is written); THEN it writes. The pick is the OLDEST by created_at among the
--    company's people who are:
--      - an Admin (is_admin), active (is_active), not erased (erased_at IS NULL), still able to sign in (has_login), and
--      - have REALLY signed in. has_login is not that proof: an invite sets it before the person ever signs in (H5,
--        ESC-D4). The proof is a completed sign-in on record:
--          a. the sign-in provider's own record: auth.users.last_sign_in_at is set for the login linked to the person: the
--             same id, or else the same CONFIRMED email in any case, but only when that login is linked by id to no one
--             else and exactly one person has that email (two people whose emails differ only in case are not told apart,
--             so neither is credited). The provider stamps it on every completed sign-in of every kind (password, Google,
--             link), back to the account's first day. Read only where the migrating role may use the provider's schema and
--             read the table; otherwise (a plain Postgres in CI or local, or a role without those rights) it is skipped.
--          b. the app's own record of a completed sign-in: an audit_logs row by the person with the action login.succeeded,
--             mfa.verified (the code was entered) or oauth.google_finalized. login.mfa_challenged and login.failed are not
--             sign-ins.
--    A company with no such person is listed and left WITHOUT an Owner: nothing is guessed. A company that already has an
--    Owner keeps them. This "oldest Admin" rule exists only here; the running app never falls back to it.
--
-- 3. A record of what it settled, one audit_logs row per company it settled (actor: none, the system), so who was Owner on
--    day one can be read back later: owner.assigned (resource: the person) or owner.no_candidate.
--
-- IDEMPOTENT: every schema step is skipped when it is already there (so a re-run takes no lock), only companies with no Owner
-- are written, and a company's no-candidate record is written once. LOCKS: lock_timeout 5s for this transaction, so it fails
-- (and can be re-run) rather than queue the app's writes behind a long transaction. Portable plain PostgreSQL: the provider's
-- table is read only when it exists and is readable. NEVER run `prisma migrate` from a worktree.
--
-- The NOTICE lines of the report are not shown by `prisma migrate deploy`: on the hosted database, the report before writing
-- is the preview query in the migration record (.scratch/rp-alignment/migration-records/M11-organization-owner.md), run
-- before the deploy, and the audit_logs rows above are the record after it.

DO $m11$
DECLARE
  provider_readable boolean;
  r record;
  picked integer := 0;
  kept integer := 0;
  no_candidate integer := 0;
BEGIN
  -- The tables carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would read and write nothing.
  PERFORM set_config('app.bypass_rls', 'on', true);
  -- Never queue behind a long transaction while holding a lock the app waits on: give up after 5 seconds and fail the
  -- migration (it can be re-run) rather than stall every write to organizations or users behind it. Local to this
  -- transaction (set_config's third argument), the same as SET LOCAL, and valid however the statement is sent: a DO block
  -- always runs inside a transaction.
  PERFORM set_config('lock_timeout', '5s', true);

  -- 1. Storage --------------------------------------------------------------------------------------------------------
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'organizations' AND column_name = 'owner_user_id'
  ) THEN
    ALTER TABLE "organizations" ADD COLUMN "owner_user_id" UUID;
  END IF;
  IF to_regclass('organizations_owner_user_id_key') IS NULL THEN
    CREATE UNIQUE INDEX "organizations_owner_user_id_key" ON "organizations"("owner_user_id");
  END IF;
  IF to_regclass('users_organization_id_id_key') IS NULL THEN
    CREATE UNIQUE INDEX "users_organization_id_id_key" ON "users"("organization_id", "id");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'organizations_owner_same_company_fkey') THEN
    ALTER TABLE "organizations" ADD CONSTRAINT "organizations_owner_same_company_fkey"
      FOREIGN KEY ("id", "owner_user_id") REFERENCES "users"("organization_id", "id") ON DELETE NO ACTION ON UPDATE NO ACTION;
  END IF;

  -- 2a. Who has really signed in ---------------------------------------------------------------------------------------
  -- A second run in the same transaction (the migration's own test) finds the table of the first.
  IF to_regclass('pg_temp.m11_signed_in') IS NOT NULL THEN DROP TABLE pg_temp.m11_signed_in; END IF;
  CREATE TEMP TABLE m11_signed_in (user_id uuid PRIMARY KEY) ON COMMIT DROP;

  INSERT INTO m11_signed_in (user_id)
  SELECT DISTINCT l.actor_id
    FROM "audit_logs" l
    JOIN "users" u ON u.id = l.actor_id AND u.organization_id = l.org_id
   WHERE l.action IN ('login.succeeded', 'mfa.verified', 'oauth.google_finalized')
  ON CONFLICT DO NOTHING;

  -- The provider's table is read only when this role may look into its schema and read it. Each check runs only when the
  -- one before it passed: to_regclass('auth.users') itself raises "permission denied for schema auth" for a role without
  -- USAGE on the schema, and has_schema_privilege raises for a schema that does not exist. A read that is refused anyway
  -- (a column privilege, say) falls back the same way, so the migration never fails on the provider's table.
  provider_readable := false;
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'auth') THEN
    IF has_schema_privilege('auth', 'USAGE') THEN
      IF to_regclass('auth.users') IS NOT NULL THEN
        provider_readable := has_table_privilege('auth.users', 'SELECT');
      END IF;
    END IF;
  END IF;
  IF provider_readable THEN
    BEGIN
      -- A login credits the person it is linked to by id. It credits a person by email only when it is linked by id to no
      -- one else, its email is confirmed, and exactly one person has that email in any case: two people whose emails
      -- differ only in case can't be told apart, so neither is credited.
      EXECUTE $sql$
        INSERT INTO m11_signed_in (user_id)
        SELECT DISTINCT u.id
          FROM "users" u
          JOIN auth.users a
            ON a.id = u.id
            OR (
                  a.email_confirmed_at IS NOT NULL
              AND lower(a.email) = lower(u.email)
              AND NOT EXISTS (SELECT 1 FROM "users" other WHERE other.id = a.id AND other.id <> u.id)
              AND (SELECT count(*) FROM "users" same WHERE lower(same.email) = lower(a.email)) = 1
            )
         WHERE a.last_sign_in_at IS NOT NULL
        ON CONFLICT DO NOTHING
      $sql$;
    EXCEPTION WHEN insufficient_privilege THEN
      provider_readable := false;
    END;
  END IF;
  IF NOT provider_readable THEN
    RAISE NOTICE 'M11: the sign-in provider''s table is not readable here; only the app''s own sign-in records count.';
  END IF;

  -- 2b. The pick, for every company ------------------------------------------------------------------------------------
  -- A second run in the same transaction (the migration's own test) finds the table of the first.
  IF to_regclass('pg_temp.m11_pick') IS NOT NULL THEN DROP TABLE pg_temp.m11_pick; END IF;
  CREATE TEMP TABLE m11_pick ON COMMIT DROP AS
  SELECT o.id AS org_id,
         o.name AS org_name,
         o.owner_user_id AS current_owner,
         (SELECT u.id
            FROM "users" u
           WHERE u.organization_id = o.id
             AND u.is_admin AND u.is_active AND u.erased_at IS NULL AND u.has_login
             AND EXISTS (SELECT 1 FROM m11_signed_in s WHERE s.user_id = u.id)
           ORDER BY u.created_at ASC, u.id ASC
           LIMIT 1) AS pick
    FROM "organizations" o;

  -- 2c. REPORT every company and its pick, before anything is written --------------------------------------------------
  FOR r IN
    SELECT p.org_id, p.org_name, p.current_owner, p.pick,
           pu.first_name || ' ' || pu.last_name AS pick_name, pu.created_at AS pick_created
      FROM m11_pick p
      LEFT JOIN "users" pu ON pu.id = p.pick
     ORDER BY p.org_name, p.org_id
  LOOP
    IF r.current_owner IS NOT NULL THEN
      kept := kept + 1;
      RAISE NOTICE 'M11 report: company % (%): already has an Owner (%), kept.', r.org_name, r.org_id, r.current_owner;
    ELSIF r.pick IS NULL THEN
      no_candidate := no_candidate + 1;
      RAISE NOTICE 'M11 report: company % (%): NO CANDIDATE (no active Admin who has signed in); left without an Owner.', r.org_name, r.org_id;
    ELSE
      picked := picked + 1;
      RAISE NOTICE 'M11 report: company % (%): picks % (user %, added %).', r.org_name, r.org_id, r.pick_name, r.pick, r.pick_created;
    END IF;
  END LOOP;
  RAISE NOTICE 'M11 report: % companies get an Owner, % already have one, % have no candidate.', picked, kept, no_candidate;

  -- 2d. WRITE, and 3. the record of it ---------------------------------------------------------------------------------
  WITH settled AS (
    UPDATE "organizations" o
       SET owner_user_id = p.pick
      FROM m11_pick p
     WHERE o.id = p.org_id AND o.owner_user_id IS NULL AND p.pick IS NOT NULL
    RETURNING o.id, o.owner_user_id
  )
  INSERT INTO "audit_logs" (org_id, actor_id, action, resource_type, resource_id, metadata)
  SELECT s.id, NULL, 'owner.assigned', 'User', s.owner_user_id::text,
         jsonb_build_object('by', 'migration', 'migration', '20261028110000_organization_owner',
                            'rule', 'oldest active Admin who has signed in')
    FROM settled s;

  INSERT INTO "audit_logs" (org_id, actor_id, action, resource_type, resource_id, metadata)
  SELECT p.org_id, NULL, 'owner.no_candidate', NULL, NULL,
         jsonb_build_object('by', 'migration', 'migration', '20261028110000_organization_owner',
                            'rule', 'oldest active Admin who has signed in')
    FROM m11_pick p
   WHERE p.current_owner IS NULL AND p.pick IS NULL
     AND NOT EXISTS (
       SELECT 1 FROM "audit_logs" l
        WHERE l.org_id = p.org_id AND l.action = 'owner.no_candidate'
          AND l.metadata ->> 'migration' = '20261028110000_organization_owner'
     );
END
$m11$;
