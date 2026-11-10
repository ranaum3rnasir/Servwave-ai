-- #3015 (parent #3013, decision 1): a shared number picks one customer by a fixed order, answered by one query.
--
-- The pick (matchByPhone, lib/comms-identity.ts) finds every customer carrying the number and every lead or job carrying it
-- as its own. Three of those places had no index on the number:
--
--   customers_organization_id_secondary_phone_idx: a customer's second phone (the first phone has customers_phone_idx).
--   customer_phones_phone_idx: a customer's phone list, by number.
--   record_contact_entries_organization_id_kind_value_idx: a lead's or job's own phone value (kind 'PHONE').
--
-- Indexes only: no column, no data moved. IF NOT EXISTS so a second run is a no-op. No CONCURRENTLY: Prisma runs a
-- migration inside a transaction, where CONCURRENTLY cannot run.
-- Portable: no Supabase-only objects, no secrets.

CREATE INDEX IF NOT EXISTS "customers_organization_id_secondary_phone_idx"
  ON "customers" ("organization_id", "secondary_phone");

CREATE INDEX IF NOT EXISTS "customer_phones_phone_idx"
  ON "customer_phones" ("phone");

CREATE INDEX IF NOT EXISTS "record_contact_entries_organization_id_kind_value_idx"
  ON "record_contact_entries" ("organization_id", "kind", "value");
