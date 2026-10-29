-- Lead statuses are fixed (walkthrough lead-statuses PRD, D12). The per-org rename / reorder /
-- hide / default-status table is removed along with its settings page and API; every new lead
-- starts at NEW, which is the leads.status column's own default. No company ever used the table,
-- so nothing is lost.
--
-- IDEMPOTENT: IF EXISTS, so a second run (the shared staging DB may see a migration twice) is a
--   no-op.
-- PORTABLE: plain DROP TABLE. Dropping the table also drops its indexes, its foreign key and its
--   tenant_isolation policy, so nothing else needs cleaning up. The "LeadStatus" enum it used is
--   untouched.

DROP TABLE IF EXISTS "lead_status_overrides";
