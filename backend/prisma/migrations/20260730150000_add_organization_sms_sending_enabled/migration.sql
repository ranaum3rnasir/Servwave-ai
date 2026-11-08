-- Org-wide toggle to disable outgoing SMS (automations + Communication module
-- sends) without touching CTM connection status or A2P approval. Mirrors
-- email_sending_enabled.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "sms_sending_enabled" BOOLEAN NOT NULL DEFAULT true;
