-- Unified date-anchored trigger family. One trigger per entity so the existing
-- entity-driven machinery (audiences, merge fields, stop-if, validation) is
-- untouched; the anchor + direction + offset live in trigger_config.
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'JOB_DATE_ANCHORED';
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'LEAD_DATE_ANCHORED';
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'INVOICE_DATE_ANCHORED';
ALTER TYPE "AutomationTriggerType" ADD VALUE IF NOT EXISTS 'ESTIMATE_DATE_ANCHORED';
