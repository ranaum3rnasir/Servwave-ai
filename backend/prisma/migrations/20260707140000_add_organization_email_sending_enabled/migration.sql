-- Org-wide toggle to disable outgoing business email (invoices, estimates, job
-- updates, etc.) without touching login/account-security email.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "email_sending_enabled" BOOLEAN NOT NULL DEFAULT true;
