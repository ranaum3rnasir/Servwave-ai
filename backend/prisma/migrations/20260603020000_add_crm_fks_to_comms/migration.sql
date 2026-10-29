-- AlterTable: add nullable CRM FKs to the comm mirror models (DEC6).
ALTER TABLE "call_sessions"  ADD COLUMN "lead_id" UUID,   ADD COLUMN "vendor_id" UUID;
ALTER TABLE "message_threads" ADD COLUMN "lead_id" UUID,  ADD COLUMN "vendor_id" UUID;
ALTER TABLE "whatsapp_chats"  ADD COLUMN "lead_id" UUID,  ADD COLUMN "vendor_id" UUID;
ALTER TABLE "emails" ADD COLUMN "customer_id" UUID, ADD COLUMN "lead_id" UUID, ADD COLUMN "vendor_id" UUID;

-- CreateIndex
CREATE INDEX "call_sessions_lead_id_idx"   ON "call_sessions"("lead_id");
CREATE INDEX "call_sessions_vendor_id_idx" ON "call_sessions"("vendor_id");
CREATE INDEX "message_threads_lead_id_idx"   ON "message_threads"("lead_id");
CREATE INDEX "message_threads_vendor_id_idx" ON "message_threads"("vendor_id");
CREATE INDEX "whatsapp_chats_lead_id_idx"   ON "whatsapp_chats"("lead_id");
CREATE INDEX "whatsapp_chats_vendor_id_idx" ON "whatsapp_chats"("vendor_id");
CREATE INDEX "emails_customer_id_idx" ON "emails"("customer_id");
CREATE INDEX "emails_lead_id_idx"     ON "emails"("lead_id");
CREATE INDEX "emails_vendor_id_idx"   ON "emails"("vendor_id");

-- AddForeignKey
ALTER TABLE "call_sessions"  ADD CONSTRAINT "call_sessions_lead_id_fkey"    FOREIGN KEY ("lead_id")   REFERENCES "leads"("id")   ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "call_sessions"  ADD CONSTRAINT "call_sessions_vendor_id_fkey"  FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_lead_id_fkey"   FOREIGN KEY ("lead_id")   REFERENCES "leads"("id")   ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "message_threads" ADD CONSTRAINT "message_threads_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "whatsapp_chats"  ADD CONSTRAINT "whatsapp_chats_lead_id_fkey"   FOREIGN KEY ("lead_id")   REFERENCES "leads"("id")   ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "whatsapp_chats"  ADD CONSTRAINT "whatsapp_chats_vendor_id_fkey" FOREIGN KEY ("vendor_id") REFERENCES "vendors"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "emails" ADD CONSTRAINT "emails_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "emails" ADD CONSTRAINT "emails_lead_id_fkey"     FOREIGN KEY ("lead_id")     REFERENCES "leads"("id")     ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "emails" ADD CONSTRAINT "emails_vendor_id_fkey"   FOREIGN KEY ("vendor_id")   REFERENCES "vendors"("id")   ON DELETE SET NULL ON UPDATE CASCADE;
