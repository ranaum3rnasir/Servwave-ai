-- AlterTable
ALTER TABLE "customers" ADD COLUMN     "membership_tier" TEXT,
ADD COLUMN     "sla_profile" TEXT;

-- AlterTable
ALTER TABLE "price_book_categories" ADD COLUMN     "description" TEXT,
ADD COLUMN     "photo_url" TEXT,
ADD COLUMN     "trade" TEXT;

-- AlterTable
ALTER TABLE "price_book_items" ADD COLUMN     "brand_id" UUID,
ADD COLUMN     "customer_description" TEXT,
ADD COLUMN     "customer_name" TEXT,
ADD COLUMN     "hazmat" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "key_features" JSONB,
ADD COLUMN     "kind" TEXT,
ADD COLUMN     "list_price" DECIMAL(12,2),
ADD COLUMN     "mpn" TEXT,
ADD COLUMN     "photo_url" TEXT,
ADD COLUMN     "sell_price" DECIMAL(12,2),
ADD COLUMN     "serialized" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "serials" JSONB,
ADD COLUMN     "sku" TEXT,
ADD COLUMN     "status" TEXT,
ADD COLUMN     "trade" TEXT,
ADD COLUMN     "uom" TEXT,
ADD COLUMN     "upc" TEXT,
ADD COLUMN     "vendor_id" UUID,
ADD COLUMN     "visibility" TEXT;

