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
import { emit } from './notificationService';

/** Add `days` days to a Date, returning a new Date. */
function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

/**
 * Inspect all open invoices and emit overdue/due-soon notifications.
 * Pass `now` to override the current time (makes the function pure/testable).
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
      job: {
        select: {
          estimate: {
            select: {
              lead: {
                select: {
                  commission_owner_id: true,
                },
              },
            },
          },
        },
      },
    },
  });

  if (invoices.length === 0) return;

  // YYYY-MM-DD from `now` — used in every dedupKey this run
  const dateStr = now.toISOString().slice(0, 10);

  for (const invoice of invoices) {
    try {
      const due = invoice.due_date as Date; // guaranteed non-null by the where filter

      let verb: string | null = null;
      if (due < now) {
        verb = 'billing.invoice_overdue';
      } else if (due <= addDays(now, 3)) {
        verb = 'billing.invoice_due_soon';
      }

      if (!verb) continue;

      const commissionOwnerId =
        invoice.job?.estimate?.lead?.commission_owner_id ?? null;

      await emit({
        verb,
        organizationId: invoice.organization_id,
        actorId: null,
        object: {
          type: 'INVOICE',
          id: invoice.id,
          label: invoice.invoice_number,
        },
        entity: {
          customer_owner_id: commissionOwnerId,
        },
        data: {
          object_label: invoice.invoice_number,
          due_date: due.toISOString(),
        },
        dedupKey: `${verb}:${invoice.id}:${dateStr}`,
      });
    } catch (err) {
      logger.warn('[invoiceDueCron] failed to process invoice', {
        invoiceId: invoice.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
