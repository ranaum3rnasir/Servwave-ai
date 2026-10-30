-- Spider: the three stages it acts on (Ran, 15 Oct, D2): New, Contacted and Walkthrough Completed.
--
-- Walkthrough Scheduled and Estimate Sent are no longer watched, so their stored limits are removed
-- from every company's spider_settings.status_limits. Nothing else in the row changes; the other
-- three limits, the channels, the recipients and the switch stay as they are.
--
-- Data only, no schema change. Idempotent: a second run finds no row carrying either key.
-- Portable: plain jsonb operators, no Supabase roles.

UPDATE "spider_settings"
SET "status_limits" = "status_limits" - 'WALKTHROUGH_SCHEDULED' - 'ESTIMATED'
WHERE jsonb_typeof("status_limits") = 'object'
  AND ("status_limits" ? 'WALKTHROUGH_SCHEDULED' OR "status_limits" ? 'ESTIMATED');