-- CreateTable
CREATE TABLE "brands" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "logo_url" TEXT,
    "website" TEXT,
    "description" TEXT,
    "default_markup_pct" DECIMAL(10,2),
    "default_vendor_id" UUID,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "brands_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendors" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "payment_terms" TEXT NOT NULL,
    "lead_time_days" INTEGER NOT NULL,
    "transmit_method" TEXT NOT NULL,
    "transmit_methods" JSONB,
    "contact_person_name" TEXT,
    "contact_email" TEXT,
    "contact_phone" TEXT,
    "account_number" TEXT,
    "website" TEXT,
    "pickup_address" TEXT,
    "notes" TEXT,
    "status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "vendors_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vendor_contacts" (
    "id" UUID NOT NULL,
    "vendor_id" UUID NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "role" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "vendor_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "branches" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "code" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "manager_name" TEXT,
    "timezone" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "branches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_locations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "branch_id" UUID,
    "primary_tech_id" UUID,
    "vehicle" TEXT,
    "staging_areas" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "inventory_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "item_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "on_hand" INTEGER NOT NULL DEFAULT 0,
    "reserved" INTEGER NOT NULL DEFAULT 0,
    "min" INTEGER,
    "max" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_movements" (
    "id" UUID NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "item_sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "qty" INTEGER NOT NULL,
    "from_location_id" UUID,
    "to_location_id" UUID,
    "reference" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "stock_movements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_orders" (
    "id" UUID NOT NULL,
    "po_number" TEXT NOT NULL,
    "vendor" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "job_id" UUID,
    "customer_id" UUID,
    "customer" TEXT,
    "site" TEXT,
    "trade" TEXT,
    "ordered_at" TIMESTAMP(3) NOT NULL,
    "expected_date" TIMESTAMP(3),
    "staged_as_job_stage_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "purchase_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_order_lines" (
    "id" UUID NOT NULL,
    "purchase_order_id" UUID NOT NULL,
    "item_sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty_ordered" DECIMAL(10,2) NOT NULL,
    "qty_received" DECIMAL(10,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "purchase_order_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfqs" (
    "id" UUID NOT NULL,
    "rfq_number" TEXT NOT NULL,
    "job_id" UUID,
    "job_number" TEXT,
    "customer_id" UUID,
    "customer" TEXT,
    "site" TEXT,
    "trade" TEXT,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "responses_due_by" TIMESTAMP(3) NOT NULL,
    "lines_summary" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "rfqs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_lines" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "item_sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "uom" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "rfq_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfq_quotes" (
    "id" UUID NOT NULL,
    "rfq_id" UUID NOT NULL,
    "vendor" TEXT NOT NULL,
    "total" DECIMAL(12,2) NOT NULL,
    "lead_time_days" INTEGER NOT NULL,
    "recommended" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "rfq_quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "estimate_reservations" (
    "id" UUID NOT NULL,
    "estimate_id" UUID,
    "estimate_number" TEXT NOT NULL,
    "job_id" UUID,
    "job_number" TEXT,
    "customer_id" UUID,
    "customer" TEXT NOT NULL,
    "customer_email" TEXT,
    "site" TEXT,
    "trade" TEXT,
    "approved_at" TIMESTAMP(3) NOT NULL,
    "reserved_total" DECIMAL(12,2) NOT NULL,
    "lines_summary" JSONB NOT NULL,
    "preferred_vendor" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "estimate_reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservation_lines" (
    "id" UUID NOT NULL,
    "estimate_reservation_id" UUID NOT NULL,
    "item_sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "uom" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "reservation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inventory_emails" (
    "id" UUID NOT NULL,
    "rfq_id" UUID,
    "estimate_reservation_id" UUID,
    "direction" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "from" TEXT NOT NULL,
    "to" JSONB NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "sent_at" TIMESTAMP(3) NOT NULL,
    "attachments" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "inventory_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stages" (
    "id" UUID NOT NULL,
    "job_id" UUID,
    "job_number" TEXT NOT NULL,
    "customer_id" UUID,
    "customer" TEXT NOT NULL,
    "site" TEXT NOT NULL,
    "scheduled_for" TIMESTAMP(3),
    "assigned_tech_id" UUID,
    "assigned_tech" TEXT,
    "trade" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "pickup_vendor_id" TEXT,
    "pickup_address" TEXT,
    "staged_location_id" UUID,
    "staged_area" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "job_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stage_lines" (
    "id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "item_sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty_ordered" DECIMAL(10,2) NOT NULL,
    "qty_received" DECIMAL(10,2) NOT NULL,
    "vendor" TEXT NOT NULL,
    "po_number" TEXT,
    "purchase_order_id" UUID,
    "expected_date" TIMESTAMP(3),
    "serialized" BOOLEAN NOT NULL DEFAULT false,
    "received_serials" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "job_stage_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_stage_attachments" (
    "id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "data_url" TEXT NOT NULL,
    "mime_type" TEXT,
    "caption" TEXT,
    "uploaded_at" TIMESTAMP(3) NOT NULL,
    "uploaded_by" TEXT NOT NULL,
    "source" TEXT,
    "pdf_page_number" INTEGER,
    "pdf_file_name" TEXT,
    "duration_seconds" INTEGER,
    "size_bytes" INTEGER,
    "po_number" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "job_stage_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_audit_entries" (
    "id" UUID NOT NULL,
    "job_stage_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "actor_name" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "old_value" TEXT,
    "new_value" TEXT NOT NULL,
    "comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "stage_audit_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_approvals" (
    "id" UUID NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "requested_by_tech_id" UUID,
    "requested_by_tech_name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "item_sku" TEXT NOT NULL,
    "item_name" TEXT NOT NULL,
    "uom" TEXT NOT NULL,
    "qty" DECIMAL(10,2) NOT NULL,
    "from_location_id" TEXT,
    "from_location_name" TEXT NOT NULL,
    "to_location_id" TEXT,
    "to_location_name" TEXT,
    "job_id" UUID,
    "job_number" TEXT,
    "customer_id" UUID,
    "customer" TEXT,
    "reason" TEXT,
    "serial_captured" TEXT,
    "photo_url" TEXT,
    "status" TEXT NOT NULL,
    "reviewed_at" TIMESTAMP(3),
    "reviewed_by_id" UUID,
    "reviewed_by_name" TEXT,
    "review_comment" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "stock_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_approval_modifications" (
    "id" UUID NOT NULL,
    "stock_approval_id" UUID NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "by_name" TEXT NOT NULL,
    "note" TEXT NOT NULL,
    "post_decision" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "stock_approval_modifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "photo_url" TEXT,
    "group_type" TEXT NOT NULL,
    "flat_rate_price_override" DECIMAL(12,2),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "item_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "item_group_lines" (
    "id" UUID NOT NULL,
    "group_id" UUID NOT NULL,
    "item_id" UUID,
    "name" TEXT NOT NULL,
    "quantity" DECIMAL(10,2) NOT NULL,
    "price_override" DECIMAL(12,2),
    "cost_override" DECIMAL(12,2),
    "notes" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "item_group_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_sessions" (
    "id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "from_number" TEXT NOT NULL,
    "to_number" TEXT NOT NULL,
    "tracking_source" TEXT,
    "status" TEXT NOT NULL,
    "answered_by" JSONB NOT NULL,
    "agent_id" UUID,
    "started_at" TIMESTAMP(3) NOT NULL,
    "duration_sec" INTEGER,
    "customer_id" UUID,
    "job_id" UUID,
    "job_label" TEXT,
    "disposition" TEXT,
    "sentiment" TEXT,
    "summary" TEXT,
    "transcript_preview" TEXT,
    "has_recording" BOOLEAN,
    "qa_score" INTEGER,
    "review_flag" TEXT,
    "call_flow" TEXT,
    "tags" JSONB,
    "revenue" DECIMAL(12,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "call_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "contacts" (
    "id" UUID NOT NULL,
    "customer_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "preferred_lang" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "channel_identities" (
    "id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "label" TEXT,
    "consented" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "channel_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "phone_agents" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "answer_rate_pct" INTEGER NOT NULL DEFAULT 0,
    "booking_rate_pct" INTEGER NOT NULL DEFAULT 0,
    "aht_sec" INTEGER NOT NULL DEFAULT 0,
    "sentiment_pct" INTEGER NOT NULL DEFAULT 0,
    "revenue" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "script_adherence_pct" INTEGER NOT NULL DEFAULT 0,
    "containment_pct" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "phone_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "blocked_numbers" (
    "id" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "name" TEXT,
    "reason" TEXT NOT NULL,
    "note" TEXT,
    "blocked_at" TIMESTAMP(3) NOT NULL,
    "blocked_by" TEXT NOT NULL,
    "blocked_by_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "blocked_numbers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_threads" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "channel" TEXT NOT NULL DEFAULT 'sms',
    "campaign_type" TEXT NOT NULL,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "kind" TEXT,
    "archived" BOOLEAN DEFAULT false,
    "title" TEXT,
    "subtitle" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "message_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL,
    "thread_id" UUID NOT NULL,
    "direction" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL,
    "status" TEXT,
    "automated" BOOLEAN DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "text_templates" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "info" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "default_body" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "audience" TEXT NOT NULL,
    "notify_toggle" BOOLEAN DEFAULT false,
    "notify_on" BOOLEAN DEFAULT false,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "text_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "text_automations" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "template_id" UUID NOT NULL,
    "timing" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "text_automations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_chats" (
    "id" UUID NOT NULL,
    "customer_id" UUID,
    "name" TEXT NOT NULL,
    "org" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "unread" INTEGER NOT NULL DEFAULT 0,
    "last_at" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "whatsapp_chats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "whatsapp_messages" (
    "id" UUID NOT NULL,
    "chat_id" UUID NOT NULL,
    "from" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" TEXT NOT NULL,
    "status" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "whatsapp_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "emails" (
    "id" UUID NOT NULL,
    "account" TEXT NOT NULL,
    "from" JSONB NOT NULL,
    "to" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL,
    "body" JSONB NOT NULL,
    "at" TEXT NOT NULL,
    "ts" INTEGER NOT NULL,
    "unread" BOOLEAN NOT NULL DEFAULT true,
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "folder" TEXT NOT NULL,
    "labels" JSONB,
    "has_attachment" BOOLEAN DEFAULT false,
    "attachments" JSONB,
    "thread_id" TEXT,
    "important" BOOLEAN DEFAULT false,
    "snoozed_until" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "member_ids" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "email_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "email_forward_rules" (
    "id" UUID NOT NULL,
    "from" TEXT NOT NULL,
    "to_group_id" UUID,
    "to_member_id" UUID,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "email_forward_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_flows" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "structure" TEXT NOT NULL,
    "record" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL,
    "hours_mode" TEXT NOT NULL,
    "open_nodes" JSONB NOT NULL,
    "closed_nodes" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "call_flows_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_groups" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "ring" TEXT NOT NULL,
    "members" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "call_groups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_scenarios" (
    "id" UUID NOT NULL,
    "slug" TEXT,
    "role_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "script_focus" TEXT NOT NULL,
    "trainer_name" TEXT NOT NULL,
    "persona" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "dialogue" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "training_scenarios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "training_sessions" (
    "id" UUID NOT NULL,
    "trainee_id" UUID,
    "trainee_name" TEXT NOT NULL,
    "trainee_role" TEXT NOT NULL,
    "role_id" TEXT NOT NULL,
    "scenario_id" UUID,
    "scenario_slug" TEXT,
    "scenario_title" TEXT NOT NULL,
    "difficulty" TEXT NOT NULL,
    "trainer_name" TEXT NOT NULL,
    "score" INTEGER,
    "outcome" TEXT NOT NULL,
    "duration_sec" INTEGER NOT NULL,
    "completed_at" TIMESTAMP(3) NOT NULL,
    "has_recording" BOOLEAN NOT NULL DEFAULT false,
    "coaching_note" TEXT NOT NULL,
    "transcript" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "organization_id" UUID NOT NULL,

    CONSTRAINT "training_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "brands_organization_id_idx" ON "brands"("organization_id");

-- CreateIndex
CREATE INDEX "brands_default_vendor_id_idx" ON "brands"("default_vendor_id");

-- CreateIndex
CREATE INDEX "vendors_organization_id_idx" ON "vendors"("organization_id");

-- CreateIndex
CREATE INDEX "vendor_contacts_vendor_id_idx" ON "vendor_contacts"("vendor_id");

-- CreateIndex
CREATE INDEX "vendor_contacts_organization_id_idx" ON "vendor_contacts"("organization_id");

-- CreateIndex
CREATE INDEX "branches_organization_id_idx" ON "branches"("organization_id");

-- CreateIndex
CREATE INDEX "inventory_locations_organization_id_idx" ON "inventory_locations"("organization_id");

-- CreateIndex
CREATE INDEX "inventory_locations_branch_id_idx" ON "inventory_locations"("branch_id");

-- CreateIndex
CREATE INDEX "inventory_locations_primary_tech_id_idx" ON "inventory_locations"("primary_tech_id");

-- CreateIndex
CREATE INDEX "stock_balances_item_id_idx" ON "stock_balances"("item_id");

-- CreateIndex
CREATE INDEX "stock_balances_location_id_idx" ON "stock_balances"("location_id");

-- CreateIndex
CREATE INDEX "stock_balances_organization_id_idx" ON "stock_balances"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_item_id_location_id_key" ON "stock_balances"("item_id", "location_id");

-- CreateIndex
CREATE INDEX "stock_movements_organization_id_idx" ON "stock_movements"("organization_id");

-- CreateIndex
CREATE INDEX "stock_movements_from_location_id_idx" ON "stock_movements"("from_location_id");

-- CreateIndex
CREATE INDEX "stock_movements_to_location_id_idx" ON "stock_movements"("to_location_id");

-- CreateIndex
CREATE INDEX "purchase_orders_organization_id_idx" ON "purchase_orders"("organization_id");

-- CreateIndex
CREATE INDEX "purchase_orders_job_id_idx" ON "purchase_orders"("job_id");

-- CreateIndex
CREATE INDEX "purchase_orders_customer_id_idx" ON "purchase_orders"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_orders_organization_id_po_number_key" ON "purchase_orders"("organization_id", "po_number");

-- CreateIndex
CREATE INDEX "purchase_order_lines_purchase_order_id_idx" ON "purchase_order_lines"("purchase_order_id");

-- CreateIndex
CREATE INDEX "purchase_order_lines_organization_id_idx" ON "purchase_order_lines"("organization_id");

-- CreateIndex
CREATE INDEX "rfqs_organization_id_idx" ON "rfqs"("organization_id");

-- CreateIndex
CREATE INDEX "rfqs_job_id_idx" ON "rfqs"("job_id");

-- CreateIndex
CREATE INDEX "rfqs_customer_id_idx" ON "rfqs"("customer_id");

-- CreateIndex
CREATE UNIQUE INDEX "rfqs_organization_id_rfq_number_key" ON "rfqs"("organization_id", "rfq_number");

-- CreateIndex
CREATE INDEX "rfq_lines_rfq_id_idx" ON "rfq_lines"("rfq_id");

-- CreateIndex
CREATE INDEX "rfq_lines_organization_id_idx" ON "rfq_lines"("organization_id");

-- CreateIndex
CREATE INDEX "rfq_quotes_rfq_id_idx" ON "rfq_quotes"("rfq_id");

-- CreateIndex
CREATE INDEX "rfq_quotes_organization_id_idx" ON "rfq_quotes"("organization_id");

-- CreateIndex
CREATE INDEX "estimate_reservations_organization_id_idx" ON "estimate_reservations"("organization_id");

-- CreateIndex
CREATE INDEX "estimate_reservations_estimate_id_idx" ON "estimate_reservations"("estimate_id");

-- CreateIndex
CREATE INDEX "estimate_reservations_job_id_idx" ON "estimate_reservations"("job_id");

-- CreateIndex
CREATE INDEX "estimate_reservations_customer_id_idx" ON "estimate_reservations"("customer_id");

-- CreateIndex
CREATE INDEX "reservation_lines_estimate_reservation_id_idx" ON "reservation_lines"("estimate_reservation_id");

-- CreateIndex
CREATE INDEX "reservation_lines_organization_id_idx" ON "reservation_lines"("organization_id");

-- CreateIndex
CREATE INDEX "inventory_emails_rfq_id_idx" ON "inventory_emails"("rfq_id");

-- CreateIndex
CREATE INDEX "inventory_emails_estimate_reservation_id_idx" ON "inventory_emails"("estimate_reservation_id");

-- CreateIndex
CREATE INDEX "inventory_emails_organization_id_idx" ON "inventory_emails"("organization_id");

-- CreateIndex
CREATE INDEX "job_stages_organization_id_idx" ON "job_stages"("organization_id");

-- CreateIndex
CREATE INDEX "job_stages_job_id_idx" ON "job_stages"("job_id");

-- CreateIndex
CREATE INDEX "job_stages_customer_id_idx" ON "job_stages"("customer_id");

-- CreateIndex
CREATE INDEX "job_stages_assigned_tech_id_idx" ON "job_stages"("assigned_tech_id");

-- CreateIndex
CREATE INDEX "job_stage_lines_job_stage_id_idx" ON "job_stage_lines"("job_stage_id");

-- CreateIndex
CREATE INDEX "job_stage_lines_organization_id_idx" ON "job_stage_lines"("organization_id");

-- CreateIndex
CREATE INDEX "job_stage_attachments_job_stage_id_idx" ON "job_stage_attachments"("job_stage_id");

-- CreateIndex
CREATE INDEX "job_stage_attachments_organization_id_idx" ON "job_stage_attachments"("organization_id");

-- CreateIndex
CREATE INDEX "stage_audit_entries_job_stage_id_idx" ON "stage_audit_entries"("job_stage_id");

-- CreateIndex
CREATE INDEX "stage_audit_entries_organization_id_idx" ON "stage_audit_entries"("organization_id");

-- CreateIndex
CREATE INDEX "stock_approvals_organization_id_idx" ON "stock_approvals"("organization_id");

-- CreateIndex
CREATE INDEX "stock_approvals_requested_by_tech_id_idx" ON "stock_approvals"("requested_by_tech_id");

-- CreateIndex
CREATE INDEX "stock_approvals_reviewed_by_id_idx" ON "stock_approvals"("reviewed_by_id");

-- CreateIndex
CREATE INDEX "stock_approvals_job_id_idx" ON "stock_approvals"("job_id");

-- CreateIndex
CREATE INDEX "stock_approvals_customer_id_idx" ON "stock_approvals"("customer_id");

-- CreateIndex
CREATE INDEX "stock_approval_modifications_stock_approval_id_idx" ON "stock_approval_modifications"("stock_approval_id");

-- CreateIndex
CREATE INDEX "stock_approval_modifications_organization_id_idx" ON "stock_approval_modifications"("organization_id");

-- CreateIndex
CREATE INDEX "item_groups_organization_id_idx" ON "item_groups"("organization_id");

-- CreateIndex
CREATE INDEX "item_group_lines_group_id_idx" ON "item_group_lines"("group_id");

-- CreateIndex
CREATE INDEX "item_group_lines_organization_id_idx" ON "item_group_lines"("organization_id");

-- CreateIndex
CREATE INDEX "call_sessions_organization_id_idx" ON "call_sessions"("organization_id");

-- CreateIndex
CREATE INDEX "call_sessions_customer_id_idx" ON "call_sessions"("customer_id");

-- CreateIndex
CREATE INDEX "call_sessions_job_id_idx" ON "call_sessions"("job_id");

-- CreateIndex
CREATE INDEX "call_sessions_agent_id_idx" ON "call_sessions"("agent_id");

-- CreateIndex
CREATE INDEX "contacts_customer_id_idx" ON "contacts"("customer_id");

-- CreateIndex
CREATE INDEX "contacts_organization_id_idx" ON "contacts"("organization_id");

-- CreateIndex
CREATE INDEX "channel_identities_contact_id_idx" ON "channel_identities"("contact_id");

-- CreateIndex
CREATE INDEX "channel_identities_value_idx" ON "channel_identities"("value");

-- CreateIndex
CREATE INDEX "channel_identities_organization_id_idx" ON "channel_identities"("organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "phone_agents_user_id_key" ON "phone_agents"("user_id");

-- CreateIndex
CREATE INDEX "phone_agents_organization_id_idx" ON "phone_agents"("organization_id");

-- CreateIndex
CREATE INDEX "blocked_numbers_organization_id_idx" ON "blocked_numbers"("organization_id");

-- CreateIndex
CREATE INDEX "blocked_numbers_blocked_by_id_idx" ON "blocked_numbers"("blocked_by_id");

-- CreateIndex
CREATE INDEX "message_threads_organization_id_idx" ON "message_threads"("organization_id");

-- CreateIndex
CREATE INDEX "message_threads_customer_id_idx" ON "message_threads"("customer_id");

-- CreateIndex
CREATE INDEX "messages_thread_id_idx" ON "messages"("thread_id");

-- CreateIndex
CREATE INDEX "messages_organization_id_idx" ON "messages"("organization_id");

-- CreateIndex
CREATE INDEX "text_templates_organization_id_idx" ON "text_templates"("organization_id");

-- CreateIndex
CREATE INDEX "text_automations_template_id_idx" ON "text_automations"("template_id");

-- CreateIndex
CREATE INDEX "text_automations_organization_id_idx" ON "text_automations"("organization_id");

-- CreateIndex
CREATE INDEX "whatsapp_chats_organization_id_idx" ON "whatsapp_chats"("organization_id");

-- CreateIndex
CREATE INDEX "whatsapp_chats_customer_id_idx" ON "whatsapp_chats"("customer_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_chat_id_idx" ON "whatsapp_messages"("chat_id");

-- CreateIndex
CREATE INDEX "whatsapp_messages_organization_id_idx" ON "whatsapp_messages"("organization_id");

-- CreateIndex
CREATE INDEX "emails_organization_id_idx" ON "emails"("organization_id");

-- CreateIndex
CREATE INDEX "email_groups_organization_id_idx" ON "email_groups"("organization_id");

-- CreateIndex
CREATE INDEX "email_forward_rules_organization_id_idx" ON "email_forward_rules"("organization_id");

-- CreateIndex
CREATE INDEX "email_forward_rules_to_group_id_idx" ON "email_forward_rules"("to_group_id");

-- CreateIndex
CREATE INDEX "email_forward_rules_to_member_id_idx" ON "email_forward_rules"("to_member_id");

-- CreateIndex
CREATE INDEX "call_flows_organization_id_idx" ON "call_flows"("organization_id");

-- CreateIndex
CREATE INDEX "call_groups_organization_id_idx" ON "call_groups"("organization_id");

-- CreateIndex
CREATE INDEX "training_scenarios_organization_id_idx" ON "training_scenarios"("organization_id");

-- CreateIndex
CREATE INDEX "training_sessions_organization_id_idx" ON "training_sessions"("organization_id");

-- CreateIndex
CREATE INDEX "training_sessions_scenario_id_idx" ON "training_sessions"("scenario_id");

-- CreateIndex
CREATE INDEX "training_sessions_trainee_id_idx" ON "training_sessions"("trainee_id");

-- CreateIndex
CREATE INDEX "price_book_items_brand_id_idx" ON "price_book_items"("brand_id");

-- CreateIndex
CREATE INDEX "price_book_items_vendor_id_idx" ON "price_book_items"("vendor_id");

-- CreateIndex
CREATE UNIQUE INDEX "price_book_items_organization_id_sku_key" ON "price_book_items"("organization_id", "sku");

-- AddForeignKey
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_brand_id_fkey" FOREIGN KEY ("brand_id") REFERENCES "brands"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_book_items" ADD CONSTRAINT "price_book_items_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_default_vendor_id_fkey" FOREIGN KEY ("default_vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "brands" ADD CONSTRAINT "brands_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendors" ADD CONSTRAINT "vendors_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vendor_contacts" ADD CONSTRAINT "vendor_contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "branches" ADD CONSTRAINT "branches_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_branch_id_fkey" FOREIGN KEY ("branch_id") REFERENCES "branches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_primary_tech_id_fkey" FOREIGN KEY ("primary_tech_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_locations" ADD CONSTRAINT "inventory_locations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_item_id_fkey" FOREIGN KEY ("item_id") REFERENCES "price_book_items"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "inventory_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "inventory_locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_staged_as_job_stage_id_fkey" FOREIGN KEY ("staged_as_job_stage_id") REFERENCES "job_stages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_fkey" FOREIGN KEY ("purchase_order_id") REFERENCES "purchase_orders"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfqs" ADD CONSTRAINT "rfqs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_lines" ADD CONSTRAINT "rfq_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfq_quotes" ADD CONSTRAINT "rfq_quotes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_reservations" ADD CONSTRAINT "estimate_reservations_estimate_id_fkey" FOREIGN KEY ("estimate_id") REFERENCES "estimates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_reservations" ADD CONSTRAINT "estimate_reservations_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_reservations" ADD CONSTRAINT "estimate_reservations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "estimate_reservations" ADD CONSTRAINT "estimate_reservations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_estimate_reservation_id_fkey" FOREIGN KEY ("estimate_reservation_id") REFERENCES "estimate_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservation_lines" ADD CONSTRAINT "reservation_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_emails" ADD CONSTRAINT "inventory_emails_rfq_id_fkey" FOREIGN KEY ("rfq_id") REFERENCES "rfqs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_emails" ADD CONSTRAINT "inventory_emails_estimate_reservation_id_fkey" FOREIGN KEY ("estimate_reservation_id") REFERENCES "estimate_reservations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_emails" ADD CONSTRAINT "inventory_emails_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_assigned_tech_id_fkey" FOREIGN KEY ("assigned_tech_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stages" ADD CONSTRAINT "job_stages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage_lines" ADD CONSTRAINT "job_stage_lines_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage_lines" ADD CONSTRAINT "job_stage_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage_attachments" ADD CONSTRAINT "job_stage_attachments_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_stage_attachments" ADD CONSTRAINT "job_stage_attachments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_audit_entries" ADD CONSTRAINT "stage_audit_entries_job_stage_id_fkey" FOREIGN KEY ("job_stage_id") REFERENCES "job_stages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_audit_entries" ADD CONSTRAINT "stage_audit_entries_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approvals" ADD CONSTRAINT "stock_approvals_requested_by_tech_id_fkey" FOREIGN KEY ("requested_by_tech_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approvals" ADD CONSTRAINT "stock_approvals_reviewed_by_id_fkey" FOREIGN KEY ("reviewed_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approvals" ADD CONSTRAINT "stock_approvals_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approvals" ADD CONSTRAINT "stock_approvals_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approvals" ADD CONSTRAINT "stock_approvals_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approval_modifications" ADD CONSTRAINT "stock_approval_modifications_stock_approval_id_fkey" FOREIGN KEY ("stock_approval_id") REFERENCES "stock_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_approval_modifications" ADD CONSTRAINT "stock_approval_modifications_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_groups" ADD CONSTRAINT "item_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_group_lines" ADD CONSTRAINT "item_group_lines_group_id_fkey" FOREIGN KEY ("group_id") REFERENCES "item_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "item_group_lines" ADD CONSTRAINT "item_group_lines_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_sessions" ADD CONSTRAINT "call_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_identities" ADD CONSTRAINT "channel_identities_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_agents" ADD CONSTRAINT "phone_agents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "phone_agents" ADD CONSTRAINT "phone_agents_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_numbers" ADD CONSTRAINT "blocked_numbers_blocked_by_id_fkey" FOREIGN KEY ("blocked_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "blocked_numbers" ADD CONSTRAINT "blocked_numbers_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "message_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_templates" ADD CONSTRAINT "text_templates_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_automations" ADD CONSTRAINT "text_automations_template_id_fkey" FOREIGN KEY ("template_id") REFERENCES "text_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "text_automations" ADD CONSTRAINT "text_automations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_chats" ADD CONSTRAINT "whatsapp_chats_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_chats" ADD CONSTRAINT "whatsapp_chats_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_chat_id_fkey" FOREIGN KEY ("chat_id") REFERENCES "whatsapp_chats"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "whatsapp_messages" ADD CONSTRAINT "whatsapp_messages_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "emails" ADD CONSTRAINT "emails_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_groups" ADD CONSTRAINT "email_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_forward_rules" ADD CONSTRAINT "email_forward_rules_to_group_id_fkey" FOREIGN KEY ("to_group_id") REFERENCES "email_groups"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_forward_rules" ADD CONSTRAINT "email_forward_rules_to_member_id_fkey" FOREIGN KEY ("to_member_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "email_forward_rules" ADD CONSTRAINT "email_forward_rules_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_flows" ADD CONSTRAINT "call_flows_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_groups" ADD CONSTRAINT "call_groups_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_scenarios" ADD CONSTRAINT "training_scenarios_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_scenario_id_fkey" FOREIGN KEY ("scenario_id") REFERENCES "training_scenarios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_trainee_id_fkey" FOREIGN KEY ("trainee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "training_sessions" ADD CONSTRAINT "training_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

