ALTER TABLE "leads" ADD COLUMN IF NOT EXISTS "source" TEXT;
ALTER TABLE "jobs"  ADD COLUMN IF NOT EXISTS "dispatcher_id" UUID;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_dispatcher_id_fkey') THEN
    ALTER TABLE "jobs" ADD CONSTRAINT "jobs_dispatcher_id_fkey"
      FOREIGN KEY ("dispatcher_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "jobs_dispatcher_id_idx" ON "jobs" ("dispatcher_id");
