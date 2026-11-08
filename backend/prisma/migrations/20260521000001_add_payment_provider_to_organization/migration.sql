-- §4.6: payment_provider on Organization
-- NONE   → public estimate/invoice pages render "Call our office at <phone>"
--          in place of the Stripe pay button. Stripe webhook handler
--          short-circuits to a 200 OK no-op so stray events don't bit-rot.
-- STRIPE → public pages render the existing Stripe checkout flow;
--          webhook handler processes events as before.
-- All existing rows default to NONE. To flip an org to STRIPE later,
-- gate it on the Stripe webhook setup tracked in issue #41 first.

-- CreateEnum
CREATE TYPE "PaymentProvider" AS ENUM ('NONE', 'STRIPE');

-- AlterTable
ALTER TABLE "organizations"
  ADD COLUMN "payment_provider" "PaymentProvider" NOT NULL DEFAULT 'NONE';
