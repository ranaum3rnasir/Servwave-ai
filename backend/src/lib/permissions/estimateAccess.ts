import type { Request } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { tenantWhere } from '../tenant';
import { scopeWhereForReq } from './enforce';

/** Which of these estimate ids the person can open. `db` is the client to ask on: pass the transaction's own inside one. */
export type EstimateOpener = (estimateIds: readonly string[], db?: Prisma.TransactionClient) => Promise<Set<string>>;

/**
 * The estimate twin of `invoiceOpenerFor` (invoiceAccess.ts): the person's estimate reach (their View estimates scope plus
 * and the documents they made for a customer alone), worked out once up front, and a function that asks which of some estimates it covers. One query per
 * call however many estimates are named, none for a person whose scope reaches every row, and nothing kept between
 * requests, so a person taken off a job stops opening its estimates on the next call.
 */
export async function estimateOpenerFor(req: Request): Promise<EstimateOpener> {
  const scope = await scopeWhereForReq(req, 'Estimate');
  const reachesEveryRow = Object.keys(scope).length === 0;
  return async (estimateIds, db = prisma) => {
    if (estimateIds.length === 0) return new Set();
    if (reachesEveryRow) return new Set(estimateIds);
    const rows = await db.estimate.findMany({
      where: { id: { in: [...estimateIds] }, ...tenantWhere(req), ...scope },
      select: { id: true },
    });
    return new Set(rows.map((r) => r.id));
  };
}
