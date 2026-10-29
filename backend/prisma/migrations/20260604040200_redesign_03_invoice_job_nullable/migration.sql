-- Entity-redesign Phase 0 (relaxation) — _redesign_03_invoice_job_nullable (UNAPPLIED)
-- Invoice.job_id made NULLABLE: deposit + orphan invoices have no job (spec §6).
-- Pulled forward from Phase D: deposit-as-invoice (Phase 2a) cannot persist a job-less invoice otherwise.
-- Safe relaxation: no existing NULL rows, no backfill; FK switches to ON DELETE SET NULL (job-delete is controller-guarded; Phase D sets the final Restrict spine).

-- DropForeignKey
ALTER TABLE "invoices" DROP CONSTRAINT "invoices_job_id_fkey";

-- AlterTable
ALTER TABLE "invoices" ALTER COLUMN "job_id" DROP NOT NULL;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

