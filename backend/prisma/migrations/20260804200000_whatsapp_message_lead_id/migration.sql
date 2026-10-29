-- Communication visibility (email slice 8a): give WhatsAppMessage the same DIRECT
-- lead_id every other channel already carries, so all four channels scope on the
-- SAME two columns.
--
-- Before this, the four channels had THREE different anchor shapes:
--   emails        - job_id, lead_id, customer_id, vendor_id all direct
--   call_sessions - same, all direct
--   messages      - job_id + lead_id direct, customer_id on the parent thread
--   whatsapp_messages - job_id direct, NO lead_id at all, customer on the chat
-- A single shared visibility predicate cannot ride three shapes, and copying the
-- emails fragment onto whatsapp_messages would have matched NOTHING rather than
-- failing loudly. Mirroring messages.lead_id (added 2026-07-22, full job-parity
-- ruling) is the cheap fix while WhatsApp is still demo-only; it gets expensive
-- once the channel carries real rows.
--
-- ON DELETE SET NULL mirrors messages_lead_id_fkey exactly: deleting a lead must
-- never take the conversation history with it.
--
-- BACKFILL: whatsapp_chats.lead_id is the only lead linkage that exists today
-- (lib/job-communications.ts reads the chat, not the message), so every existing
-- message inherits its chat's lead. Guarded with `lead_id IS NULL` so a re-run
-- never overwrites an attribution corrected after the first apply.
--
-- IDEMPOTENT: ADD COLUMN IF NOT EXISTS / CREATE INDEX IF NOT EXISTS, the FK sits
--   behind a pg_constraint existence check, and the backfill is guarded as above.
-- PORTABLE: vanilla postgres:16 (CI migration-check) - no Supabase-only objects.

-- 1. The column.
ALTER TABLE "whatsapp_messages"
  ADD COLUMN IF NOT EXISTS "lead_id" UUID;

-- 2. Index, matching messages_lead_id_idx.
CREATE INDEX IF NOT EXISTS "whatsapp_messages_lead_id_idx" ON "whatsapp_messages"("lead_id");

-- 3. Foreign key.
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_messages_lead_id_fkey') THEN
    ALTER TABLE "whatsapp_messages"
      ADD CONSTRAINT "whatsapp_messages_lead_id_fkey"
      FOREIGN KEY ("lead_id") REFERENCES "leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- 4. Backfill from the parent chat's lead linkage.
UPDATE "whatsapp_messages" m
SET "lead_id" = c."lead_id"
FROM "whatsapp_chats" c
WHERE m."chat_id" = c."id"
  AND c."lead_id" IS NOT NULL
  AND m."lead_id" IS NULL;
