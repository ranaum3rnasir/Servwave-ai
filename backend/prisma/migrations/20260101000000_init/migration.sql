-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('DRAFT', 'SENT', 'PENDING', 'APPROVED', 'DECLINED', 'EXPIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "DepositStatus" AS ENUM ('REQUESTED', 'PAID', 'VOIDED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('UNASSIGNED', 'SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InvoiceStatus" AS ENUM ('DRAFT', 'SENT', 'PARTIAL', 'PAID', 'VOIDED');

-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CARD', 'CASH', 'CHECK', 'BANK_TRANSFER');

-- CreateEnum
CREATE TYPE "AttachmentEntity" AS ENUM ('LEAD', 'ESTIMATE', 'JOB', 'INVOICE');

-- CreateEnum
CREATE TYPE "NoteEntity" AS ENUM ('CUSTOMER', 'LEAD', 'ESTIMATE', 'JOB', 'INVOICE');

-- CreateEnum
CREATE TYPE "PriceBookItemType" AS ENUM ('SERVICE', 'MATERIAL');

-- CreateEnum
CREATE TYPE "AttachmentContext" AS ENUM ('WALKTHROUGH', 'JOB_WORK', 'ESTIMATE', 'OTHER');

-- CreateEnum
CREATE TYPE "DiscountType" AS ENUM ('PERCENTAGE', 'FIXED_AMOUNT');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "password_hash" TEXT NOT NULL DEFAULT '',
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customers" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "ad_source" TEXT,
    "allow_billing" BOOLEAN NOT NULL DEFAULT false,
    "company_name" TEXT,
    "first_name" TEXT NOT NULL,
    "last_name" TEXT NOT NULL,
    "phone_ext" TEXT,
    "secondary_phone" TEXT,
    "secondary_phone_ext" TEXT,
    "tax_exempt" BOOLEAN NOT NULL DEFAULT false,
    "payment_type" TEXT,

    CONSTRAINT "customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "customer_emails" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "label" VARCHAR(50),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "customer_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "service_locations" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "address_line1" TEXT NOT NULL,
    "address_line2" TEXT,
    "city" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "zip" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "service_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "leads" (
    "id" UUID NOT NULL,
    "lead_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "assigned_to" UUID,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "service_request" TEXT NOT NULL,
    "walkthrough_scheduled_at" TIMESTAMP(3),
    "walkthrough_completed_at" TIMESTAMP(3),
    "walkthrough_notes" TEXT,
    "walkthrough_duration_minutes" INTEGER,
    "walkthrough_assigned_to" UUID,
    "walkthrough_needed" BOOLEAN NOT NULL DEFAULT true,
    "walkthrough_cancelled_at" TIMESTAMP(3),
    "walkthrough_cancelled_reason" TEXT,
    "walkthrough_cancelled_by" UUID,
    "contacted_at" TIMESTAMP(3),
    "contacted_note" TEXT,
    "notes" TEXT,
    "lost_at" TIMESTAMP(3),
    "lost_reason" TEXT,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "job_source" TEXT,
    "job_type" TEXT,
    "scheduled_end" TIMESTAMP(3),
    "scheduled_start" TIMESTAMP(3),
    "service_address_line1" TEXT,
    "service_address_line2" TEXT,
    "service_city" TEXT,
    "service_state" TEXT,
    "service_zip" TEXT,

    CONSTRAINT "leads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimates" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "estimate_number" TEXT NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'DRAFT',
    "sent_at" TIMESTAMP(3),
    "approved_at" TIMESTAMP(3),
    "declined_at" TIMESTAMP(3),
    "expired_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "scope_notes" TEXT,
    "subtotal" DECIMAL(12,2) NOT NULL,
    "tax_amount" DECIMAL(12,2) NOT NULL,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "public_token" TEXT,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "tax_rate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "discount_type" "DiscountType",
    "discount_value" DECIMAL(12,2),
    "discount_name" TEXT,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "signature_data" TEXT,
    "signature_ip" TEXT,
    "signature_at" TIMESTAMP(3),
    "valid_until" TIMESTAMP(3),

    CONSTRAINT "estimates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_line_items" (
    "id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
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

    CONSTRAINT "estimate_line_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deposits" (
    "id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'REQUESTED',
    "deposit_percentage" DECIMAL(5,2) NOT NULL,
    "payment_method" "PaymentMethod",
    "payment_method_selected_at" TIMESTAMP(3),
    "surcharge_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "marked_received_by" UUID,
    "marked_received_at" TIMESTAMP(3),
    "reference_number" TEXT,
    "notes" TEXT,
    "total_refunded" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "refund_reason" TEXT,
    "refund_reason_category" TEXT,
    "refunded_at" TIMESTAMP(3),
    "refunded_by" UUID,
    "voided_at" TIMESTAMP(3),
    "voided_by" UUID,
    "receipt_sent_at" TIMESTAMP(3),
    "stripe_payment_intent_id" TEXT,
    "stripe_payment_link_id" TEXT,
    "stripe_payment_link_url" TEXT,
    "stripe_checkout_session_id" TEXT,
    "stripe_refund_id" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_send_configs" (
    "id" UUID NOT NULL,
    "estimate_id" UUID NOT NULL,
    "message_body" TEXT,
    "deposit_required" BOOLEAN NOT NULL DEFAULT true,
    "deposit_percentage" DECIMAL(5,2) NOT NULL,
    "deposit_amount" DECIMAL(12,2) NOT NULL,
    "payment_methods" JSONB NOT NULL DEFAULT '[]',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "estimate_send_configs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stripe_events" (
    "id" UUID NOT NULL,
    "stripe_event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "processed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stripe_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jobs" (
    "id" UUID NOT NULL,
    "job_number" TEXT NOT NULL,
    "customer_id" UUID NOT NULL,
    "service_location_id" UUID NOT NULL,
    "estimate_id" UUID,
    "is_urgent" BOOLEAN NOT NULL DEFAULT false,
    "urgency_reason" TEXT,
    "status" "JobStatus" NOT NULL DEFAULT 'UNASSIGNED',
    "assigned_to" UUID,
    "scheduled_start" TIMESTAMP(3),
    "scheduled_end" TIMESTAMP(3),
    "is_all_day" BOOLEAN NOT NULL DEFAULT false,
    "scope_notes" TEXT,
    "completed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_reason" TEXT,
    "started_at" TIMESTAMP(3),
    "estimated_duration" INTEGER,
    "completion_notes" TEXT,
    "walkthrough_notes" TEXT,
    "walkthrough_completed_at" TIMESTAMP(3),
    "walkthrough_assigned_to" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_charges" (
    "id" UUID NOT NULL,
    "job_id" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "unit_price" DECIMAL(12,2) NOT NULL,
    "is_taxable" BOOLEAN NOT NULL DEFAULT true,
    "line_total" DECIMAL(12,2) NOT NULL,

    CONSTRAINT "job_charges_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" UUID NOT NULL,
    "invoice_number" TEXT NOT NULL,
    "job_id" UUID NOT NULL,
    "status" "InvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "tax_amount" DECIMAL(12,2) NOT NULL,
    "deposit_credit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total_amount" DECIMAL(12,2) NOT NULL,
    "amount_due" DECIMAL(12,2) NOT NULL,
    "discount_amount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "tax_rate" DECIMAL(5,4) NOT NULL DEFAULT 0,
    "voided_at" TIMESTAMP(3),
    "voided_reason" TEXT,
    "public_token" TEXT,
    "sent_at" TIMESTAMP(3),
    "paid_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "due_date" TIMESTAMPTZ(6),

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "amount" DECIMAL(12,2) NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "paid_at" TIMESTAMP(3) NOT NULL,
    "collected_by" UUID,
    "stripe_payment_intent_id" TEXT,
    "reference_number" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "entity_type" "AttachmentEntity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_url" TEXT NOT NULL,
    "file_type" TEXT NOT NULL,
    "file_size" INTEGER NOT NULL,
    "display_name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "context" "AttachmentContext" NOT NULL DEFAULT 'OTHER',
    "uploaded_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notes" (
    "id" UUID NOT NULL,
    "entity_type" "NoteEntity" NOT NULL,
    "entity_id" UUID NOT NULL,
    "content" TEXT NOT NULL,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timeline_events" (
    "id" UUID NOT NULL,
    "entity_type" TEXT NOT NULL,
    "entity_id" UUID NOT NULL,
    "event_type" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB,
    "created_by" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "timeline_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tags" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#6B7280',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "lead_tags" (
    "lead_id" UUID NOT NULL,
    "tag_id" UUID NOT NULL,

    CONSTRAINT "lead_tags_pkey" PRIMARY KEY ("lead_id","tag_id")
);

-- CreateTable
CREATE TABLE "price_book_categories" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "parent_id" UUID,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_book_categories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "price_book_items" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "image_url" VARCHAR(500),
    "type" "PriceBookItemType" NOT NULL DEFAULT 'SERVICE',
    "category_id" UUID,
    "unit_cost" DECIMAL(12,2),
    "unit_price" DECIMAL(12,2) NOT NULL,
    "taxable" BOOLEAN NOT NULL DEFAULT true,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "price_book_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "state_tax_rates" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "state_code" VARCHAR(2) NOT NULL,
    "state_name" VARCHAR(50) NOT NULL,
    "tax_rate" DECIMAL(5,4) NOT NULL,

    CONSTRAINT "state_tax_rates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "app_settings" (
    "key" VARCHAR(100) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE INDEX "customers_email_idx" ON "customers"("email");

-- CreateIndex
CREATE INDEX "customers_phone_idx" ON "customers"("phone");

-- CreateIndex
CREATE INDEX "customer_emails_customer_id_idx" ON "customer_emails"("customer_id");

-- CreateIndex
CREATE INDEX "service_locations_customer_id_idx" ON "service_locations"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "leads_lead_number_key" ON "leads"("lead_number");

-- CreateIndex
CREATE INDEX "leads_assigned_to_idx" ON "leads"("assigned_to");

-- CreateIndex
CREATE INDEX "leads_status_idx" ON "leads"("status");

-- CreateIndex
CREATE INDEX "leads_customer_id_idx" ON "leads"("customer_id");

-- CreateIndex
CREATE INDEX "leads_walkthrough_assigned_to_idx" ON "leads"("walkthrough_assigned_to");

-- CreateIndex
CREATE UNIQUE INDEX "estimates_estimate_number_key" ON "estimates"("estimate_number");

-- CreateIndex
CREATE UNIQUE INDEX "estimates_public_token_key" ON "estimates"("public_token");

-- CreateIndex
CREATE INDEX "estimates_lead_id_idx" ON "estimates"("lead_id");

-- CreateIndex
CREATE INDEX "estimates_status_idx" ON "estimates"("status");

-- CreateIndex
CREATE INDEX "estimates_created_by_idx" ON "estimates"("created_by");

-- CreateIndex
CREATE INDEX "estimate_line_items_price_book_item_id_idx" ON "estimate_line_items"("price_book_item_id");

-- CreateIndex
CREATE UNIQUE INDEX "deposits_estimate_id_key" ON "deposits"("estimate_id");

-- CreateIndex
CREATE INDEX "deposits_status_idx" ON "deposits"("status");

-- CreateIndex
CREATE UNIQUE INDEX "estimate_send_configs_estimate_id_key" ON "estimate_send_configs"("estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "stripe_events_stripe_event_id_key" ON "stripe_events"("stripe_event_id");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_job_number_key" ON "jobs"("job_number");

-- CreateIndex
CREATE UNIQUE INDEX "jobs_estimate_id_key" ON "jobs"("estimate_id");

-- CreateIndex
CREATE INDEX "jobs_customer_id_idx" ON "jobs"("customer_id");

-- CreateIndex
CREATE INDEX "jobs_assigned_to_idx" ON "jobs"("assigned_to");

-- CreateIndex
CREATE INDEX "jobs_status_idx" ON "jobs"("status");

-- CreateIndex
CREATE INDEX "jobs_scheduled_start_idx" ON "jobs"("scheduled_start");

-- CreateIndex
CREATE INDEX "jobs_estimate_id_idx" ON "jobs"("estimate_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoice_number_key" ON "invoices"("invoice_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_job_id_key" ON "invoices"("job_id");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_public_token_key" ON "invoices"("public_token");

-- CreateIndex
CREATE INDEX "invoices_status_idx" ON "invoices"("status");

-- CreateIndex
CREATE INDEX "payments_invoice_id_idx" ON "payments"("invoice_id");

-- CreateIndex
CREATE INDEX "attachments_entity_type_entity_id_idx" ON "attachments"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "notes_entity_type_entity_id_idx" ON "notes"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "timeline_events_entity_type_entity_id_idx" ON "timeline_events"("entity_type", "entity_id");

-- CreateIndex
CREATE INDEX "timeline_events_created_at_idx" ON "timeline_events"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "tags_name_key" ON "tags"("name");

-- CreateIndex
CREATE INDEX "price_book_items_category_id_idx" ON "price_book_items"("category_id");

-- CreateIndex
CREATE INDEX "price_book_items_type_idx" ON "price_book_items"("type");

-- CreateIndex
CREATE UNIQUE INDEX "state_tax_rates_state_code_key" ON "state_tax_rates"("state_code");

-- AddForeignKey
ALTER TABLE "customer_emails" ADD CONSTRAINT "customer_emails_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "service_locations" ADD CONSTRAINT "service_locations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_walkthrough_assigned_to_fkey" FOREIGN KEY ("walkthrough_assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_walkthrough_cancelled_by_fkey" FOREIGN KEY ("walkthrough_cancelled_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_price_book_item_id_fkey" FOREIGN KEY ("price_book_item_id") REFERENCES "price_book_items"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_marked_received_by_fkey" FOREIGN KEY ("marked_received_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_refunded_by_fkey" FOREIGN KEY ("refunded_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_voided_by_fkey" FOREIGN KEY ("voided_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_send_configs" ADD CONSTRAINT "estimate_send_configs_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_assigned_to_fkey" FOREIGN KEY ("assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_walkthrough_assigned_to_fkey" FOREIGN KEY ("walkthrough_assigned_to") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jobs" ADD CONSTRAINT "jobs_service_location_id_fkey" FOREIGN KEY ("service_location_id") REFERENCES "service_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_charges" ADD CONSTRAINT "job_charges_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_collected_by_fkey" FOREIGN KEY ("collected_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploaded_by_fkey" FOREIGN KEY ("uploaded_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notes" ADD CONSTRAINT "notes_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "lead_tags" ADD CONSTRAINT "lead_tags_tag_id_fkey" FOREIGN KEY ("tag_id") REFERENCES "tags"("id") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "price_book_categories" ADD CONSTRAINT "price_book_categories_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "price_book_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_category_id_fkey" FOREIGN KEY ("category_id") REFERENCES "price_book_categories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

