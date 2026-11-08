-- Entity-redesign Phase 0 — _redesign_02_enum_values (UNAPPLIED)
-- Split from _redesign_01 per the PG rule: ALTER TYPE ... ADD VALUE cannot be
-- referenced in the same migration that adds it. No value is USED here (no backfill).

-- AlterEnum
ALTER TYPE "InvoiceStatus" ADD VALUE 'PARTIALLY_REFUNDED';
ALTER TYPE "InvoiceStatus" ADD VALUE 'DISPUTED';
