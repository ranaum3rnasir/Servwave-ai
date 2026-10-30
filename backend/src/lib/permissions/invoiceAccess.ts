import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { scopeWhereForReq } from './enforce';

/** Which of these invoice ids the person can open. `db` is the client to ask on: pass the transaction's own inside one. */
export type InvoiceOpener = (invoiceIds: readonly string[], db?: Prisma.TransactionClient) => Promise<Set<string>>;

/**
 * The person's invoice reach, worked out once, and a function that asks which of some invoices it covers.
 *
 * The reach (their View invoices scope) is read from the permission tables HERE, up front; the
 * returned function only asks the database about the named invoices, on the client it is given. That split is what lets a
 * caller that is inside an interactive transaction open the reach BEFORE the transaction and ask on the transaction's own
 * client: a query on the global client from inside a transaction needs a second pooled connection, and on a pool of one
 * (how the hosted database is configured) it waits for the very connection the transaction is holding and fails the
 * whole request.
 */
export async function invoiceOpenerFor(req: Request, opts: { checkOrg?: boolean } = {}): Promise<InvoiceOpener> {
  const scope = await scopeWhereForReq(req, 'Invoice');
  const reachesEveryRow = Object.keys(scope).length === 0;
  return async (invoiceIds, db = prisma) => {
    if (invoiceIds.length === 0) return new Set();
    // `checkOrg`: even a caller who reaches every invoice opens only this company's (defense in depth for a caller that
    // was handed ids from elsewhere). One query, asked only when the caller says so.
    if (reachesEveryRow && !opts.checkOrg) return new Set(invoiceIds);
    const rows = await db.invoice.findMany({
      where: { id: { in: [...invoiceIds] }, ...tenantWhere(req), ...scope },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  };
}

/**
 * Which of these invoices the signed-in person can open: the rows their View invoices scope reaches plus the ones
 * they made while attached to the job , asked with the same fragment the invoice list uses. A
 * person with View invoices off gets only the creator rows, often none, and never an error.
 *
 * One query per call, however many invoices are named, and none at all for a person whose scope reaches every row.
 * Asked on every request with nothing kept, so a person taken off a job stops opening its invoices on the next call.
 * Not for use inside a transaction: use `invoiceOpenerFor` before it opens (see there).
 */
export async function openableInvoiceIds(req: Request, invoiceIds: readonly string[]): Promise<Set<string>> {
  if (invoiceIds.length === 0) return new Set();
  return (await invoiceOpenerFor(req))(invoiceIds);
}
