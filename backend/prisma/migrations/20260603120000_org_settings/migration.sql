-- Org Settings module: extended company profile, org-level Locations, User.location_id
-- Authored by hand (DB-free) to avoid a shadow-DB connection from a worktree against staging.
-- Additive only: new nullable/defaulted columns, one new table, one new FK column. No data loss.

-- AlterTable: organizations — extended company profile + MFA policy
ALTER TABLE "organizations"
  ADD COLUMN "display_name"          VARCHAR(200),
  ADD COLUMN "tax_id"                VARCHAR(50),
  ADD COLUMN "business_type"         VARCHAR(50),
  ADD COLUMN "industry"              JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "support_email"         VARCHAR(200),
  ADD COLUMN "billing_email"         VARCHAR(200),
  ADD COLUMN "timezone"              VARCHAR(64),
  ADD COLUMN "currency"              VARCHAR(3) NOT NULL DEFAULT 'USD',
  ADD COLUMN "date_format"           VARCHAR(20) NOT NULL DEFAULT 'MM/DD/YYYY',
  ADD COLUMN "mailing_same_as_hq"    BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "mailing_address_line1" VARCHAR(200),
  ADD COLUMN "mailing_address_line2" VARCHAR(200),
  ADD COLUMN "mailing_city"          VARCHAR(100),
  ADD COLUMN "mailing_state"         VARCHAR(50),
  ADD COLUMN "mailing_postal_code"   VARCHAR(20),
  ADD COLUMN "mailing_country"       VARCHAR(2),
  ADD COLUMN "mfa_sms_enabled"       BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "mfa_email_enabled"     BOOLEAN NOT NULL DEFAULT false;

-- AlterTable: users — location assignment (source of the {{locationId}} data-scope token)
ALTER TABLE "users" ADD COLUMN "location_id" UUID;

-- CreateTable: locations (org-level branches)
CREATE TABLE "locations" (
  "id"              UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "name"            VARCHAR(120) NOT NULL,
  "code"            VARCHAR(20) NOT NULL,
  "address_line1"   VARCHAR(200),
  "address_line2"   VARCHAR(200),
  "city"            VARCHAR(100),
  "state"           VARCHAR(50),
  "postal_code"     VARCHAR(20),
  "country"         VARCHAR(2) DEFAULT 'US',
  "timezone"        VARCHAR(64),
  "phone"           VARCHAR(50),
  "manager_id"      UUID,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "locations_pkey" PRIMARY KEY ("id")
);

-- Indexes
CREATE UNIQUE INDEX "locations_organization_id_code_key" ON "locations"("organization_id", "code");
CREATE INDEX "locations_organization_id_idx" ON "locations"("organization_id");
CREATE INDEX "users_location_id_idx" ON "users"("location_id");

-- Foreign keys
ALTER TABLE "locations" ADD CONSTRAINT "locations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "locations" ADD CONSTRAINT "locations_manager_id_fkey"
  FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "users" ADD CONSTRAINT "users_location_id_fkey"
  FOREIGN KEY ("location_id") REFERENCES "locations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
