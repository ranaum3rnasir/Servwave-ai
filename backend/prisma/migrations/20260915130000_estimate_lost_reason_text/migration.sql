-- SRVW-285 slice A — widen "estimates"."lost_reason" from the "LostReason" enum to TEXT.
--
-- WHY AT ALL. Ran resolved that the decline-reason list becomes per-organisation configurable:
-- built-in options plus "Other", managed by admins from a settings screen, so a cabinet business
-- can add "designer" or "quality". An enum cannot hold that. Adding a member is a migration and a
-- deploy, which is precisely what an admin-managed list must not require. So the column has to
-- stop being an enum before any of that can be built, and this migration is that step and only
-- that step — no new table, no new row, nothing an operator can see.
--
-- WHY NO BACKFILL IS OWED. "LostReason"::text yields the enum LABEL — 'PRICE' stays the string
-- 'PRICE' — so every row already stored keeps its value character for character. The estimates
-- conversion report groups on this column as an opaque value (report.controller.ts reportSelect →
-- normalize().lostReason), so it groups on exactly the strings it grouped on yesterday and its
-- output is byte-identical. There is nothing to migrate, only a type to change.
--
-- WHAT THIS GIVES UP, STATED PLAINLY. The enum was a SECOND, INDEPENDENT guard: Postgres itself
-- refused a value outside the five, whatever the application did. TEXT retires that guard, and
-- from here the application is the only thing between a crafted request and an arbitrary string in
-- a reporting column. The membership checks in estimate.controller.ts (z.nativeEnum(LostReason) on
-- the two staff paths, the explicit Object.values(LostReason).includes() on the public one) were
-- previously belt-and-braces and are now the braces alone. They are unchanged by this slice and
-- src/__tests__/estimate-lost-reason-storage.test.ts exists to keep them that way.
--
-- THE "LostReason" TYPE IS DELIBERATELY *NOT* DROPPED HERE.
-- A deploy is an overlap, not an instant: while the new instance boots, the old one is still
-- serving requests against a generated client that expects the type to exist. Dropping it in the
-- same migration that widens the column would break the still-running old instance for the length
-- of that overlap. The drop is a separate, later, no-rush migration once nothing old is left
-- running — and it is genuinely no-rush, because an unused type costs nothing but a catalog row.
-- See `prisma-enumerates-columns-so-a-select-less-query-breaks-on-drop`. The enum block also stays
-- in schema.prisma for a second reason spelled out at its declaration: it is what stops a future
-- `prisma migrate diff` from deciding the type is drift and bundling a DROP TYPE into somebody
-- else's unrelated migration.
--
-- IDEMPOTENT, and guarded rather than bare. The shared staging DB can see a migration twice. A
-- bare `ALTER COLUMN ... TYPE TEXT USING "lost_reason"::text` would in fact survive a second run
-- (text::text is a valid cast), so the guard is not there to prevent an error — it is there to
-- prevent the WORK. ALTER COLUMN ... TYPE rewrites the whole table and takes an ACCESS EXCLUSIVE
-- lock on it; doing that a second time to reach the type it is already at is a table rewrite and a
-- write-blocking lock on "estimates" bought for nothing.
--
-- POST-CONDITIONS, following 20260903190000_widen_markup_percent. A migration that exits 0 having
-- changed nothing is the dangerous outcome, because _prisma_migrations then records it as applied
-- and no later run will revisit it. information_schema only exposes columns the connecting role
-- can see, so "no row came back" and "the column is fine" are indistinguishable unless asserted
-- apart — hence the explicit NULL check before the ALTER and the type re-read after it.
--
-- PORTABILITY. No Supabase-only object here: no auth.* reference, no policy, no TO
-- authenticated/anon/service_role grant. It needs no pg_roles guard and runs unchanged on CI's
-- vanilla postgres:16, on Render's `prisma migrate deploy`, and applied by hand.
DO $$
DECLARE
  col_type text;
  col_udt  text;
BEGIN
  SELECT data_type, udt_name
    INTO col_type, col_udt
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'estimates'
     AND column_name  = 'lost_reason';

  -- Absent column: either the table/column was renamed under us, or information_schema is hiding
  -- it from this role. Both mean "I cannot confirm what I am about to be credited with", and the
  -- only safe answer is to fail loudly rather than be recorded as applied.
  IF col_type IS NULL THEN
    RAISE EXCEPTION
      'estimates.lost_reason is not visible in information_schema — refusing to be recorded as applied';
  END IF;

  -- 'USER-DEFINED' is how information_schema reports an enum-typed column; udt_name carries the
  -- type's actual name. Both are pinned so this only ever casts the column it was written for —
  -- if lost_reason were somehow some OTHER user-defined type, blindly ::text-ing it would be a
  -- guess, and the post-condition below would then catch it rather than this branch papering over
  -- it.
  IF col_type = 'USER-DEFINED' AND col_udt = 'LostReason' THEN
    ALTER TABLE "estimates" ALTER COLUMN "lost_reason" TYPE TEXT USING "lost_reason"::text;
  END IF;

  -- Re-read from the same catalog inside the same transaction, so this sees the ALTER above.
  SELECT data_type
    INTO col_type
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'estimates'
     AND column_name  = 'lost_reason';

  IF col_type IS DISTINCT FROM 'text' THEN
    RAISE EXCEPTION
      'estimates.lost_reason is % after this migration, expected text', coalesce(col_type, '<missing>');
  END IF;
END $$;
