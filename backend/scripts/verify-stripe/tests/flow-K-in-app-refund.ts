import type { SuiteContext } from '../context';
import {
  assert, bookCardPayment, chargingOrgId, deleteSeeded, deliverAsAccount, label, paymentsOf, realEvents, removeFixtures, seedInvoice,
  sinceNow, staffSession, waitFor, withOrgSettings,
} from '../harness';
import { prisma } from '../../../src/lib/prisma';

// A refund made from ServWave (the staff Refund dialog's own door, POST /api/invoices/:id/refund),
// then the processor's real refund.created and charge.refunded events played back. The in-app row
// is completed in place, so each refund id ends as ONE Refund row, however many events and
// replays arrive, and the invoice's refunded total is the sum of the refunds.
export async function run(ctx: SuiteContext, opts: { verbose: boolean }): Promise<number> {
  let count = 0;
  const orgId = await chargingOrgId(ctx);
  const account = ctx.chargingAccount!;
  const staff = await staffSession(ctx);
  assert(staff.orgId === orgId, `the staff session belongs to the org that owns the charging account (${staff.orgId} vs ${orgId})`);
  return withOrgSettings(orgId, { stripe_charges_enabled: true, accepted_payment_methods: ['CARD', 'ACH'] }, async () => {
    const inv = await seedInvoice(orgId, { kind: 'STANDARD', totalCents: 20000, methods: ['CARD'] });
    try {
      const { events } = await bookCardPayment(ctx, inv, {}, 20000);
      await deliverAsAccount(events, account);
      const [payment] = await waitFor('the payment', async () => {
        const rows = await paymentsOf(inv.id);
        return rows.length > 0 ? rows : null;
      });
      assert(payment.state === 'SUCCEEDED', `the payment is booked (got ${payment.state})`);
      const intentId = payment.stripe_payment_intent_id!;
      count++;

      const refundOf = async (dollars: number) => {
        const since = sinceNow();
        const res = await fetch(`${ctx.apiUrl}/api/invoices/${inv.id}/refund`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${staff.token}` },
          body: JSON.stringify({ amount: dollars, payment_id: payment.id, reason_category: 'GOODWILL', reason: 'qa-39 verification refund' }),
        });
        assert(res.ok, `the refund door answered ${res.status}: ${await res.clone().text()}`);
        const created = await realEvents(ctx, { type: 'refund.created', since, match: (o) => o.payment_intent === intentId && o.amount === Math.round(dollars * 100) });
        const charge = await realEvents(ctx, { type: 'charge.refunded', since, match: (o) => o.payment_intent === intentId });
        await deliverAsAccount([...charge, ...created], account);
        // The same events again change nothing.
        await deliverAsAccount(created, account);
        return created[created.length - 1].data.object as unknown as { id: string };
      };

      const first = await refundOf(40);
      const rowsAfterFirst = await prisma.refund.findMany({ where: { invoice_id: inv.id } });
      assert(rowsAfterFirst.length === 1, `one Refund row after the first refund (got ${rowsAfterFirst.length})`);
      assert(rowsAfterFirst[0].stripe_refund_id === first.id && rowsAfterFirst[0].state === 'SUCCEEDED', `the row carries the processor's refund id and is SUCCEEDED (got ${rowsAfterFirst[0].stripe_refund_id} ${rowsAfterFirst[0].state})`);
      count++;

      const second = await refundOf(25);
      const rows = await prisma.refund.findMany({ where: { invoice_id: inv.id } });
      assert(rows.length === 2, `two refunds, two rows, no extra row from the events (got ${rows.length})`);
      for (const id of [first.id, second.id]) {
        assert(rows.filter((r) => r.stripe_refund_id === id).length === 1, `exactly one Refund row for ${id}`);
      }
      count++;
      const invoice = await prisma.invoice.findUniqueOrThrow({ where: { id: inv.id } });
      assert(Number(invoice.total_refunded) === 65, `the refunded total is the sum of the refunds, $65 (got ${invoice.total_refunded})`);
      count++;
      ctx.booked.push({ flow: 'flow-K', orgId, paymentId: payment.id, chargeId: payment.stripe_charge_id, intentId });
      if (opts.verbose) console.log(`  ${inv.number}: refunds ${first.id} and ${second.id}, one row each, $65 back`);
      return count;
    } finally {
      await removeFixtures(label(inv, orgId), () => deleteSeeded(orgId, inv));
    }
  });
}
