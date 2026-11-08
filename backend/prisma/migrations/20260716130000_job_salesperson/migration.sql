-- Nullable salesperson pointer on jobs (writer-less until leadless-job salesperson lands; resolver falls back to the lead owner).
ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "salesperson_id" uuid;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'jobs_salesperson_id_fkey') THEN
    ALTER TABLE "jobs" ADD CONSTRAINT "jobs_salesperson_id_fkey"
      FOREIGN KEY ("salesperson_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS "jobs_salesperson_id_idx" ON "jobs"("salesperson_id");
