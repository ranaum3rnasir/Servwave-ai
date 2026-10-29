import * as fs from 'fs/promises';
import * as path from 'path';
import { Fixtures } from '../fixtures';

function assert(cond: any, msg: string): void {
  if (!cond) throw new Error(`Assertion failed: ${msg}`);
}

// Static analysis test — inspects source files to verify the Connect infrastructure
// seam is in place. No HTTP calls, no DB writes.
export async function run(_f: Fixtures, opts: { verbose: boolean }): Promise<number> {
  let count = 0;

  const srcRoot = path.resolve(__dirname, '../../../src');

  // ── lib/stripe.ts: single-seam Connect pattern ────────────────────────────
  const stripeLib = await fs.readFile(path.join(srcRoot, 'lib/stripe.ts'), 'utf8');

  assert(stripeLib.includes('export function getStripeForOrg'), 'getStripeForOrg is exported from lib/stripe.ts');
  count++;
  assert(stripeLib.includes('stripe_account_id'), 'lib/stripe.ts reads stripe_account_id (Connect seam)');
  count++;
  assert(stripeLib.includes('STRIPE_API_VERSION'), 'STRIPE_API_VERSION constant exported from lib/stripe.ts');
  count++;

  // No raw new Stripe() calls outside the private _platformStripe helper in lib/stripe.ts
  const newStripeMatches = (stripeLib.match(/new Stripe\(/g) ?? []).length;
  assert(newStripeMatches === 1, `exactly one new Stripe() call in lib/stripe.ts (got ${newStripeMatches})`);
  count++;

  // ── webhook.controller.ts: resolveOrgFromEvent + idempotency ─────────────
  const webhookCtrl = await fs.readFile(path.join(srcRoot, 'controllers/webhook.controller.ts'), 'utf8');

  assert(
    webhookCtrl.includes('export async function resolveOrgFromEvent'),
    'resolveOrgFromEvent is exported from webhook.controller.ts',
  );
  count++;
  assert(webhookCtrl.includes('DuplicateWebhookError'), 'DuplicateWebhookError class defined');
  count++;
  assert(webhookCtrl.includes("code === 'P2002'"), 'P2002 idempotency catch present in transactions');
  count++;
  assert(webhookCtrl.includes("case 'charge.refunded':"), 'charge.refunded handler case exists');
  count++;

  // ── schema.prisma: Organization.stripe_account_id ────────────────────────
  const schema = await fs.readFile(path.join(srcRoot, '../prisma/schema.prisma'), 'utf8');
  assert(schema.includes('stripe_account_id'), 'Organization.stripe_account_id field in schema.prisma');
  count++;

  if (opts.verbose) console.log(`  Connect seam invariants verified (${count} checks)`);
  return count;
}
