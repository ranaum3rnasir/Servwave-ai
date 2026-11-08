-- Personnel port: display-only Department head (grants NO powers). Additive + guarded FK, re-runnable.
ALTER TABLE "departments" ADD COLUMN IF NOT EXISTS "head_id" UUID;

CREATE INDEX IF NOT EXISTS "departments_head_id_idx" ON "departments" ("head_id");

DO $$ BEGIN
  ALTER TABLE "departments" ADD CONSTRAINT "departments_head_id_fkey"
    FOREIGN KEY ("head_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
