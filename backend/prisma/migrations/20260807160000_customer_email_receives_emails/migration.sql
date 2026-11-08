-- Per-address opt-in for the org's AUTOMATED customer mail.
--
-- Before this, the Automation Center's "customer" audience resolved to the scalar
-- customers.email only, so a walkthrough confirmation reached exactly one address
-- however many the customer had on file.
--
-- Default asymmetry is deliberate and is the whole point of the two statements below:
--   * ADD COLUMN ... DEFAULT false  -> every PRE-EXISTING row is backfilled opted OUT,
--     so no live org suddenly starts mailing an address nobody explicitly opted in.
--   * SET DEFAULT true              -> rows inserted from here on are opted IN, which
--     is what someone adding an email to a customer means by adding it.
-- Collapsing these into one statement would pick one behaviour and lose the other.
--
-- No RLS/policy work: customer_emails carries no organization_id and is reached only
-- through the (already tenant-scoped) parent customer, same as customer_phones.

ALTER TABLE "customer_emails"
  ADD COLUMN IF NOT EXISTS "receives_emails" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "customer_emails"
  ALTER COLUMN "receives_emails" SET DEFAULT true;
