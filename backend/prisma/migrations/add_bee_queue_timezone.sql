-- Migration: Add customer timezone fields to bee_queue_items
ALTER TABLE bee_queue_items
  ADD COLUMN IF NOT EXISTS customer_timezone TEXT,
  ADD COLUMN IF NOT EXISTS timezone_source TEXT,
  ADD COLUMN IF NOT EXISTS is_timezone_estimated BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS bee_queue_items_timezone_idx ON bee_queue_items (organization_id, customer_timezone);

