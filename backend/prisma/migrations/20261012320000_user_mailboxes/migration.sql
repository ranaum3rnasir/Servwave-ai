-- Roles & Permissions Overhaul, PRD 10, slice S10.3: every active user gets a user mailbox, with a
-- first.last.company address or, when that address is taken, in "address needed" with none.
--
-- THIS MIGRATION MOVES DATA IN EVERY COMPANY. It adds one index and then, for every ACTIVE user (admins like
-- everyone else; inactive users get none until they are reactivated) who has no live mailbox yet, writes one
-- row in `mailboxes` (kind 'user', held by the user) and, when an address is free, one row in
-- `mailbox_addresses` (the register) as its primary address. No bell, notification, email or other row is
-- written: a migration is silent, so a company is not greeted with hundreds of bells on the day it ships.
--
-- THE ADDRESS RULE is the register's pure core (backend/src/lib/mailbox/address-core.ts: slugNamePart,
-- buildUserNamePart, buildUserLocalPart), written once more here in SQL. A real-database test
-- (user-mailboxes-migration-db.test.ts) builds a wide set of names and asserts, name by name, that the two
-- agree.
--   - each name keeps only [A-Za-z0-9], lowercased (translate(), so no database locale is involved);
--   - the name part is first.last; a user with no usable last name gets the first alone, one with no usable
--     first name the last alone, one with neither no address;
--   - the name part is capped so `<name part>.<company part>` stays within 64 characters: a short name keeps
--     itself whole, two long ones share what is left (the first name taking the smaller half);
--   - the company part is the company's FROZEN part (organizations.email_sender_local_part, set by S10.1);
--     a company without one gets nobody an address.
-- THE NAMESAKE RULE: a name part already issued to anyone in the company, past or present, is taken (the
-- register's address rows are never deleted, so a leaver's stays taken), and so is a name part held under an
-- earlier company part. Among users who want the same name part in this run, the EARLIER-CREATED one wins
-- (ties by id) and the others get a mailbox in "address needed" with NO address. The register never adds a
-- number or an initial. An admin sets a free address later (S10.25).
--
-- An address kept only as a hash for a purged company cannot be compared here (the key lives outside the
-- database); such an address would end in a company part that no new company can hold, so none can collide.
--
-- The plan is the one SELECT between the two marker comments below. The dry-run report
-- (backend/src/scripts/user-mailbox-report.ts, npm run mailboxes:user-dry-run) reads it from this file in a
-- READ-ONLY transaction, so what it previews is exactly what runs; `mailboxes:user-proof` checks afterwards.
-- Both print company ids and user ids and counts only: never a name or an address.
--
-- IDEMPOTENT: a user who has a live mailbox is not in the plan, so a second run finds nothing to write.
-- A user created by an older backend during the deploy overlap gets a mailbox by running this file again
-- (psql -f). Set-based: one plan, one INSERT per table, no row-by-row loop. The register's advisory lock
-- (the one lib/mailbox/register.ts takes) is held for the run, so no other writer issues an address under it.
-- Portable plain PostgreSQL 16 (gen_random_uuid() is built in from 13, no vendor roles): runs on CI's
-- vanilla postgres:16, on the Render deploy, and possibly twice against the shared staging DB.
-- NEVER run `prisma migrate` from a worktree.

-- One live mailbox per user: a merged one does not count, because a reactivated user gets a fresh mailbox
-- beside the one that was merged into the main mailbox. Partial, so Prisma's schema cannot express it.
CREATE UNIQUE INDEX IF NOT EXISTS "mailboxes_one_live_per_user" ON "mailboxes"("user_id")
  WHERE "kind" = 'user' AND "status" <> 'merged';

DO $$
DECLARE
  rec record;
  planned_total integer;
  issued_total integer;
  needed_total integer;
  mailbox_total integer;
  missing integer;
