import type { PrismaClient } from '@prisma/client';
import { carriersOfNumbers, type NumberCarrier } from '../comms-identity';

/**
 * #3021 (#3013 decision 4): which customers carrying a conversation's number a person reaches. The carriers themselves are the
 * identity module's (`carriersOfNumbers`, lib/comms-identity.ts), worked out at every read and never stored.
 */

type Where = Record<string, unknown>;

/**
 * The customers carrying each of these numbers (E.164) that the person can open, in the fixed order (`carriersOfNumbers`):
 * `customerScope` is their row scope on customers ({} for every customer). A customer they cannot open is never named to them
 * (re-audit P2-1; #3013 leaves who else may see such a name to #2950). Two queries however many numbers and customers: the
 * carriers, then, for a scope that does not reach every customer, which of them it reaches. A number none of them carries is
 * absent from the map.
 */
export async function carriersInReach(
  db: Pick<PrismaClient, '$queryRaw' | 'customer'>, organizationId: string, numbersE164: readonly string[], customerScope: Where,
): Promise<Map<string, NumberCarrier[]>> {
  const carriers = await carriersOfNumbers(db, organizationId, numbersE164);
  if (carriers.size === 0 || Object.keys(customerScope).length === 0) return carriers;
  const reached = await customersInReach(db, organizationId, [...carriers.values()].flatMap((list) => list.map((c) => c.id)), customerScope);
  const out = new Map<string, NumberCarrier[]>();
  for (const [number, list] of carriers) {
    const kept = list.filter((c) => reached.has(c.id));
    if (kept.length > 0) out.set(number, kept);
  }
  return out;
}

/**
 * Which of these customers of the company (ids the caller read from the company's own rows) the person can open,
 * `customerScope` being their row scope on customers ({} for every customer): one query, none when there is nothing to ask
 * or the scope reaches every customer.
 */
export async function customersInReach(
  db: Pick<PrismaClient, 'customer'>, organizationId: string, customerIds: readonly string[], customerScope: Where,
): Promise<Set<string>> {
  const ids = [...new Set(customerIds)];
  if (ids.length === 0 || Object.keys(customerScope).length === 0) return new Set(ids);
  return new Set((await db.customer.findMany({
    where: { AND: [{ id: { in: ids }, organization_id: organizationId }, customerScope] },
    select: { id: true },
  })).map((c) => c.id));
}

/** Which of these numbers (E.164) a customer the person reaches carries (#3013 decision 4): `carriersInReach`, as numbers. */
export async function numbersCarriedInReach(
  db: Pick<PrismaClient, '$queryRaw' | 'customer'>, organizationId: string, numbersE164: readonly string[], customerScope: Where,
): Promise<string[]> {
  return [...(await carriersInReach(db, organizationId, numbersE164, customerScope)).keys()];
}
