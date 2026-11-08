-- Migration: invoice_tip — one whole-invoice tip, untaxed (added after tax).
-- Idempotent: safe to apply more than once (shared staging DB).
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "tip" DECIMAL(12,2) NOT NULL DEFAULT 0;
