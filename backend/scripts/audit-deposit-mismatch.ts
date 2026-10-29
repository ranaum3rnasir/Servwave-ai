/**
 * #2031 slice 1 — audit production for deposits that no longer reconcile.
 *
 * READ-ONLY. It writes nothing, anywhere. Run it against production to size the exposure behind
 * #2031 slice 5's policy decision (void versus re-price an unpaid superseded deposit invoice).
 *
 *   DATABASE_URL=<prod> DIRECT_URL=<prod> npx tsx scripts/audit-deposit-mismatch.ts
 *
 * The estimate Ran photographed — Total $0.00, "Deposit due now 50% — $1,190.20" — is real
 * production data and is unlikely to be the only one. A deposit is frozen in `send_config` at
 * first send; a later edit moves the total and nothing moves the deposit with it (deliberately —
 * "held, not silently recalculated" is Ran's own decision), so the two drift apart. What matters
 * is how much MONEY sits behind links a customer can still pay against a total that no longer
 * exists.
 *
 * MISMATCH is defined here the way `resolveDepositState` defines it (lib/deposit.ts): the held
 * figure no longer equals what the estimate's current inputs would produce. That keeps a FIXED
 * deposit valid when the total merely grows, and catches a percentage deposit the moment the
 * total moves.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const round2 = (n: number) => Math.round(n * 100) / 100;

/** The deposit the estimate's CURRENT inputs would produce. Mirrors resolveDeposit exactly. */
function expectedDeposit(
  estimate: { deposit_type: string | null; deposit_value: unknown; total_amount: unknown },
  org: { deposit_default_type: string | null; deposit_default_percentage: unknown; deposit_default_fixed_amount: unknown },
): number {
  const total = Number(estimate.total_amount ?? 0) || 0;
  const hasOverride = estimate.deposit_type != null && estimate.deposit_value != null;
  const type = hasOverride ? estimate.deposit_type : (org.deposit_default_type ?? 'PERCENTAGE');
  const raw = hasOverride
    ? Number(estimate.deposit_value)
    : type === 'FIXED'
      ? Number(org.deposit_default_fixed_amount ?? 0)
      : Number(org.deposit_default_percentage ?? 50);
  const value = Number.isNaN(raw) ? 0 : raw;
  return round2(type === 'FIXED' ? Math.min(value, total) : (total * value) / 100);
}

// #2031 slice 5 — "unpaid" is DRAFT or SENT, and nothing else. PARTIAL is deliberately absent:
// a deposit with money against it is untouchable under the re-price policy, so it is not part of
// the exposure this script sizes. (The third entry here used to read 'PARTIALLY_PAID', which is
// not a member of InvoiceStatus — it matched nothing, so the numbers were right by accident and
// the list read as though partly-paid deposits were being counted.)
const UNPAID_INVOICE_STATUSES = ['DRAFT', 'SENT'];

async function main() {
  const orgs = await prisma.organization.findMany({
    select: {
      id: true, name: true,
      deposit_default_type: true, deposit_default_percentage: true, deposit_default_fixed_amount: true,
    },
    orderBy: { name: 'asc' },
  });

  let grandUnpaid = 0;
  let grandMismatched = 0;

  for (const org of orgs) {
    // Only estimates that have actually been SENT carry a frozen deposit to disagree with.
    const estimates = await prisma.estimate.findMany({
      where: { organization_id: org.id, send_config: { isNot: null } },
      select: {
        id: true, estimate_number: true, status: true, total_amount: true,
        deposit_type: true, deposit_value: true, public_token: true,
        send_config: { select: { deposit_required: true, deposit_amount: true, deposit_percentage: true } },
        invoices: {
          where: { kind: 'DEPOSIT' },
          select: { id: true, status: true, amount_due: true, total_amount: true, public_token: true },
        },
      },
    });

    const mismatched: Array<{
      estimate_number: string;
      status: string;
      total: number;
      held: number;
      expected: number;
      invoiceStatus: string | null;
      amountDue: number;
      livePayableLink: boolean;
    }> = [];

    for (const estimate of estimates) {
      const invoice = estimate.invoices[0];
      const held = round2(
        Number(estimate.send_config?.deposit_amount ?? invoice?.total_amount ?? 0) || 0,
      );
      if (held <= 0) continue;

      const expected = expectedDeposit(estimate, org);
      if (held === expected) continue;

      const unpaid = invoice != null && UNPAID_INVOICE_STATUSES.includes(invoice.status);
      mismatched.push({
        estimate_number: estimate.estimate_number,
        status: estimate.status,
        total: round2(Number(estimate.total_amount ?? 0)),
        held,
        expected,
        invoiceStatus: invoice?.status ?? null,
        amountDue: round2(Number(invoice?.amount_due ?? 0)),
        // What actually costs money: an unpaid deposit invoice the customer can still open and pay.
        livePayableLink: unpaid && invoice?.public_token != null,
      });
    }

    const withInvoice = mismatched.filter((m) => m.invoiceStatus != null);
    const unpaidOnes = withInvoice.filter((m) => UNPAID_INVOICE_STATUSES.includes(m.invoiceStatus!));
    const behindLiveLinks = unpaidOnes.filter((m) => m.livePayableLink);
    const exposure = round2(behindLiveLinks.reduce((sum, m) => sum + m.amountDue, 0));

    grandMismatched += mismatched.length;
    grandUnpaid += exposure;

    console.log(`\n── ${org.name} (${org.id})`);
    console.log(`   sent estimates with a frozen deposit : ${estimates.length}`);
    console.log(`   deposits that no longer reconcile    : ${mismatched.length}`);
    console.log(`   …of those, with a deposit invoice    : ${withInvoice.length}`);
    console.log(`   …of those, unpaid                    : ${unpaidOnes.length}`);
    console.log(`   …of those, with a live payable link  : ${behindLiveLinks.length}`);
    console.log(`   money behind superseded links        : $${exposure.toFixed(2)}`);

    for (const row of mismatched) {
      console.log(
        `     ${row.estimate_number}  ${row.status.padEnd(9)}` +
        ` total $${row.total.toFixed(2)}  held $${row.held.toFixed(2)}  would be $${row.expected.toFixed(2)}` +
        `  invoice ${row.invoiceStatus ?? '—'}  due $${row.amountDue.toFixed(2)}` +
        `${row.livePayableLink ? '  ⚠ LIVE PAYABLE LINK' : ''}`,
      );
    }
  }

  console.log(`\n══ TOTAL: ${grandMismatched} mismatched deposit(s); $${grandUnpaid.toFixed(2)} behind live payable links.`);
  console.log('This script wrote nothing.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
