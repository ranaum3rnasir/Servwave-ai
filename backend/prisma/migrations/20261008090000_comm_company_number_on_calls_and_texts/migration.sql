-- Calls and texts record the company number they went through (Roles & Permissions S08.1).
--
-- Additive only: three nullable columns, their indexes and foreign keys, then a backfill of
-- existing calls.
--   call_sessions.phone_number_id   the company number the call went through (inbound: the number
--                                   called; outbound: the number it went out from)
--   messages.phone_number_id        the company number the text went through (inbound: the number
--                                   the customer texted; outbound: the number it was sent from)
--   messages.sent_by_user_id        the person who sent a text from the app (stays empty on older
--                                   texts: no record of the sender exists)
-- Deleting a number or a user leaves the call or text in place and clears the link (SET NULL).
--
-- Existing calls are backfilled here by matching their stored numbers to the organization's own
-- numbers. Texts are NOT touched here: placing them reads the phone service's history, which is
-- the one-time fill-in (scripts/text-company-number-fill-in.ts), run once right after this
-- migration. A call whose stored number matches none of the organization's numbers stays empty.
--
-- Idempotent: columns and indexes are IF NOT EXISTS, each foreign key sits behind a pg_constraint
-- check, and the backfill only writes calls that still have no company number, so a second
-- application changes nothing. Portable plain PostgreSQL (no vendor roles).

-- call_sessions carries FORCE ROW LEVEL SECURITY; a role that does not bypass it would update 0 rows.
SELECT set_config('app.bypass_rls', 'on', true);

ALTER TABLE "call_sessions" ADD COLUMN IF NOT EXISTS "phone_number_id" UUID;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "phone_number_id" UUID;
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "sent_by_user_id" UUID;

CREATE INDEX IF NOT EXISTS "call_sessions_phone_number_id_idx" ON "call_sessions"("phone_number_id");
CREATE INDEX IF NOT EXISTS "messages_phone_number_id_idx" ON "messages"("phone_number_id");
CREATE INDEX IF NOT EXISTS "messages_sent_by_user_id_idx" ON "messages"("sent_by_user_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'call_sessions_phone_number_id_fkey') THEN
    ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_phone_number_id_fkey"
      FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_phone_number_id_fkey') THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_phone_number_id_fkey"
      FOREIGN KEY ("phone_number_id") REFERENCES "phone_numbers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'messages_sent_by_user_id_fkey') THEN
    ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_user_id_fkey"
      FOREIGN KEY ("sent_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- Backfill existing calls and report the row counts.
DO $$
DECLARE
  matched_now integer;
  with_number integer;
  total integer;
BEGIN
  -- The company number is the number called on an inbound call and the number called from on an
  -- outbound one. The stored value is normalized the way the app normalizes a North American
  -- number (10 digits, or 11 starting with 1, to +1XXXXXXXXXX); anything else is compared as stored.
  WITH calls AS (
    SELECT c.id, c.organization_id,
           CASE WHEN c.direction = 'in' THEN c.to_number ELSE c.from_number END AS raw_number
    FROM "call_sessions" c
    WHERE c.phone_number_id IS NULL
  ), normalized AS (
    SELECT id, organization_id,
           CASE
             WHEN length(regexp_replace(raw_number, '\D', '', 'g')) = 10
               THEN '+1' || regexp_replace(raw_number, '\D', '', 'g')
             WHEN length(regexp_replace(raw_number, '\D', '', 'g')) = 11
                  AND left(regexp_replace(raw_number, '\D', '', 'g'), 1) = '1'
               THEN '+' || regexp_replace(raw_number, '\D', '', 'g')
             ELSE raw_number
           END AS e164
    FROM calls
  )
  UPDATE "call_sessions" c
  SET phone_number_id = pn.id
  FROM normalized n
  JOIN "phone_numbers" pn ON pn.organization_id = n.organization_id AND pn.e164 = n.e164
  WHERE c.id = n.id AND c.phone_number_id IS NULL;
  GET DIAGNOSTICS matched_now = ROW_COUNT;

  SELECT count(*) FILTER (WHERE phone_number_id IS NOT NULL), count(*)
    INTO with_number, total FROM "call_sessions";

  RAISE NOTICE 'S08.1 calls matched to a company number in this run: %', matched_now;
  RAISE NOTICE 'S08.1 calls now carrying a company number: % of % (% left empty)', with_number, total, total - with_number;
END $$;
