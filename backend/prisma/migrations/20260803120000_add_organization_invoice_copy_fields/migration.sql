-- Invoice PDF template parity: invoice documents get their own Terms/Notes/Payment
-- Terms copy, separate from estimate_terms/estimate_notes/estimate_payment_terms (no
-- fallback between the two). Default '' so existing orgs render an invoice with these
-- sections omitted rather than a bare heading over empty text.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "invoice_terms" TEXT NOT NULL DEFAULT '';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "invoice_notes" TEXT NOT NULL DEFAULT '';
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "invoice_payment_terms" TEXT NOT NULL DEFAULT '';
