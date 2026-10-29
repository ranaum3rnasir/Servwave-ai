-- #21 — server-enforced T&C acceptance. Idempotent: shared staging DB may already
-- have these (see Shared-Staging-DB-Migration-Drift).
ALTER TABLE "estimates"
  ADD COLUMN IF NOT EXISTS "terms_accepted" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "terms_accepted_at" TIMESTAMP(3);
