-- Drop the per-org custom sending domain (email slice 10).
--
-- Sending is in-house: every org sends from the one shared platform domain and
-- chooses only the local part (organizations.email_sender_local_part). The
-- guided custom-domain feature contradicted that decision - it did not merely
-- describe it wrongly, it worked - so the table goes with the code.
--
-- Safe to drop: staging holds 0 rows, and the table has never existed in prod,
-- so nothing is lost anywhere it exists. Any policy on it disappears with the
-- table, so no separate RLS teardown is needed.
--
-- IF EXISTS on both statements: the shared staging database may see this
-- migration twice, and prod will run it against a table that was never created.
DROP INDEX IF EXISTS "organization_domains_resend_domain_id_key";

DROP TABLE IF EXISTS "organization_domains";
