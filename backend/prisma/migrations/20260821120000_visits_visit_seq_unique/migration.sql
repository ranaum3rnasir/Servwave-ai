-- Multi-visit, section 4.4 of the QA run: the customer-facing visit number had no
-- uniqueness guarantee.
--
-- nextVisitSeqForJob is a bare `aggregate({_max: {visit_seq}})` with no lock and no
-- serializable isolation, so two concurrent POSTs to /api/jobs/:id/visits can read the
-- same max and both write seq N. That number ships in the customer's email subject
-- ("J00233 - Visit 2"), so a duplicate is two different trips the customer cannot tell
-- apart.
--
-- Bursts of 2, 3, 4 and 6 simultaneous creates on staging - 15 in all - each returned
-- distinct numbers, most likely because the single free-tier Render instance and Postgres
-- serialise transactions this short. That is luck, not a fix: the window widens on a
-- multi-instance production box.
--
-- NULLs compare distinct in a Postgres unique index, so each index constrains only the
-- rows that actually have that parent - a lead visit (job_id NULL) is untouched by the
-- job index and vice versa. That is exactly the split visits_exactly_one_parent already
-- enforces.
--
-- Verified 0 duplicate pairs on staging for BOTH axes before writing this. Prod has no
-- `visits` table yet (multi-visit is unpromoted), so this creates the index alongside the
-- table whenever that set lands.
--
-- IF NOT EXISTS on both: the shared staging DB may see a migration twice.

CREATE UNIQUE INDEX IF NOT EXISTS "visits_job_id_visit_seq_key"
  ON "visits" ("job_id", "visit_seq");

CREATE UNIQUE INDEX IF NOT EXISTS "visits_lead_id_visit_seq_key"
  ON "visits" ("lead_id", "visit_seq");
