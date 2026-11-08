-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'REFUNDED';

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "refund_reason" TEXT,
ADD COLUMN     "refund_reason_category" TEXT,
ADD COLUMN     "refunded_at" TIMESTAMP(3),
ADD COLUMN     "refunded_by" UUID,
ADD COLUMN     "total_refunded" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "stripe_account_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "refunded_amount" DECIMAL(12,2),
ADD COLUMN     "refunded_at" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "organizations_stripe_account_id_idx" ON "organizations"("stripe_account_id");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_refunded_by_fkey" FOREIGN KEY ("refunded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
