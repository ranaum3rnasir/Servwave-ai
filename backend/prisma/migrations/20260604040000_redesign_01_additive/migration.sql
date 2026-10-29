-- Entity-redesign Phase 0 — _redesign_01_additive (ADDITIVE ONLY; UNAPPLIED)
-- New enums/tables/columns + FKs. Removes nothing, tightens nothing. Safe to deploy alone.
-- See md_files/plans/entity-redesign/00-implementation-plan.md (Phase 0).

-- CreateEnum
CREATE TYPE "CustomerKind" AS ENUM ('PERSON', 'COMPANY');

-- CreateEnum
CREATE TYPE "CustomerSegment" AS ENUM ('RESIDENTIAL', 'COMMERCIAL');

-- CreateEnum
CREATE TYPE "InvoiceKind" AS ENUM ('DEPOSIT', 'STANDARD');

-- CreateEnum
CREATE TYPE "VoidPaymentReason" AS ENUM ('BOUNCED', 'ERROR', 'DUPLICATE', 'WRONG_INVOICE', 'CHARGEBACK');

-- CreateEnum
CREATE TYPE "RefundCategory" AS ENUM ('CUSTOMER_REQUEST', 'ERROR', 'GOODWILL', 'OVERPAYMENT', 'CHARGEBACK', 'OTHER');


-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "bill_to_customer_id" UUID,
ADD COLUMN     "billing_address_line1" TEXT,
ADD COLUMN     "billing_address_line2" TEXT,
ADD COLUMN     "billing_city" TEXT,
ADD COLUMN     "billing_state" TEXT,
ADD COLUMN     "billing_terms" TEXT,
ADD COLUMN     "billing_zip" TEXT,
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "kind" "CustomerKind",
ADD COLUMN     "notes" TEXT,
ADD COLUMN     "parent_id" UUID,
ADD COLUMN     "segment" "CustomerSegment",
ADD COLUMN     "source" TEXT;

-- AlterTable
ALTER TABLE "service_locations" ADD COLUMN     "archived_at" TIMESTAMP(3),
ADD COLUMN     "is_active" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "service_location_id" UUID;

-- AlterTable
ALTER TABLE "jobs" ADD COLUMN     "amount_invoiced" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "customer_id" UUID,
ADD COLUMN     "estimate_id" UUID,
ADD COLUMN     "kind" "InvoiceKind" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "net_collected" DECIMAL(12,2) NOT NULL DEFAULT 0,
ADD COLUMN     "stripe_dispute_id" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "void_category" "VoidPaymentReason",
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by" UUID,
ADD COLUMN     "voided_reason" TEXT;

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "billing_terms_options" JSONB NOT NULL DEFAULT '["Net 15","Net 30","Net 60","Due on Receipt"]';

-- CreateTable
CREATE TABLE "customer_phones" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "phone" TEXT NOT NULL,
    "label" VARCHAR(50),
    "extension" TEXT,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_phones_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_line_items" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "line_total" DECIMAL(12,2) NOT NULL,
    "price_book_item_id" UUID,
    "unit_cost" DECIMAL(12,2),
    "discount_type" "DiscountType",
    "discount_value" DECIMAL(12,2),
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "item_type" "PriceBookItemType" NOT NULL DEFAULT 'SERVICE',

    CONSTRAINT "invoice_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "refunds" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "payment_id" UUID,
    "amount" DECIMAL(12,2) NOT NULL,
    "tax_portion" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "non_taxable_concession" BOOLEAN NOT NULL DEFAULT false,
    "method" "PaymentMethod" NOT NULL,
    "reason" TEXT,
    "reason_category" "RefundCategory" NOT NULL,
    "stripe_refund_id" TEXT,
    "refunded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "refunds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credits" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "tax_portion" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "reason" TEXT,
    "category" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "credits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposit_credit_applications" (
    "id" UUID NOT NULL,
    "deposit_invoice_id" UUID NOT NULL,
    "target_invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "reversed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "deposit_credit_applications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "customer_phones_customer_id_idx" ON "customer_phones"("customer_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_invoice_id_idx" ON "invoice_line_items"("invoice_id");

-- CreateIndex
CREATE INDEX "invoice_line_items_price_book_item_id_idx" ON "invoice_line_items"("price_book_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "refunds_stripe_refund_id_key" ON "refunds"("stripe_refund_id");

-- CreateIndex
CREATE INDEX "refunds_invoice_id_idx" ON "refunds"("invoice_id");

-- CreateIndex
CREATE INDEX "refunds_payment_id_idx" ON "refunds"("payment_id");

-- CreateIndex
CREATE INDEX "refunds_organization_id_idx" ON "refunds"("organization_id");

-- CreateIndex
CREATE INDEX "credits_invoice_id_idx" ON "credits"("invoice_id");

-- CreateIndex
CREATE INDEX "credits_organization_id_idx" ON "credits"("organization_id");

-- CreateIndex
CREATE INDEX "deposit_credit_applications_deposit_invoice_id_idx" ON "deposit_credit_applications"("deposit_invoice_id");

-- CreateIndex
CREATE INDEX "deposit_credit_applications_target_invoice_id_idx" ON "deposit_credit_applications"("target_invoice_id");

-- CreateIndex
CREATE INDEX "deposit_credit_applications_organization_id_idx" ON "deposit_credit_applications"("organization_id");

-- CreateIndex
CREATE INDEX "customers_parent_id_idx" ON "customers"("parent_id");

-- CreateIndex
CREATE INDEX "customers_bill_to_customer_id_idx" ON "customers"("bill_to_customer_id");

-- CreateIndex
CREATE INDEX "leads_service_location_id_idx" ON "leads"("service_location_id");

-- CreateIndex
CREATE INDEX "invoices_customer_id_idx" ON "invoices"("customer_id");

-- CreateIndex
CREATE INDEX "invoices_estimate_id_idx" ON "invoices"("estimate_id");

-- CreateIndex
CREATE INDEX "invoices_kind_idx" ON "invoices"("kind");

-- CreateIndex
CREATE INDEX "invoices_stripe_dispute_id_idx" ON "invoices"("stripe_dispute_id");

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customers" ADD CONSTRAINT "customers_bill_to_customer_id_fkey" FOREIGN KEY ("bill_to_customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "customer_phones" ADD CONSTRAINT "customer_phones_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_service_location_id_fkey" FOREIGN KEY ("service_location_id") REFERENCES "service_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_price_book_item_id_fkey" FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_fkey" FOREIGN KEY ("payment_id") REFERENCES "payments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_refunded_by_fkey" FOREIGN KEY ("refunded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "credits" ADD CONSTRAINT "credits_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_credit_applications" ADD CONSTRAINT "deposit_credit_applications_deposit_invoice_id_fkey" FOREIGN KEY ("deposit_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_credit_applications" ADD CONSTRAINT "deposit_credit_applications_target_invoice_id_fkey" FOREIGN KEY ("target_invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposit_credit_applications" ADD CONSTRAINT "deposit_credit_applications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
