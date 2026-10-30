/**
 * invoiceDueCron.ts — daily invoice overdue / due-soon notification cron
 *
 * Finds all SENT/PARTIAL invoices with a due_date set and emits:
 *   - billing.invoice_overdue   when due_date < now
 *   - billing.invoice_due_soon  when due_date is within 3 days (inclusive)
 *
 * One notification per invoice per day (dedupKey = `${verb}:${id}:YYYY-MM-DD`).
 * Designed to be called by cron.schedule('0 6 * * *', …) in index.ts.
 *
 * Never throws — per-invoice errors are swallowed and logged; the loop continues.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { activeSwitchHolders } from '../../lib/permissions/switchHolders';
import { WHY_KEY } from './alertChain';
import { alertInvoice, INVOICE_PEOPLE_SELECT } from './invoiceBillingAlerts';

/** Add `days` days to a Date, returning a new Date. */
function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/** How many invoices are asked about in one read of "was this sent today already". */
const SENT_CHECK_BATCH = 500;

/**
 * Inspect all open invoices and emit overdue/due-soon notifications.
 * Pass `now` to override the current time (makes the function pure/testable).
 *
 * Each alert goes through M6's two lanes (S06.28): the invoice's job or lead people, whoever must act (its Dispatcher, else the
 * Access Billing holders who can open it, else the managers), and the copies. A sweep over hundreds of invoices must not repeat
 * the company-wide reads for each: the invoices come with their people in the one read above, what was sent today is asked in
 * one read per few hundred invoices, and the holders of a switch are read once per company for the whole run. What is left per
 * invoice is the chain's batched access checks and one write pair, a number of reads that does not grow with the company.
 */
export async function runInvoiceDueChecks(now: Date = new Date()): Promise<void> {
  const invoices = await prisma.invoice.findMany({
    where: {
      status: { in: ['SENT', 'PARTIAL'] },
      due_date: { not: null },
    },
    select: {
      id: true,
      invoice_number: true,
      due_date: true,
      organization_id: true,
      ...INVOICE_PEOPLE_SELECT,
    },
  });

  if (invoices.length === 0) return;

  // YYYY-MM-DD from `now` — used in every dedupKey this run
  const dateStr = now.toISOString().slice(0, 10);
  const horizon = addDays(now, 3);

  const due = invoices.flatMap((invoice) => {
    const when = invoice.due_date as Date; // guaranteed non-null by the where filter
    const verb = when < now ? 'billing.invoice_overdue' as const : when <= horizon ? 'billing.invoice_due_soon' as const : null;
    return verb ? [{ invoice, when, verb, dedupKey: `${verb}:${invoice.id}:${dateStr}` }] : [];
  });
  if (due.length === 0) return;

  // Which of today's alerts exist already (a second run the same day): the plain key and the one that carries the why line.
  const sentToday = new Set<string>();
  let checked = false;
  try {
    for (let i = 0; i < due.length; i += SENT_CHECK_BATCH) {
      const keys = due.slice(i, i + SENT_CHECK_BATCH).flatMap((d) => [d.dedupKey, d.dedupKey + WHY_KEY]);
      const rows = await prisma.notification.findMany({ where: { dedup_key: { in: keys } }, select: { dedup_key: true } });
      for (const row of rows) if (row.dedup_key) sentToday.add(row.dedup_key);
    }
    checked = true;
  } catch (err) {
    // Not knowing is not a reason to stay silent: each alert then checks for itself.
    logger.warn('[invoiceDueCron] could not read what was sent today', { error: err instanceof Error ? err.message : String(err) });
    sentToday.clear();
  }

  const holders = new Map<string, Promise<string[]>>();
  const holdersOf = (organizationId: string, switchKey: string) => {
    const key = `${organizationId}:${switchKey}`;
    let answer = holders.get(key);
    if (!answer) {
      answer = activeSwitchHolders(organizationId, switchKey);
      holders.set(key, answer);
    }
    return answer;
  };

  for (const { invoice, when, verb, dedupKey } of due) {
    try {
      if (sentToday.has(dedupKey) || sentToday.has(dedupKey + WHY_KEY)) continue;
      await alertInvoice({
        verb,
        organizationId: invoice.organization_id,
        actorId: null,
        object: { type: 'INVOICE', id: invoice.id, label: invoice.invoice_number },
        data: { object_label: invoice.invoice_number, due_date: when.toISOString() },
        dedupKey,
        known: invoice,
        dedupChecked: checked,
        holdersOf,
      });
    } catch (err) {
      logger.warn('[invoiceDueCron] failed to process invoice', {
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
