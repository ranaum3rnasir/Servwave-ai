-- Phase 3 cross-cutting fabric: widen the polymorphic enums so a Customer can be
-- attached/tagged and an Estimate/Invoice can be tagged.
--
-- NOTE: ALTER TYPE ... ADD VALUE cannot be used as a typed enum value inside the
-- same transaction that adds it (see 20260526102118_add_external_card... for the
-- split-migration precedent). This migration ONLY adds values and never references
-- them, so a single un-wrapped migration is correct. Do NOT add BEGIN/COMMIT.

-- AlterEnum
ALTER TYPE "AttachmentEntity" ADD VALUE 'CUSTOMER';

-- AlterEnum
ALTER TYPE "TagEntity" ADD VALUE 'CUSTOMER';
ALTER TYPE "TagEntity" ADD VALUE 'ESTIMATE';
ALTER TYPE "TagEntity" ADD VALUE 'INVOICE';