BEGIN
  -- users, mailboxes and mailbox_addresses carry FORCE ROW LEVEL SECURITY; a role that does not bypass it would
  -- see and move nothing. Set inside the block so it holds even when a client (psql -f) runs each statement in
  -- its own transaction.
  PERFORM set_config('app.bypass_rls', 'on', true);
  PERFORM pg_advisory_xact_lock(hashtextextended('mailbox_address_register', 0));

  DROP TABLE IF EXISTS pg_temp.user_mailboxes_plan;
  CREATE TEMP TABLE user_mailboxes_plan ON COMMIT DROP AS
  -- @plan
  WITH wanted AS (
    -- Every active user without a live mailbox, with each name reduced to [a-z0-9] and the company's frozen part.
    SELECT u.id AS user_id,
           u.organization_id,
           u.created_at,
           o.email_sender_local_part AS company_part,
           translate(regexp_replace(coalesce(u.first_name, ''), '[^A-Za-z0-9]', '', 'g'),
                     'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS f,
           translate(regexp_replace(coalesce(u.last_name, ''), '[^A-Za-z0-9]', '', 'g'),
                     'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz') AS l
    FROM users u
    JOIN organizations o ON o.id = u.organization_id
    WHERE u.is_active
      AND NOT EXISTS (
        SELECT 1 FROM mailboxes m WHERE m.kind = 'user' AND m.user_id = u.id AND m.status <> 'merged'
      )
  ),
  sized AS (
    SELECT w.*,
           CASE WHEN w.company_part IS NULL THEN NULL ELSE 64 - 1 - length(w.company_part) END AS cap
    FROM wanted w
  ),
  shared AS (
    -- How much of the first name survives when both names are long: a short first name keeps itself whole, else
    -- it takes at least half of what is left after the dot.
    SELECT s.*,
           CASE WHEN s.cap IS NULL OR s.cap < 3 THEN 0
                ELSE least(length(s.f), greatest((s.cap - 1) / 2, (s.cap - 1) - length(s.l))) END AS kept_first
    FROM sized s
  ),
  named AS (
    SELECT h.user_id, h.organization_id, h.created_at, h.company_part,
           CASE
             WHEN h.company_part IS NULL OR h.cap < 1 THEN NULL
             WHEN h.f = '' AND h.l = '' THEN NULL
             WHEN h.f = '' THEN left(h.l, h.cap)
             WHEN h.l = '' THEN left(h.f, h.cap)
             WHEN length(h.f) + length(h.l) <= h.cap - 1 THEN h.f || '.' || h.l
             WHEN h.cap - 1 < 2 THEN left(h.f, h.cap)
             ELSE left(h.f, h.kept_first) || '.' || left(h.l, least(length(h.l), (h.cap - 1) - h.kept_first))
           END AS name_part
    FROM shared h
  ),
  held AS (
    -- Name parts already issued to anyone in a company, past or present, under any company part it has had.
    SELECT DISTINCT a.organization_id, regexp_replace(a.local_part, '\.[^.]*$', '') AS name_part
    FROM mailbox_addresses a
    JOIN mailboxes m ON m.id = a.mailbox_id AND m.kind = 'user'
    WHERE a.organization_id IS NOT NULL AND a.kind = 'issued' AND position('.' IN a.local_part) > 0
  ),
  ranked AS (
    SELECT n.*,
           row_number() OVER (PARTITION BY n.organization_id, n.name_part ORDER BY n.created_at, n.user_id) AS place,
           first_value(n.user_id) OVER (PARTITION BY n.organization_id, n.name_part ORDER BY n.created_at, n.user_id) AS winner_user_id
    FROM named n
    WHERE n.name_part IS NOT NULL
  )
  SELECT n.user_id,
         n.organization_id,
         n.created_at,
         CASE
           WHEN n.company_part IS NULL THEN 'no_company_part'
           WHEN n.name_part IS NULL THEN 'no_name'
           WHEN EXISTS (SELECT 1 FROM held x WHERE x.organization_id = n.organization_id AND x.name_part = n.name_part)
             OR EXISTS (SELECT 1 FROM mailbox_addresses a WHERE a.local_part = n.name_part || '.' || n.company_part)
             THEN 'taken'
           WHEN r.place > 1 THEN 'namesake'
           ELSE 'issue'
         END AS outcome,
         CASE WHEN r.place > 1 THEN r.winner_user_id END AS winner_user_id,
         n.name_part || '.' || n.company_part AS local_part
  FROM named n
  LEFT JOIN ranked r ON r.user_id = n.user_id
  -- @end
  ;

  SELECT count(*) INTO planned_total FROM user_mailboxes_plan;
  SELECT count(*) INTO issued_total FROM user_mailboxes_plan WHERE outcome = 'issue';
  needed_total := planned_total - issued_total;

  -- The report: counts per company, never a name or an address.
  FOR rec IN
    SELECT p.organization_id,
           count(*) FILTER (WHERE p.outcome = 'issue') AS issued,
           count(*) FILTER (WHERE p.outcome <> 'issue') AS needed
    FROM user_mailboxes_plan p GROUP BY p.organization_id ORDER BY p.organization_id
  LOOP
    RAISE NOTICE 'S10.3 org %: % mailboxes with an address, % in address needed', rec.organization_id, rec.issued, rec.needed;
  END LOOP;
  RAISE NOTICE 'S10.3 % active users without a mailbox: % get an address, % are in address needed', planned_total, issued_total, needed_total;

  -- The mailboxes; a user who somehow got one since the plan was made is left alone.
  INSERT INTO "mailboxes" ("id", "organization_id", "kind", "user_id", "holder_user_id", "status", "created_at", "updated_at")
  SELECT gen_random_uuid(), p.organization_id, 'user', p.user_id, p.user_id,
         CASE WHEN p.outcome = 'issue' THEN 'active' ELSE 'address_needed' END, now(), now()
  FROM user_mailboxes_plan p
  ON CONFLICT DO NOTHING;

  -- Their addresses, as the primary address of the mailbox just made.
  INSERT INTO "mailbox_addresses" ("id", "local_part", "kind", "organization_id", "mailbox_id", "is_primary", "issued_at")
  SELECT gen_random_uuid(), p.local_part, 'issued', p.organization_id, m.id, true, now()
  FROM user_mailboxes_plan p
  JOIN "mailboxes" m ON m.user_id = p.user_id AND m.kind = 'user' AND m.status = 'active'
  WHERE p.outcome = 'issue'
    AND NOT EXISTS (SELECT 1 FROM "mailbox_addresses" a WHERE a.mailbox_id = m.id)
  ON CONFLICT ("local_part") DO NOTHING;

  -- After writing: per-environment counts, and a hard stop if any active user is left without a mailbox, or any
  -- active mailbox without its primary address.
  SELECT count(*) INTO mailbox_total FROM "mailboxes" WHERE kind = 'user' AND status <> 'merged';
  RAISE NOTICE 'S10.3 done: % live user mailboxes', mailbox_total;

  SELECT count(*) INTO missing
  FROM users u
  WHERE u.is_active
    AND NOT EXISTS (SELECT 1 FROM "mailboxes" m WHERE m.kind = 'user' AND m.user_id = u.id AND m.status <> 'merged');
  IF missing > 0 THEN
    RAISE EXCEPTION 'S10.3: % active users are left without a mailbox', missing;
  END IF;
  SELECT count(*) INTO missing
  FROM "mailboxes" m
  WHERE m.kind = 'user' AND m.status = 'active'
    AND NOT EXISTS (SELECT 1 FROM "mailbox_addresses" a WHERE a.mailbox_id = m.id AND a.is_primary);
  IF missing > 0 THEN
    RAISE EXCEPTION 'S10.3: % active user mailboxes are left without a primary address', missing;
  END IF;
END $$;
